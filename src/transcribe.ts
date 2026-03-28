import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { getDataDirs, type IngestContext, resolveExecutable } from "./runtime.js";

function stripMarkup(line: string): string {
  return line
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]+\}/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function isTimestampLine(line: string): boolean {
  return /-->/u.test(line) || /^\d{2}:\d{2}(?::\d{2})?\.\d{3}$/u.test(line);
}

function isCueIndex(line: string): boolean {
  return /^\d+$/u.test(line.trim());
}

function normalizeVttToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/u);
  const result: string[] = [];
  let lastLine = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "WEBVTT" || line.startsWith("Kind:") || line.startsWith("Language:")) {
      continue;
    }

    if (isTimestampLine(line) || isCueIndex(line) || line.startsWith("NOTE")) {
      continue;
    }

    const cleaned = stripMarkup(line);
    if (!cleaned || cleaned === lastLine) {
      continue;
    }

    result.push(cleaned);
    lastLine = cleaned;
  }

  return result.join("\n").trim();
}

async function listSubtitleFiles(context: IngestContext): Promise<string[]> {
  const files = await fs.readdir(context.transcriptDir);
  return files
    .filter((file) => file.startsWith(`${context.id}.`) && file.endsWith(".vtt"))
    .map((file) => path.join(context.transcriptDir, file))
    .sort();
}

function subtitlePreferenceScore(filePath: string, videoId: string): number {
  const fileName = path.basename(filePath);
  const preferences = [
    `${videoId}.en.vtt`,
    `${videoId}.en-US.vtt`,
    `${videoId}.en-GB.vtt`,
  ];

  const exactIndex = preferences.indexOf(fileName);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  if (fileName.startsWith(`${videoId}.en-`) || fileName.startsWith(`${videoId}.en.`)) {
    return 10;
  }

  return 100;
}

function selectPreferredSubtitleFile(files: string[], videoId: string): string {
  return [...files].sort((left, right) => {
    const scoreDiff = subtitlePreferenceScore(left, videoId) - subtitlePreferenceScore(right, videoId);
    return scoreDiff !== 0 ? scoreDiff : left.localeCompare(right);
  })[0];
}

function subtitleUnavailable(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("no subtitles") ||
    normalized.includes("no automatic captions") ||
    normalized.includes("video doesn't have subtitles") ||
    normalized.includes("there are no subtitles") ||
    normalized.includes("has no subtitles")
  );
}

export async function tryDownloadSubtitles(context: IngestContext): Promise<string | null> {
  const { TRANSCRIPTS_DIR } = getDataDirs();
  await fs.ensureDir(TRANSCRIPTS_DIR);
  await fs.remove(context.transcriptPath);
  const ytDlp = await resolveExecutable("yt-dlp");

  const existingFiles = await listSubtitleFiles(context);
  await Promise.all(existingFiles.map((file) => fs.remove(file)));

  const result = await execa(
    ytDlp,
    [
      "--skip-download",
      "--write-sub",
      "--write-auto-sub",
      "--sub-langs",
      "en.*,en",
      "-o",
      `${context.subtitleStem}.%(ext)s`,
      context.sourceUrl,
    ],
    { reject: false },
  );

  const subtitleFiles = await listSubtitleFiles(context);
  if (subtitleFiles.length === 0) {
    if (result.exitCode !== 0 && !subtitleUnavailable(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(result.stderr || result.stdout || "Subtitle download failed.");
    }
    return null;
  }

  const preferredSubtitleFile = selectPreferredSubtitleFile(subtitleFiles, context.id);
  await Promise.all(
    subtitleFiles
      .filter((file) => file !== preferredSubtitleFile)
      .map((file) => fs.remove(file)),
  );

  const vttContent = await fs.readFile(preferredSubtitleFile, "utf8");
  const transcript = normalizeVttToPlainText(vttContent);
  if (!transcript) {
    return null;
  }

  await fs.writeFile(context.transcriptPath, `${transcript}\n`, "utf8");
  return transcript;
}

export async function transcribeWithWhisper(context: IngestContext): Promise<string> {
  const audioExists = await fs.pathExists(context.audioPath);
  if (!audioExists) {
    throw new Error(`Audio file missing for Whisper fallback: ${context.audioPath}`);
  }
  const whisper = await resolveExecutable("whisper");

  await fs.remove(context.transcriptPath);
  await execa(whisper, [context.audioPath, "--model", "base", "--output_dir", context.transcriptDir]);

  const exists = await fs.pathExists(context.transcriptPath);
  if (!exists) {
    throw new Error(`Expected transcript file was not created: ${context.transcriptPath}`);
  }

  const transcript = (await fs.readFile(context.transcriptPath, "utf8")).trim();
  if (!transcript) {
    throw new Error("Transcript file is empty after Whisper transcription.");
  }

  return transcript;
}

export async function transcribeAudio(context: IngestContext): Promise<string> {
  const subtitleTranscript = await tryDownloadSubtitles(context);
  if (subtitleTranscript) {
    return subtitleTranscript;
  }

  return transcribeWithWhisper(context);
}
