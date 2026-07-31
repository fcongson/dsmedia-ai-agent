import { extractJsonBlock } from "./analyze.js";
import { resolveLlmConfig, type LlmConfig } from "./config.js";
import { ensureOllamaReachable, generateOllamaResponse, resolveOllamaModel } from "./ollama.js";
import type { SiteTaxonomy } from "./site.js";

type ProgressLogger = (message: string) => void;
function noopLogger(): void {}

export interface ClassificationInput {
  title: string | null;
  description: string | null;
  summary: string;
  keyTakeaways: string[];
  freeformTags: string[];
  existingTags: string[];
}

export interface ClassificationResult {
  series: string[];
  topics: string[];
  tools: string[];
  systems: string[];
  /** Freeform leftovers: model-proposed tags plus any closed-list guesses
   * that didn't actually match a taxonomy entry (never silently dropped). */
  tags: string[];
  droppedValues: string[];
}

// Hard caps on how many values may be picked per field. These exist for two
// reasons: they match how these facets are actually meant to be used (a
// talk is not "about" 50 topics), and - empirically, observed against a
// real llama3.1:8b run - an 8B model given a ~60-item list will sometimes
// degrade into echoing most of the list back verbatim instead of actually
// selecting. The prompt states the caps explicitly; validateTaxonomyResponse
// enforces them regardless of what the model does.
export const MAX_SELECTIONS: Record<"series" | "topics" | "tools" | "systems", number> = {
  series: 2,
  topics: 5,
  tools: 4,
  systems: 3,
};

function formatList(label: string, values: readonly string[], max: number): string {
  return `${label} (choose AT MOST ${max}, zero is fine, ONLY exact matches from this list):\n${values.map((value) => `- ${value}`).join("\n")}`;
}

export function buildTaxonomyPrompt(input: ClassificationInput, taxonomy: SiteTaxonomy): string {
  const context = [
    input.title ? `Title: ${input.title}` : null,
    input.summary ? `Summary: ${input.summary}` : null,
    input.keyTakeaways.length > 0 ? `Key takeaways:\n${input.keyTakeaways.map((t) => `- ${t}`).join("\n")}` : null,
    input.freeformTags.length > 0 ? `Loosely-related freeform tags from an earlier pass: ${input.freeformTags.join(", ")}` : null,
    input.description ? `Description excerpt: ${input.description.slice(0, 1500)}` : null,
  ].filter(Boolean).join("\n\n");

  return `You are tagging a video for a design-systems content site against a CLOSED taxonomy. Be selective: pick only what this SPECIFIC video is genuinely centrally about, not everything it loosely touches. Most videos deserve 1-3 topics, not 5. If you're unsure whether something is central, leave it out. You must only pick values that appear verbatim in the lists below - do not invent new values, do not rephrase, do not pluralize/singularize a listed value, and do not just copy the list back.

Video context:
${context}

${formatList("Series (the recurring show/conference this episode belongs to)", taxonomy.series, MAX_SELECTIONS.series)}

${formatList("Topics (subject matter that is genuinely central to this video)", taxonomy.topics, MAX_SELECTIONS.topics)}

${formatList("Tools (named products/plugins actually discussed at some length, not name-dropped once)", taxonomy.tools, MAX_SELECTIONS.tools)}

${formatList("Systems (named design-system products like Spectrum, Polaris, Carbon - not companies in general)", taxonomy.systems, MAX_SELECTIONS.systems)}

Also propose "tags": at most 5 short freeform labels (Title Case, 1-3 words each) for anything genuinely important to this video's subject matter that does NOT fit any of the closed lists above. Do not duplicate a value that fits a closed list into tags as well.

Return ONLY valid JSON, no markdown fences, no commentary:
{
  "series": ["string"],
  "topics": ["string"],
  "tools": ["string"],
  "systems": ["string"],
  "tags": ["string"]
}`;
}

interface RawTaxonomyResponse {
  series: unknown;
  topics: unknown;
  tools: unknown;
  systems: unknown;
  tags: unknown;
}

function isRawTaxonomyResponse(value: unknown): value is RawTaxonomyResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.series) &&
    Array.isArray(candidate.topics) &&
    Array.isArray(candidate.tools) &&
    Array.isArray(candidate.systems) &&
    Array.isArray(candidate.tags)
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

export function parseTaxonomyResponse(rawResponse: string): {
  series: string[];
  topics: string[];
  tools: string[];
  systems: string[];
  tags: string[];
} {
  const extracted = extractJsonBlock(rawResponse);
  if (!extracted) {
    throw new Error("Model returned an empty response.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted) as unknown;
  } catch (error) {
    throw new Error(`Model returned invalid JSON (${extracted.length} chars): ${(error as Error).message}`);
  }

  if (!isRawTaxonomyResponse(parsed)) {
    throw new Error("Generated JSON does not match the expected taxonomy-classification schema.");
  }

  return {
    series: toStringArray(parsed.series),
    topics: toStringArray(parsed.topics),
    tools: toStringArray(parsed.tools),
    systems: toStringArray(parsed.systems),
    tags: toStringArray(parsed.tags),
  };
}

function matchClosedList(candidates: string[], allowed: readonly string[]): { matched: string[]; unmatched: string[] } {
  const allowedByLower = new Map(allowed.map((value) => [value.toLowerCase(), value]));
  const matched: string[] = [];
  const unmatched: string[] = [];

  for (const candidate of candidates) {
    const canonical = allowedByLower.get(candidate.toLowerCase());
    if (canonical) {
      if (!matched.includes(canonical)) {
        matched.push(canonical);
      }
    } else {
      unmatched.push(candidate);
    }
  }

  return { matched, unmatched };
}

/** Cross-checks the model's raw picks against the actual closed lists (the
 * model is instructed to only use listed values, but 8B-class local models
 * occasionally drift - this is the enforcement layer ADR 0012 calls for).
 * Anything that doesn't match falls through to `tags` rather than being
 * silently discarded. */
export function validateTaxonomyResponse(
  raw: { series: string[]; topics: string[]; tools: string[]; systems: string[]; tags: string[] },
  taxonomy: SiteTaxonomy,
): ClassificationResult {
  const series = matchClosedList(raw.series, taxonomy.series);
  const topics = matchClosedList(raw.topics, taxonomy.topics);
  const tools = matchClosedList(raw.tools, taxonomy.tools);
  const systems = matchClosedList(raw.systems, taxonomy.systems);

  const droppedValues = [...series.unmatched, ...topics.unmatched, ...tools.unmatched, ...systems.unmatched];

  const tagSeen = new Set<string>();
  const tags: string[] = [];
  for (const value of [...raw.tags, ...droppedValues]) {
    const key = value.trim().toLowerCase();
    if (!key || tagSeen.has(key)) continue;
    tagSeen.add(key);
    tags.push(value.trim());
  }

  return {
    series: series.matched,
    topics: topics.matched,
    tools: tools.matched,
    systems: systems.matched,
    tags,
    droppedValues,
  };
}

/** Detects the "the model just echoed most of the candidate list back"
 * failure mode instead of trusting the prompt's caps to always hold. Seen in
 * practice on llama3.1:8b: one field can come back with dozens of matches
 * that are all technically valid closed-list values (so validateTaxonomyResponse's
 * unmatched-value check doesn't catch it) while being obviously not a real
 * selection for one video. Returns the field names that blew their cap. */
export function findOverCapFields(result: ClassificationResult): string[] {
  const overCap: string[] = [];
  (Object.keys(MAX_SELECTIONS) as Array<keyof typeof MAX_SELECTIONS>).forEach((field) => {
    if (result[field].length > MAX_SELECTIONS[field]) {
      overCap.push(field);
    }
  });
  return overCap;
}

export async function classifyAgainstTaxonomy(
  input: ClassificationInput,
  taxonomy: SiteTaxonomy,
  overrides?: Partial<LlmConfig>,
  log: ProgressLogger = noopLogger,
): Promise<ClassificationResult> {
  const config = await resolveLlmConfig({ overrides });
  await ensureOllamaReachable(config.baseUrl);
  const model = await resolveOllamaModel(config);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      log(`Classifying against taxonomy, attempt ${attempt}/3 (model ${model})`);
      const rawResponse = await generateOllamaResponse(config, model, buildTaxonomyPrompt(input, taxonomy));
      const parsed = parseTaxonomyResponse(rawResponse);
      const result = validateTaxonomyResponse(parsed, taxonomy);

      const overCapFields = findOverCapFields(result);
      if (overCapFields.length > 0) {
        const detail = overCapFields
          .map((field) => {
            const key = field as keyof typeof MAX_SELECTIONS;
            return `${field} (${result[key].length}/${MAX_SELECTIONS[key]} max)`;
          })
          .join(", ");
        throw new Error(`Model over-selected (looks like list-echoing, not real classification) on: ${detail}`);
      }

      return result;
    } catch (error) {
      lastError = error as Error;
      log(`Taxonomy classification attempt ${attempt}/3 failed: ${lastError.message}`);
    }
  }

  throw new Error(`Failed to classify against taxonomy after 3 attempts: ${lastError?.message ?? "Unknown error"}`);
}

// --- Speaker name proposal ---------------------------------------------
//
// Only a handful of entries are ever missing `speakers` (3 of 828 media
// entries at the time this was written), so this deliberately does NOT
// stuff the full ~577-name known-speakers list into a per-video prompt -
// that's a lot of tokens to spend on an 8B local model for a rarely-hit
// path, and it invites hallucinated "closest name" guesses. Instead the
// model proposes a name from title/description text alone, and that
// proposal is fuzzy-matched against the known list in plain code. A
// confident match reuses the existing canonical spelling; anything else is
// surfaced for manual review rather than written into a controlled field.

export interface SpeakerProposalInput {
  title: string | null;
  description: string | null;
}

export function buildSpeakerPrompt(input: SpeakerProposalInput): string {
  return `Based on the title and description below, who is the featured guest or speaker in this video? Only answer if the text names a specific person with reasonable confidence (e.g. "with Jane Doe", "Jane Doe:", "featuring Jane Doe"). If you can't tell, return an empty array.

Title: ${input.title ?? "(unknown)"}
Description: ${(input.description ?? "").slice(0, 1000)}

Return ONLY valid JSON, no markdown fences, no commentary:
{ "speakers": ["Full Name"] }`;
}

interface RawSpeakerResponse {
  speakers: unknown;
}

export function parseSpeakerResponse(rawResponse: string): string[] {
  const extracted = extractJsonBlock(rawResponse);
  if (!extracted) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted) as unknown;
  } catch {
    return [];
  }

  const candidate = parsed as RawSpeakerResponse;
  return toStringArray(candidate?.speakers);
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\s]/gu, "").replace(/\s+/gu, " ");
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

export interface SpeakerMatch {
  candidate: string;
  match: string | null;
  distance: number;
}

/** Exact (case/punctuation-insensitive) match wins outright. Otherwise a
 * small edit distance relative to name length counts as "confident enough"
 * to reuse the canonical spelling; anything looser is left unmatched. */
export function matchKnownSpeaker(candidate: string, knownSpeakers: string[]): SpeakerMatch {
  const normalizedCandidate = normalizeName(candidate);

  for (const known of knownSpeakers) {
    if (normalizeName(known) === normalizedCandidate) {
      return { candidate, match: known, distance: 0 };
    }
  }

  let best: { known: string; distance: number } | null = null;
  for (const known of knownSpeakers) {
    const distance = levenshteinDistance(normalizedCandidate, normalizeName(known));
    if (!best || distance < best.distance) {
      best = { known, distance };
    }
  }

  const threshold = Math.max(1, Math.floor(normalizedCandidate.length * 0.15));
  if (best && best.distance <= threshold) {
    return { candidate, match: best.known, distance: best.distance };
  }

  return { candidate, match: null, distance: best?.distance ?? Infinity };
}

export interface SpeakerProposalResult {
  matched: string[];
  unmatched: string[];
}

export async function proposeSpeakers(
  input: SpeakerProposalInput,
  knownSpeakers: string[],
  overrides?: Partial<LlmConfig>,
  log: ProgressLogger = noopLogger,
): Promise<SpeakerProposalResult> {
  const config = await resolveLlmConfig({ overrides });
  await ensureOllamaReachable(config.baseUrl);
  const model = await resolveOllamaModel(config);

  log(`Proposing speaker name (model ${model})`);
  const rawResponse = await generateOllamaResponse(config, model, buildSpeakerPrompt(input));
  const candidates = parseSpeakerResponse(rawResponse);

  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const candidate of candidates) {
    const result = matchKnownSpeaker(candidate, knownSpeakers);
    if (result.match) {
      matched.push(result.match);
    } else {
      unmatched.push(candidate);
    }
  }

  return { matched, unmatched };
}
