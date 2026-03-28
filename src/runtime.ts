import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

const LOCAL_VENV_BIN = path.resolve(".venv/bin");

// Resolve data dirs relative to this file's location (src/), not process.cwd()
// This ensures paths work correctly regardless of what cwd the MCP client sets.
export const ROOT_DIR = path.resolve(fileURLToPath(import.meta.url), "..", "..");

export function getDataDirs() {
  return {
    AUDIO_DIR: path.join(ROOT_DIR, "data", "audio"),
    TRANSCRIPTS_DIR: path.join(ROOT_DIR, "data", "transcripts"),
    ANALYSIS_DIR: path.join(ROOT_DIR, "data", "analysis"),
  };
}

export interface IngestContext {
  id: string;
  sourceUrl: string;
  audioPath: string;
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

  const { AUDIO_DIR, TRANSCRIPTS_DIR, ANALYSIS_DIR } = getDataDirs();

  return {
    id,
    sourceUrl,
    audioPath: path.resolve(AUDIO_DIR, `${id}.mp3`),
    transcriptPath: path.resolve(TRANSCRIPTS_DIR, `${id}.txt`),
    analysisPath: path.resolve(ANALYSIS_DIR, `${id}.json`),
    transcriptDir: TRANSCRIPTS_DIR,
    subtitleStem: path.join(ROOT_DIR, "data", "transcripts", id),
  };
}
