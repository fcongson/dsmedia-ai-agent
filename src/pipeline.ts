import path from "node:path";
import fs from "fs-extra";
import { analyzeTranscript, type AnalysisResult } from "./analyze.js";
import { downloadVideo } from "./download.js";
import { expandPlaylist, type PlaylistEntry } from "./expand_playlist.js";
import { createIngestContext, resolveExecutable, type IngestContext } from "./runtime.js";
import { transcribeWithWhisper, tryDownloadSubtitles } from "./transcribe.js";
import { resolveLlmConfig } from "./config.js";
import { ensureOllamaReachable } from "./ollama.js";

export type IngestState = "DONE" | "PARTIAL" | "NEW";
export type ProgressLogger = (message: string) => void;
export type DependencyName = "yt-dlp" | "whisper" | "ollama";

export interface VideoArtifacts {
  audioExists: boolean;
  transcriptExists: boolean;
  analysisExists: boolean;
}

export interface VideoClassification {
  context: IngestContext;
  state: IngestState;
  artifacts: VideoArtifacts;
}

export interface IngestVideoResult {
  analysis: AnalysisResult;
  transcript: string;
  transcriptSource: "existing" | "subtitles" | "whisper";
  stateBeforeRun: IngestState;
  reusedExistingAnalysis: boolean;
}

export interface BatchVideoResult {
  url: string;
  id: string;
  title?: string;
  success: boolean;
  transcriptSource?: "existing" | "subtitles" | "whisper";
  stateBeforeRun: IngestState;
  error?: string;
}

export interface BatchIngestSummary {
  input: string;
  total: number;
  newCount: number;
  partialCount: number;
  doneCount: number;
  results: BatchVideoResult[];
}

async function assertAnalysisShape(value: unknown): Promise<AnalysisResult> {
  if (!value || typeof value !== "object") {
    throw new Error("Analysis JSON is not an object.");
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.source_url !== "string" ||
    typeof candidate.summary !== "string" ||
    !Array.isArray(candidate.tags) ||
    !Array.isArray(candidate.key_takeaways)
  ) {
    throw new Error("Analysis JSON does not match the expected schema.");
  }

  return candidate as unknown as AnalysisResult;
}

function noopLogger(): void {}

export async function ensureDependencies(required: DependencyName[], log: ProgressLogger = noopLogger): Promise<void> {
  if (required.length === 0) {
    return;
  }

  const dependencies = [...new Set(required)];
  log(`Checking dependencies: ${dependencies.join(", ")}`);

  if (dependencies.includes("yt-dlp")) {
    await resolveExecutable("yt-dlp");
  }

  if (dependencies.includes("whisper")) {
    await resolveExecutable("whisper");
  }

  if (dependencies.includes("ollama")) {
    const config = await resolveLlmConfig();
    await ensureOllamaReachable(config.baseUrl);
    log(`Using Ollama at ${config.baseUrl} with profile ${config.profile ?? "custom"}`);
  }
}

export async function getVideoArtifacts(context: IngestContext): Promise<VideoArtifacts> {
  const [audioExists, transcriptExists, analysisExists] = await Promise.all([
    fs.pathExists(context.audioPath),
    fs.pathExists(context.transcriptPath),
    fs.pathExists(context.analysisPath),
  ]);

  return { audioExists, transcriptExists, analysisExists };
}

export async function classifyVideo(url: string): Promise<VideoClassification> {
  const context = createIngestContext(url);
  const artifacts = await getVideoArtifacts(context);
  const state: IngestState = artifacts.analysisExists ? "DONE" : artifacts.audioExists || artifacts.transcriptExists ? "PARTIAL" : "NEW";
  return { context, state, artifacts };
}

async function readExistingAnalysis(context: IngestContext): Promise<AnalysisResult> {
  return assertAnalysisShape(await fs.readJson(context.analysisPath));
}

async function readTranscript(context: IngestContext): Promise<string> {
  const transcript = (await fs.readFile(context.transcriptPath, "utf8")).trim();
  if (!transcript) {
    throw new Error(`Transcript file is empty: ${context.transcriptPath}`);
  }
  return transcript;
}

export async function ingestVideo(url: string, log: ProgressLogger = noopLogger): Promise<IngestVideoResult> {
  const { context, state, artifacts } = await classifyVideo(url);
  log(`Video ${context.id}: state ${state}`);

  if (artifacts.analysisExists) {
    log(`Video ${context.id}: reusing existing analysis at ${context.analysisPath}`);
    return {
      analysis: await readExistingAnalysis(context),
      transcript: artifacts.transcriptExists ? await readTranscript(context) : "",
      transcriptSource: artifacts.transcriptExists ? "existing" : "whisper",
      stateBeforeRun: state,
      reusedExistingAnalysis: true,
    };
  }

  let transcriptSource: "existing" | "subtitles" | "whisper" = "existing";
  let transcript: string;

  if (artifacts.transcriptExists) {
    log(`Video ${context.id}: reusing existing transcript at ${context.transcriptPath}`);
    transcript = await readTranscript(context);
  } else {
    if (!artifacts.audioExists) {
      log(`Video ${context.id}: downloading audio`);
      await downloadVideo(context);
    }

    log(`Video ${context.id}: checking subtitles`);
    const subtitleTranscript = await tryDownloadSubtitles(context);
    if (subtitleTranscript) {
      transcript = subtitleTranscript;
      transcriptSource = "subtitles";
      log(`Video ${context.id}: using subtitles`);
    } else {
      log(`Video ${context.id}: transcribing audio with Whisper`);
      transcript = await transcribeWithWhisper(context);
      transcriptSource = "whisper";
    }
  }

  log(`Video ${context.id}: generating analysis with Ollama`);
  const analysis = await analyzeTranscript(context, transcript, undefined, log);
  log(`Video ${context.id}: wrote analysis to ${context.analysisPath}`);

  return {
    analysis,
    transcript,
    transcriptSource,
    stateBeforeRun: state,
    reusedExistingAnalysis: false,
  };
}

function isLikelyUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function looksLikePlaylistOrChannel(url: string): boolean {
  return /[?&]list=|\/@|\/c\/|\/channel\//u.test(url);
}

async function readBatchInput(input: string): Promise<string[]> {
  const resolvedPath = path.resolve(input);
  if (await fs.pathExists(resolvedPath)) {
    const content = await fs.readFile(resolvedPath, "utf8");
    return content
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  }

  return [input];
}

async function expandBatchUrls(input: string): Promise<PlaylistEntry[]> {
  const rawItems = await readBatchInput(input);
  const entries: PlaylistEntry[] = [];
  const seen = new Set<string>();

  for (const item of rawItems) {
    if (!isLikelyUrl(item)) {
      continue;
    }

    const expanded = looksLikePlaylistOrChannel(item)
      ? await expandPlaylist(item)
      : [{ id: createIngestContext(item).id, url: item, title: createIngestContext(item).id }];

    for (const entry of expanded) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        entries.push(entry);
      }
    }
  }

  if (entries.length === 0) {
    throw new Error("No valid video URLs were found in the batch input.");
  }

  return entries;
}

async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError ?? new Error("Retry attempts exhausted.");
}

export async function ingestBatch(input: string, log: ProgressLogger = noopLogger): Promise<BatchIngestSummary> {
  log(`Preparing batch input: ${input}`);
  const entries = await expandBatchUrls(input);
  const classifications = await Promise.all(entries.map((entry) => classifyVideo(entry.url)));

  let newCount = 0;
  let partialCount = 0;
  let doneCount = 0;

  for (const classification of classifications) {
    if (classification.state === "NEW") newCount += 1;
    if (classification.state === "PARTIAL") partialCount += 1;
    if (classification.state === "DONE") doneCount += 1;
  }

  const results: BatchVideoResult[] = [];
  log(`Batch contains ${entries.length} videos (${newCount} new, ${partialCount} partial, ${doneCount} already done)`);

  for (const [index, entry] of entries.entries()) {
    const initial = await classifyVideo(entry.url);
    try {
      log(`[${index + 1}/${entries.length}] ${entry.id}: starting`);
      const result = await retry(() => ingestVideo(entry.url, log), 2);
      results.push({
        url: entry.url,
        id: entry.id,
        title: entry.title,
        success: true,
        transcriptSource: result.transcriptSource,
        stateBeforeRun: initial.state,
      });
      log(`[${index + 1}/${entries.length}] ${entry.id}: complete`);
    } catch (error) {
      results.push({
        url: entry.url,
        id: entry.id,
        title: entry.title,
        success: false,
        stateBeforeRun: initial.state,
        error: (error as Error).message,
      });
      log(`[${index + 1}/${entries.length}] ${entry.id}: failed - ${(error as Error).message}`);
    }
  }

  return {
    input,
    total: entries.length,
    newCount,
    partialCount,
    doneCount,
    results,
  };
}
