import { execa } from "execa";
import fs from "fs-extra";
import { analyzeTranscript, ANALYSIS_FILE, ensureOllamaReachable } from "./analyze.js";
import { AUDIO_FILE, downloadVideo } from "./download.js";
import { resolveExecutable } from "./runtime.js";
import { TRANSCRIPT_FILE, transcribeAudio } from "./transcribe.js";

interface CliAnalysis {
  summary: string;
  tags: string[];
  key_takeaways: string[];
}

function validateUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("Usage: npx tsx src/ingest.ts <youtube-url>");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Provided value is not a valid URL.");
  }

  if (!["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(parsed.hostname)) {
    throw new Error("Provided URL must be a YouTube URL.");
  }

  return value;
}

async function ensureCommandAvailable(command: string): Promise<void> {
  try {
    await resolveExecutable(command);
  } catch (error) {
    throw new Error(`Required command is not available: ${command}. ${(error as Error).message}`);
  }
}

function assertAnalysisShape(value: unknown): asserts value is CliAnalysis {
  if (!value || typeof value !== "object") {
    throw new Error("Analysis JSON is not an object.");
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== "string") {
    throw new Error("Analysis JSON is missing a string summary.");
  }

  if (!Array.isArray(candidate.tags)) {
    throw new Error("Analysis JSON is missing a tags array.");
  }

  if (!Array.isArray(candidate.key_takeaways)) {
    throw new Error("Analysis JSON is missing a key_takeaways array.");
  }
}

async function validateOutputs(): Promise<void> {
  for (const output of [AUDIO_FILE, TRANSCRIPT_FILE, ANALYSIS_FILE]) {
    if (!(await fs.pathExists(output))) {
      throw new Error(`Required output file is missing: ${output}`);
    }
  }

  const analysis = await fs.readJson(ANALYSIS_FILE);
  assertAnalysisShape(analysis);
}

async function run(): Promise<void> {
  const url = validateUrl(process.argv[2]);

  await ensureCommandAvailable("yt-dlp");
  await ensureCommandAvailable("whisper");
  await ensureOllamaReachable();

  await downloadVideo(url);
  const transcript = await transcribeAudio(url);
  await analyzeTranscript(transcript);
  await validateOutputs();
}

run().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
