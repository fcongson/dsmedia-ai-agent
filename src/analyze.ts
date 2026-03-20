import path from "node:path";
import fs from "fs-extra";
import fetch from "node-fetch";
import { ANALYSIS_DIR, type IngestContext } from "./runtime.js";

const OLLAMA_URL = "http://localhost:11434";

interface ModelAnalysis {
  summary: string;
  tags: string[];
  key_takeaways: string[];
}

export interface AnalysisResult extends ModelAnalysis {
  id: string;
  source_url: string;
}

function buildPrompt(transcript: string): string {
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

Transcript:
${transcript}`;
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

async function fetchJson<T>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }
  return (await response.json()) as T;
}

export async function ensureOllamaReachable(): Promise<void> {
  try {
    await fetchJson<{ models: Array<{ name: string }> }>(`${OLLAMA_URL}/api/tags`);
  } catch (error) {
    throw new Error(`Ollama is not reachable at ${OLLAMA_URL}: ${(error as Error).message}`);
  }
}

async function resolveModelName(): Promise<string> {
  const tags = await fetchJson<{ models: Array<{ name: string; model?: string }> }>(`${OLLAMA_URL}/api/tags`);
  const modelNames = tags.models.map((model) => model.name || model.model).filter(Boolean) as string[];
  if (modelNames.length === 0) {
    throw new Error("No Ollama models are available.");
  }

  const preferred = modelNames.find((name) => name === "llama3" || name.startsWith("llama3:"));
  return preferred ?? modelNames[0];
}

function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

async function generateAnalysis(model: string, transcript: string): Promise<ModelAnalysis> {
  const response = await fetchJson<{ response: string }>(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt: buildPrompt(transcript),
      stream: false,
    }),
  });

  const parsed = JSON.parse(extractJsonBlock(response.response)) as unknown;
  if (!isModelAnalysis(parsed)) {
    throw new Error("Generated JSON does not match required schema.");
  }

  return {
    summary: parsed.summary,
    tags: parsed.tags,
    key_takeaways: parsed.key_takeaways,
  };
}

export async function analyzeTranscript(context: IngestContext, transcript: string): Promise<AnalysisResult> {
  await fs.ensureDir(ANALYSIS_DIR);
  await ensureOllamaReachable();

  const model = await resolveModelName();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const modelAnalysis = await generateAnalysis(model, transcript);
      const analysis: AnalysisResult = {
        id: context.id,
        source_url: context.sourceUrl,
        ...modelAnalysis,
      };
      await fs.writeJson(context.analysisPath, analysis, { spaces: 2 });
      return analysis;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw new Error(`Failed to generate valid JSON after 3 attempts: ${lastError?.message ?? "Unknown error"}`);
}
