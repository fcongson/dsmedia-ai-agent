import { createHash } from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import { resolveLlmConfig, type LlmConfig } from "./config.js";
import {
  ensureOllamaReachable as ensureOllamaReachableDefault,
  generateOllamaEmbedding as generateOllamaEmbeddingDefault,
  generateOllamaResponse as generateOllamaResponseDefault,
  resolveOllamaEmbeddingModel as resolveOllamaEmbeddingModelDefault,
  resolveOllamaModel as resolveOllamaModelDefault,
} from "./ollama.js";
import { getDataDirs } from "./runtime.js";
import { assertSitePath, resolveSitePath, SITE_BASE_URL } from "./site.js";
import { scanSiteContent, type ContentKind, type SiteEntry } from "./site-content.js";

export type ProgressLogger = (message: string) => void;
function noopLogger(): void {}

export interface SearchCorpusEntry {
  id: string;
  sourceUrl: string;
  title: string | null;
  summary: string;
  tags: string[];
  keyTakeaways: string[];
}

export interface SearchMatch extends SearchCorpusEntry {
  score: number;
}

export interface FindContentResult {
  query: string;
  matches: SearchMatch[];
  answer: string;
}

// The network/model calls are injectable so the retrieval and ranking logic
// can be tested without a running Ollama (see search.test.ts) - the same
// pattern retag.ts uses for its ingest/classify collaborators.
export interface FindContentDependencies {
  ensureReachable: typeof ensureOllamaReachableDefault;
  resolveModel: typeof resolveOllamaModelDefault;
  resolveEmbeddingModel: typeof resolveOllamaEmbeddingModelDefault;
  embed: typeof generateOllamaEmbeddingDefault;
  generateAnswer: typeof generateOllamaResponseDefault;
}

const DEFAULT_DEPENDENCIES: FindContentDependencies = {
  ensureReachable: ensureOllamaReachableDefault,
  resolveModel: resolveOllamaModelDefault,
  resolveEmbeddingModel: resolveOllamaEmbeddingModelDefault,
  embed: generateOllamaEmbeddingDefault,
  generateAnswer: generateOllamaResponseDefault,
};

export interface FindContentOptions {
  limit?: number;
  overrides?: Partial<LlmConfig>;
  log?: ProgressLogger;
  /** Override points for tests; default to the real data/ subdirectories. */
  analysisDir?: string;
  metadataDir?: string;
  embeddingsDir?: string;
  /** Absolute path to the designsystems.media checkout, for the site
   * frontmatter fallback source below. Defaults like the other site-aware
   * operations (classify_taxonomy, retag_site_media): a sibling checkout,
   * or DSMEDIA_SITE_DIR. If the site isn't actually there, the fallback is
   * silently skipped rather than failing the whole search. */
  sitePath?: string;
  dependencies?: Partial<FindContentDependencies>;
}

interface RawAnalysisRecord {
  id: string;
  source_url: string;
  summary: string;
  tags: string[];
  key_takeaways: string[];
}

function isRawAnalysisRecord(value: unknown): value is RawAnalysisRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.source_url === "string" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.tags) &&
    Array.isArray(candidate.key_takeaways)
  );
}

async function readTitle(metadataDir: string, id: string): Promise<string | null> {
  const metadataPath = path.join(metadataDir, `${id}.json`);
  if (!(await fs.pathExists(metadataPath))) {
    return null;
  }

  const metadata = await fs.readJson(metadataPath).catch(() => null);
  return metadata && typeof metadata.title === "string" ? metadata.title : null;
}

/** Scans every cached analysis artifact into a flat, searchable corpus.
 * Skips files that don't match the expected shape rather than throwing, so
 * one corrupted or stale artifact can't take the whole tool down. */
export async function loadSearchCorpus(options: { analysisDir?: string; metadataDir?: string } = {}): Promise<SearchCorpusEntry[]> {
  const dataDirs = getDataDirs();
  const analysisDir = options.analysisDir ?? dataDirs.ANALYSIS_DIR;
  const metadataDir = options.metadataDir ?? dataDirs.METADATA_DIR;

  if (!(await fs.pathExists(analysisDir))) {
    return [];
  }

  const files = (await fs.readdir(analysisDir)).filter((file) => file.endsWith(".json")).sort();
  const entries: SearchCorpusEntry[] = [];

  for (const file of files) {
    const raw = await fs.readJson(path.join(analysisDir, file)).catch(() => null);
    if (!isRawAnalysisRecord(raw)) {
      continue;
    }

    entries.push({
      id: raw.id,
      sourceUrl: raw.source_url,
      title: await readTitle(metadataDir, raw.id),
      summary: raw.summary,
      tags: raw.tags,
      keyTakeaways: raw.key_takeaways,
    });
  }

  return entries;
}

function siteEntryUrl(kind: ContentKind, slug: string): string {
  return `${SITE_BASE_URL}${kind === "media" ? "/video/" : "/podcast/"}${slug}/`;
}

function siteEntryToCorpusEntry(kind: ContentKind, entry: SiteEntry): SearchCorpusEntry {
  return {
    id: `${kind}:${entry.slug}`,
    sourceUrl: siteEntryUrl(kind, entry.slug),
    title: entry.title,
    summary: entry.bodyExcerpt,
    tags: [...entry.existingTags, ...entry.series, ...entry.topics, ...entry.tools, ...entry.systems, ...entry.speakers],
    keyTakeaways: [],
  };
}

/** Site entries that already went through analyse_transcript are covered
 * by loadSearchCorpus - this only adds entries data/analysis doesn't have
 * yet, sourced straight from designsystems.media's own frontmatter
 * (title, tags, closed-taxonomy values, body text). Most media entries
 * are already tagged from the retagging pass, so this is a cheap way to
 * make nearly the whole site findable without re-running ingest on
 * everything. Degrades to an empty array - never throws - if the sibling
 * site checkout isn't present, since find_content shouldn't hard-fail for
 * users who don't have it. */
export async function loadSiteFallbackEntries(
  analysisCorpus: SearchCorpusEntry[],
  options: { sitePath?: string } = {},
): Promise<SearchCorpusEntry[]> {
  let sitePath: string;
  try {
    sitePath = resolveSitePath({ override: options.sitePath });
    await assertSitePath(sitePath);
  } catch {
    return [];
  }

  const covered = new Set(analysisCorpus.map((entry) => entry.sourceUrl.toLowerCase()));
  const fallback: SearchCorpusEntry[] = [];

  for (const kind of ["media", "podcast"] as const) {
    const entries = await scanSiteContent(sitePath, kind).catch(() => [] as SiteEntry[]);
    for (const entry of entries) {
      if (entry.videoUrl && covered.has(entry.videoUrl.toLowerCase())) {
        continue;
      }

      fallback.push(siteEntryToCorpusEntry(kind, entry));
    }
  }

  return fallback;
}

export function embeddingText(entry: SearchCorpusEntry): string {
  return [entry.title, entry.summary, entry.tags.join(", "), entry.keyTakeaways.join(". ")].filter(Boolean).join("\n");
}

function hashEmbeddingInput(model: string, text: string): string {
  return createHash("sha256").update(`${model}\n${text}`).digest("hex");
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface EmbeddingCacheRecord {
  hash: string;
  vector: number[];
}

// Corpus entry ids are usually a bare YouTube id, but site-fallback entries
// (below) are built from Astro content slugs, and a handful of those
// contain literal "/" characters (e.g. an episode titled "... w/ So-and-so"
// became a nested directory) - sanitize before using one as a filename.
function cacheFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9_.-]/gu, "_")}.json`;
}

async function loadCachedEmbedding(embeddingsDir: string, id: string): Promise<EmbeddingCacheRecord | null> {
  const cachePath = path.join(embeddingsDir, cacheFileName(id));
  if (!(await fs.pathExists(cachePath))) {
    return null;
  }

  return (await fs.readJson(cachePath).catch(() => null)) as EmbeddingCacheRecord | null;
}

async function saveCachedEmbedding(embeddingsDir: string, id: string, record: EmbeddingCacheRecord): Promise<void> {
  await fs.ensureDir(embeddingsDir);
  await fs.writeJson(path.join(embeddingsDir, cacheFileName(id)), record, { spaces: 2 });
}

/** Embeds each corpus entry, reusing a cached vector whenever the entry's
 * own text and the embedding model are unchanged since the last run - an
 * unchanged library otherwise means re-embedding the whole corpus on every
 * search. */
async function embedCorpus(
  config: LlmConfig,
  embeddingModel: string,
  corpus: SearchCorpusEntry[],
  embeddingsDir: string,
  embed: FindContentDependencies["embed"],
  log: ProgressLogger,
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();

  for (const entry of corpus) {
    const text = embeddingText(entry);
    const hash = hashEmbeddingInput(embeddingModel, text);
    const cached = await loadCachedEmbedding(embeddingsDir, entry.id);
    if (cached && cached.hash === hash) {
      vectors.set(entry.id, cached.vector);
      continue;
    }

    log(`Embedding ${entry.id}`);
    const vector = await embed(config, embeddingModel, text);
    await saveCachedEmbedding(embeddingsDir, entry.id, { hash, vector });
    vectors.set(entry.id, vector);
  }

  return vectors;
}

export function buildAnswerPrompt(query: string, matches: SearchMatch[]): string {
  const context = matches
    .map((match, index) => {
      const lines = [`${index + 1}. ${match.title ?? match.id}`, `   URL: ${match.sourceUrl}`];
      if (match.summary.trim()) {
        lines.push(`   Summary: ${match.summary}`);
      }
      if (match.tags.length > 0) {
        lines.push(`   Tags: ${match.tags.join(", ")}`);
      }
      if (match.keyTakeaways.length > 0) {
        lines.push(`   Key takeaways: ${match.keyTakeaways.join("; ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `A user is looking for design-systems video content. Their request:
"${query}"

Here are the most relevant videos found in the library, ranked by relevance:

${context}

Write a short, conversational response (3-6 sentences) recommending which of these videos best match what the user is looking for and why, referencing them by title. Mention the video URL for your top pick or two. If none of them are a strong fit, say so plainly instead of forcing a recommendation. Do not invent videos that aren't listed above.`;
}

async function synthesizeAnswer(
  config: LlmConfig,
  model: string,
  query: string,
  matches: SearchMatch[],
  generateAnswer: FindContentDependencies["generateAnswer"],
): Promise<string> {
  if (matches.length === 0 || matches.every((match) => match.score <= 0)) {
    return "No sufficiently relevant videos were found in the analyzed library for that request.";
  }

  const response = await generateAnswer({ ...config, structuredOutput: false }, model, buildAnswerPrompt(query, matches));
  return response.trim();
}

/** Searches already-analyzed videos (data/analysis), plus - as a fallback
 * for anything not yet analyzed - designsystems.media's own tagged
 * frontmatter, for content relevant to a natural-language request. Embeds
 * the corpus (with caching) and the query with a dedicated Ollama
 * embedding model, ranks by cosine similarity, then asks the chat model
 * for a short conversational recommendation grounded in the top matches. */
export async function findContent(query: string, options: FindContentOptions = {}): Promise<FindContentResult> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    throw new Error("A search query is required.");
  }

  const log = options.log ?? noopLogger;
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : 5;
  const deps: FindContentDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
  const dataDirs = getDataDirs();
  const embeddingsDir = options.embeddingsDir ?? dataDirs.EMBEDDINGS_DIR;

  const analysisCorpus = await loadSearchCorpus({ analysisDir: options.analysisDir, metadataDir: options.metadataDir });
  const siteFallback = await loadSiteFallbackEntries(analysisCorpus, { sitePath: options.sitePath });
  if (siteFallback.length > 0) {
    log(`Added ${siteFallback.length} entries from designsystems.media's own frontmatter (not yet in data/analysis)`);
  }
  const corpus = [...analysisCorpus, ...siteFallback];

  if (corpus.length === 0) {
    return {
      query: trimmedQuery,
      matches: [],
      answer: "No analyzed videos are available yet. Run the ingest pipeline on some videos first.",
    };
  }

  const config = await resolveLlmConfig({ overrides: options.overrides });
  await deps.ensureReachable(config.baseUrl);
  const model = await deps.resolveModel(config);
  const embeddingModel = await deps.resolveEmbeddingModel(config);

  log(`Embedding ${corpus.length} corpus entries (embedding model ${embeddingModel})`);
  const vectors = await embedCorpus(config, embeddingModel, corpus, embeddingsDir, deps.embed, log);

  log("Embedding query");
  const queryVector = await deps.embed(config, embeddingModel, trimmedQuery);

  const matches: SearchMatch[] = corpus
    .map((entry) => ({ ...entry, score: cosineSimilarity(queryVector, vectors.get(entry.id) ?? []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  log(`Synthesizing answer from top ${matches.length} matches`);
  const answer = await synthesizeAnswer(config, model, trimmedQuery, matches, deps.generateAnswer);

  return { query: trimmedQuery, matches, answer };
}
