import fetch from "node-fetch";
import { DEFAULT_LLM_PROFILES, resolveConfiguredModel, type LlmConfig } from "./config.js";

const FALLBACK_MODELS = [
  DEFAULT_LLM_PROFILES.balanced.model,
  DEFAULT_LLM_PROFILES.fast.model,
  DEFAULT_LLM_PROFILES.quality.model,
  "llama3.1:8b",
  "qwen3:8b",
  "qwen2.5:14b",
  "llama3",
] as const;

async function fetchJson<T>(url: string, init?: Parameters<typeof fetch>[1]): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body.trim() ? ` - ${body.trim()}` : "";
    throw new Error(`HTTP ${response.status} from ${url}${detail}`);
  }
  return (await response.json()) as T;
}

export async function ensureOllamaReachable(baseUrl: string): Promise<void> {
  try {
    await fetchJson<{ models: Array<{ name: string }> }>(`${baseUrl}/api/tags`);
  } catch (error) {
    throw new Error(`Ollama is not reachable at ${baseUrl}: ${(error as Error).message}`);
  }
}

export async function listOllamaModelNames(baseUrl: string): Promise<string[]> {
  const tags = await fetchJson<{ models: Array<{ name: string; model?: string }> }>(`${baseUrl}/api/tags`);
  const seen = new Set<string>();

  for (const model of tags.models) {
    const name = model.name || model.model;
    if (name) {
      seen.add(name);
    }
  }

  return [...seen];
}

function findCompatibleModel(target: string, available: string[]): string | undefined {
  return available.find((name) => name === target || name.startsWith(`${target}:`));
}

/** Chat models and embedding models are different model types in Ollama -
 * asking a chat model for /api/embeddings fails because Ollama never loads
 * its runner in embedding mode for them, so (unlike resolveOllamaModel)
 * there's no sensible fallback list to try. Just check the configured
 * embedding model is actually installed and say so clearly if not. */
export async function resolveOllamaEmbeddingModel(config: LlmConfig): Promise<string> {
  const available = await listOllamaModelNames(config.baseUrl);
  const match = findCompatibleModel(config.embeddingModel, available);
  if (!match) {
    throw new Error(
      `Embedding model "${config.embeddingModel}" is not installed in Ollama. Run \`ollama pull ${config.embeddingModel}\` and try again.`,
    );
  }

  return match;
}

export async function resolveOllamaModel(config: LlmConfig): Promise<string> {
  const available = await listOllamaModelNames(config.baseUrl);
  if (available.length === 0) {
    throw new Error("No Ollama models are available.");
  }

  const configuredModel = resolveConfiguredModel(config);
  if (configuredModel) {
    const exactConfigured = findCompatibleModel(configuredModel, available);
    if (exactConfigured) {
      return exactConfigured;
    }

    if (config.model) {
      throw new Error(`Configured Ollama model is not available: ${config.model}`);
    }
  }

  for (const candidate of FALLBACK_MODELS) {
    const match = findCompatibleModel(candidate, available);
    if (match) {
      return match;
    }
  }

  return available[0];
}

export async function generateOllamaEmbedding(config: LlmConfig, model: string, text: string): Promise<number[]> {
  let response: { embedding: number[] };
  try {
    response = await fetchJson<{ embedding: number[] }>(`${config.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, prompt: text }),
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/does not support embeddings/iu.test(message)) {
      // Ollama only loads its runner in embedding mode for models it
      // recognizes as embedding models - calling this on a chat/completion
      // model fails even though the model itself is installed and working.
      throw new Error(`Model "${model}" is not an embedding model (${message}). Use an embedding model, e.g. nomic-embed-text.`);
    }
    throw error;
  }

  if (!Array.isArray(response.embedding) || response.embedding.length === 0) {
    throw new Error(`Ollama returned an empty embedding for model ${model}.`);
  }

  return response.embedding;
}

export async function generateOllamaResponse(config: LlmConfig, model: string, prompt: string): Promise<string> {
  const response = await fetchJson<{ response: string }>(`${config.baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: config.temperature,
        num_ctx: config.numCtx,
      },
      format: config.structuredOutput ? "json" : undefined,
    }),
  });

  return response.response;
}
