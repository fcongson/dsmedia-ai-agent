import path from "node:path";
import fs from "fs-extra";
import { ROOT_DIR } from "./runtime.js";

export type LlmProvider = "ollama";
export type LlmProfileName = "balanced" | "fast" | "quality";

export interface LlmProfile {
  model: string;
  description: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string;
  model?: string;
  profile?: LlmProfileName;
  temperature: number;
  numCtx?: number;
  structuredOutput: boolean;
}

export interface ProjectConfig {
  llm?: Partial<LlmConfig>;
}

export interface ResolveLlmConfigOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<LlmConfig>;
  projectConfig?: ProjectConfig;
}

export const DEFAULT_LLM_PROFILES: Record<LlmProfileName, LlmProfile> = {
  balanced: {
    model: "llama3.1:8b",
    description: "Verified local default for this repo on a 16 GB Apple Silicon machine.",
  },
  fast: {
    model: "gemma3:4b",
    description: "Smaller and faster local model for quicker turnaround. Not yet validated locally in this repo.",
  },
  quality: {
    model: "qwen3:8b",
    description: "Heavier local model for stronger summaries and extraction quality. Not yet validated locally in this repo.",
  },
};

const DEFAULT_CONFIG: LlmConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434",
  profile: "balanced",
  temperature: 0.2,
  structuredOutput: true,
};

function mergeDefined<T extends object>(...values: Array<Partial<T> | undefined>): Partial<T> {
  const merged: Partial<T> = {};

  for (const value of values) {
    if (!value) {
      continue;
    }

    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        (merged as Record<string, unknown>)[key] = entry;
      }
    }
  }

  return merged;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getEnvConfig(env: NodeJS.ProcessEnv): Partial<LlmConfig> {
  const provider = env.DSMEDIA_LLM_PROVIDER;
  const profile = env.DSMEDIA_LLM_PROFILE;

  return {
    provider: provider === "ollama" ? provider : undefined,
    baseUrl: env.DSMEDIA_LLM_BASE_URL,
    model: env.DSMEDIA_LLM_MODEL,
    profile: profile && profile in DEFAULT_LLM_PROFILES ? (profile as LlmProfileName) : undefined,
    temperature: parseNumber(env.DSMEDIA_LLM_TEMPERATURE),
    numCtx: parseNumber(env.DSMEDIA_LLM_NUM_CTX),
    structuredOutput: parseBoolean(env.DSMEDIA_LLM_STRUCTURED_OUTPUT),
  };
}

export async function loadProjectConfig(rootDir = ROOT_DIR): Promise<ProjectConfig> {
  const configPath = path.join(rootDir, "dsmedia.config.json");
  if (!(await fs.pathExists(configPath))) {
    return {};
  }

  return (await fs.readJson(configPath)) as ProjectConfig;
}

export async function resolveLlmConfig(options: ResolveLlmConfigOptions = {}): Promise<LlmConfig> {
  const rootDir = options.rootDir ?? ROOT_DIR;
  const projectConfig = options.projectConfig ?? (await loadProjectConfig(rootDir));
  const envConfig = getEnvConfig(options.env ?? process.env);

  const merged = mergeDefined<LlmConfig>(DEFAULT_CONFIG, projectConfig.llm, envConfig, options.overrides) as LlmConfig;

  if (merged.profile && !(merged.profile in DEFAULT_LLM_PROFILES)) {
    throw new Error(`Unknown LLM profile: ${merged.profile}`);
  }

  return merged;
}

export function resolveConfiguredModel(config: LlmConfig): string | undefined {
  if (config.model) {
    return config.model;
  }

  if (config.profile) {
    return DEFAULT_LLM_PROFILES[config.profile].model;
  }

  return undefined;
}
