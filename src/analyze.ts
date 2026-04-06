import fs from "fs-extra";
import { ensureDescription } from "./description.js";
import { getDataDirs, type IngestContext } from "./runtime.js";
import { resolveLlmConfig, type LlmConfig } from "./config.js";
import { ensureOllamaReachable, generateOllamaResponse, resolveOllamaModel } from "./ollama.js";

type ProgressLogger = (message: string) => void;

export interface ModelAnalysis {
  summary: string;
  tags: string[];
  key_takeaways: string[];
}

export interface AnalysisResult extends ModelAnalysis {
  id: string;
  source_url: string;
  description: string | null;
}

function noopLogger(): void {}

function buildPrompt(transcript: string, label = "Transcript"): string {
  return `Return ONLY valid JSON:

{
  "summary": "string",
  "tags": ["string"],
  "key_takeaways": ["string"]
}

Rules:
- No explanation
- No markdown
- tags must be array
- key_takeaways must be array

${label}:
${transcript}`;
}

function buildChunkSummaryPrompt(chunk: string, index: number, total: number): string {
  return `Summarize this transcript chunk as compact plain text notes for a later final synthesis.

Rules:
- No markdown fences
- Keep it under 8 short bullet lines
- Include important names, products, claims, and decisions
- Do not add commentary outside the notes

Chunk ${index} of ${total}:
${chunk}`;
}

function isModelAnalysis(value: unknown): value is ModelAnalysis {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.tags) &&
    Array.isArray(candidate.key_takeaways)
  );
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function parseModelAnalysis(rawResponse: string): ModelAnalysis {
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

  if (!isModelAnalysis(parsed)) {
    throw new Error("Generated JSON does not match required schema.");
  }

  return {
    summary: parsed.summary,
    tags: parsed.tags,
    key_takeaways: parsed.key_takeaways,
  };
}

function estimateDirectTranscriptLimit(config: LlmConfig): number {
  const configuredCtx = config.numCtx ?? 8192;
  const estimated = Math.floor((configuredCtx * 2.5) - 2000);
  return Math.min(12000, Math.max(6000, estimated));
}

function splitTranscriptIntoChunks(transcript: string, maxChars: number): string[] {
  const sections = transcript
    .split(/\n{2,}/u)
    .map((section) => section.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const pushSection = (section: string) => {
    if (section.length <= maxChars) {
      if (!current) {
        current = section;
        return;
      }

      const candidate = `${current}\n\n${section}`;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        chunks.push(current);
        current = section;
      }
      return;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    for (let start = 0; start < section.length; start += maxChars) {
      chunks.push(section.slice(start, start + maxChars));
    }
  };

  for (const section of sections.length > 0 ? sections : [transcript]) {
    pushSection(section);
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function summarizeLongTranscript(
  config: LlmConfig,
  model: string,
  transcript: string,
  log: ProgressLogger,
): Promise<{ content: string; label: string }> {
  const maxChars = estimateDirectTranscriptLimit(config);
  if (transcript.length <= maxChars) {
    return { content: transcript, label: "Transcript" };
  }

  const chunks = splitTranscriptIntoChunks(transcript, maxChars);
  log(`Transcript is ${transcript.length} chars; summarizing ${chunks.length} chunks before final analysis`);

  const chunkSummaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    log(`Summarizing transcript chunk ${index + 1}/${chunks.length}`);
    const summary = (await generateOllamaResponse(
      { ...config, structuredOutput: false, temperature: Math.min(config.temperature, 0.2) },
      model,
      buildChunkSummaryPrompt(chunk, index + 1, chunks.length),
    )).trim();

    if (!summary) {
      throw new Error(`Model returned an empty summary for chunk ${index + 1}.`);
    }

    chunkSummaries.push(`Chunk ${index + 1} notes:\n${summary}`);
  }

  return {
    content: chunkSummaries.join("\n\n"),
    label: "Synthesized transcript notes",
  };
}

async function generateAnalysis(
  config: LlmConfig,
  model: string,
  transcript: string,
  log: ProgressLogger,
): Promise<ModelAnalysis> {
  const prepared = await summarizeLongTranscript(config, model, transcript, log);
  const rawResponse = await generateOllamaResponse(config, model, buildPrompt(prepared.content, prepared.label));
  return parseModelAnalysis(rawResponse);
}

export async function analyzeTranscript(
  context: IngestContext,
  transcript: string,
  overrides?: Partial<LlmConfig>,
  log: ProgressLogger = noopLogger,
): Promise<AnalysisResult> {
  const { ANALYSIS_DIR } = getDataDirs();
  await fs.ensureDir(ANALYSIS_DIR);
  const config = await resolveLlmConfig({ overrides });
  await ensureOllamaReachable(config.baseUrl);

  const model = await resolveOllamaModel(config);
  log(`Analysis model: ${model} (${transcript.length} transcript chars)`);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      log(`Generating analysis attempt ${attempt}/3`);
      const modelAnalysis = await generateAnalysis(config, model, transcript, log);
      const analysis: AnalysisResult = {
        id: context.id,
        source_url: context.sourceUrl,
        description: await ensureDescription(context),
        ...modelAnalysis,
      };
      await fs.writeJson(context.analysisPath, analysis, { spaces: 2 });
      return analysis;
    } catch (error) {
      lastError = error as Error;
      log(`Analysis attempt ${attempt}/3 failed: ${lastError.message}`);
    }
  }

  throw new Error(`Failed to generate valid JSON after 3 attempts: ${lastError?.message ?? "Unknown error"}`);
}
