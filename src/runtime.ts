import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa, type Options } from "execa";
import fs from "fs-extra";

const LOCAL_VENV_BIN = path.resolve(".venv/bin");

// Resolve data dirs relative to this file's location (src/), not process.cwd()
// This ensures paths work correctly regardless of what cwd the MCP client sets.
export const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..");

export function getDataDirs() {
  return {
    AUDIO_DIR: path.join(ROOT_DIR, "data", "audio"),
    DESCRIPTIONS_DIR: path.join(ROOT_DIR, "data", "descriptions"),
    METADATA_DIR: path.join(ROOT_DIR, "data", "metadata"),
    NOTES_DIR: path.join(ROOT_DIR, "data", "notes"),
    TRANSCRIPTS_DIR: path.join(ROOT_DIR, "data", "transcripts"),
    ANALYSIS_DIR: path.join(ROOT_DIR, "data", "analysis"),
    EMBEDDINGS_DIR: path.join(ROOT_DIR, "data", "embeddings"),
  };
}

export interface IngestContext {
  id: string;
  sourceUrl: string;
  audioPath: string;
  descriptionPath: string;
  metadataPath: string;
  notePath: string;
  transcriptPath: string;
  analysisPath: string;
  transcriptDir: string;
  subtitleStem: string;
}

export async function resolveExecutable(command: string): Promise<string> {
  const pathValue = process.env.PATH ?? "";
  const candidates = pathValue.split(path.delimiter).filter(Boolean);
  candidates.push(LOCAL_VENV_BIN);

  for (const directory of candidates) {
    const executablePath = path.join(directory, command);
    if (await fs.pathExists(executablePath)) {
      return executablePath;
    }
  }

  throw new Error(`Required command is not available: ${command}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// YouTube throttles/blocks callers that fire requests back-to-back, and a single
// ingest can shell out to yt-dlp several times (metadata, description, subtitles,
// audio). These two knobs keep every yt-dlp invocation in the process on one
// politeness budget: a minimum gap between any two calls, and flags that make
// yt-dlp itself pace requests within a single invocation (e.g. playlist expansion).
const YT_DLP_MIN_GAP_MS = Number(process.env.DSMEDIA_YTDLP_MIN_GAP_MS ?? 2000);
const YT_DLP_POLITE_ARGS = ["--sleep-requests", "1", "--sleep-interval", "3", "--max-sleep-interval", "8"];

const BLOCKED_PATTERNS = [
  "sign in to confirm",
  "confirm you're not a bot",
  "http error 429",
  "429 too many requests",
  "too many requests",
];

export function isYtDlpBlocked(text: string | undefined | null): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return BLOCKED_PATTERNS.some((pattern) => normalized.includes(pattern));
}

let lastYtDlpCallAt = 0;
let ytDlpQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs yt-dlp with a shared politeness budget: calls are serialized (so
 * concurrent operations never hit YouTube at the same instant) and spaced at
 * least DSMEDIA_YTDLP_MIN_GAP_MS apart. `url` is appended last so it can't be
 * mistaken for a flag value by any args passed in.
 */
export function runYtDlp<OptionsType extends Options = {}>(args: string[], url: string, options?: OptionsType) {
  const run = async () => {
    const ytDlp = await resolveExecutable("yt-dlp");
    const wait = YT_DLP_MIN_GAP_MS - (Date.now() - lastYtDlpCallAt);
    if (wait > 0) {
      await sleep(wait);
    }
    try {
      return await execa(ytDlp, [...YT_DLP_POLITE_ARGS, ...args, url], options);
    } finally {
      lastYtDlpCallAt = Date.now();
    }
  };

  const scheduled = ytDlpQueue.then(run, run);
  ytDlpQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

function extractVideoId(url: URL): string | null {
  if (url.hostname === "youtu.be") {
    const id = url.pathname.replace(/^\/+/u, "").split("/")[0];
    return id || null;
  }

  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
    if (url.pathname === "/watch") {
      return url.searchParams.get("v");
    }

    if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
      const [, , id] = url.pathname.split("/");
      return id || null;
    }
  }

  return null;
}

export function createIngestContext(sourceUrl: string): IngestContext {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new Error("Provided value is not a valid URL.");
  }

  if (!["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(parsed.hostname)) {
    throw new Error("Provided URL must be a YouTube URL.");
  }

  const id = extractVideoId(parsed);
  if (!id) {
    throw new Error("Unable to determine YouTube video ID from URL.");
  }

  const { AUDIO_DIR, DESCRIPTIONS_DIR, METADATA_DIR, NOTES_DIR, TRANSCRIPTS_DIR, ANALYSIS_DIR } = getDataDirs();

  return {
    id,
    sourceUrl,
    audioPath: path.resolve(AUDIO_DIR, `${id}.mp3`),
    descriptionPath: path.resolve(DESCRIPTIONS_DIR, `${id}.txt`),
    metadataPath: path.resolve(METADATA_DIR, `${id}.json`),
    notePath: path.resolve(NOTES_DIR, `${id}.md`),
    transcriptPath: path.resolve(TRANSCRIPTS_DIR, `${id}.txt`),
    analysisPath: path.resolve(ANALYSIS_DIR, `${id}.json`),
    transcriptDir: TRANSCRIPTS_DIR,
    subtitleStem: path.join(ROOT_DIR, "data", "transcripts", id),
  };
}
