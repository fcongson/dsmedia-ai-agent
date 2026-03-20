import fs from "fs-extra";
import { analyzeTranscript, ensureOllamaReachable } from "./analyze.js";
import { downloadVideo } from "./download.js";
import { createIngestContext, resolveExecutable } from "./runtime.js";
import { transcribeAudio } from "./transcribe.js";

interface CliAnalysis {
  id: string;
  source_url: string;
  summary: string;
  tags: string[];
  key_takeaways: string[];
}

function validateUrl(value: string | undefined): string {
  if (!value) {
    throw new Error("Usage: npx tsx src/ingest.ts <youtube-url>");
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
  if (typeof candidate.id !== "string") {
    throw new Error("Analysis JSON is missing a string id.");
  }

  if (typeof candidate.source_url !== "string") {
    throw new Error("Analysis JSON is missing a string source_url.");
  }

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

async function validateOutputs(context: ReturnType<typeof createIngestContext>): Promise<void> {
  for (const output of [context.audioPath, context.transcriptPath, context.analysisPath]) {
    if (!(await fs.pathExists(output))) {
      throw new Error(`Required output file is missing: ${output}`);
    }
  }

  const analysis = await fs.readJson(context.analysisPath);
  assertAnalysisShape(analysis);
  if (analysis.id !== context.id) {
    throw new Error("Analysis JSON id does not match ingest context.");
  }
  if (analysis.source_url !== context.sourceUrl) {
    throw new Error("Analysis JSON source_url does not match ingest context.");
  }
}

async function run(): Promise<void> {
  const url = validateUrl(process.argv[2]);
  const context = createIngestContext(url);

  await ensureCommandAvailable("yt-dlp");
  await ensureCommandAvailable("whisper");
  await ensureOllamaReachable();

  await downloadVideo(context);
  const transcript = await transcribeAudio(context);
  await analyzeTranscript(context, transcript);
  await validateOutputs(context);
}

run().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
