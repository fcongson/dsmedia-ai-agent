import { execa } from "execa";
import fs from "fs-extra";
import { getDataDirs, type IngestContext, resolveExecutable } from "./runtime.js";

export interface VideoChapter {
  title: string;
  startTime: number;
}

export interface VideoMetadata {
  id: string;
  sourceUrl: string;
  title: string;
  channel: string;
  uploadDate: string | null;
  durationSeconds: number | null;
  chapters: VideoChapter[];
}

interface YtDlpChapterCandidate {
  title?: unknown;
  start_time?: unknown;
}

interface YtDlpMetadataCandidate {
  id?: unknown;
  title?: unknown;
  fulltitle?: unknown;
  channel?: unknown;
  uploader?: unknown;
  upload_date?: unknown;
  duration?: unknown;
  chapters?: unknown;
}

function normalizeUploadDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/u);
  if (!match) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeChapters(value: unknown): VideoChapter[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((chapter) => {
      const candidate = chapter as YtDlpChapterCandidate;
      if (typeof candidate.title !== "string" || typeof candidate.start_time !== "number" || candidate.start_time < 0) {
        return null;
      }

      return {
        title: candidate.title.trim(),
        startTime: Math.floor(candidate.start_time),
      };
    })
    .filter((chapter): chapter is VideoChapter => Boolean(chapter && chapter.title))
    .sort((left, right) => left.startTime - right.startTime);
}

function parseYtDlpMetadata(context: IngestContext, raw: string): VideoMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`yt-dlp returned invalid metadata JSON: ${(error as Error).message}`);
  }

  const candidate = parsed as YtDlpMetadataCandidate;
  const title = typeof candidate.title === "string"
    ? candidate.title.trim()
    : typeof candidate.fulltitle === "string"
      ? candidate.fulltitle.trim()
      : "";
  const channel = typeof candidate.channel === "string"
    ? candidate.channel.trim()
    : typeof candidate.uploader === "string"
      ? candidate.uploader.trim()
      : "";

  if (!title) {
    throw new Error("Video metadata is missing a title.");
  }

  return {
    id: context.id,
    sourceUrl: context.sourceUrl,
    title,
    channel: channel || "Unknown Channel",
    uploadDate: normalizeUploadDate(candidate.upload_date),
    durationSeconds: typeof candidate.duration === "number" && candidate.duration >= 0 ? Math.floor(candidate.duration) : null,
    chapters: normalizeChapters(candidate.chapters),
  };
}

function isVideoChapter(value: unknown): value is VideoChapter {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === "string" && typeof candidate.startTime === "number";
}

function isVideoMetadata(value: unknown): value is VideoMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.channel === "string" &&
    (typeof candidate.uploadDate === "string" || candidate.uploadDate === null) &&
    (typeof candidate.durationSeconds === "number" || candidate.durationSeconds === null) &&
    Array.isArray(candidate.chapters) &&
    candidate.chapters.every(isVideoChapter)
  );
}

export async function readCachedMetadata(context: IngestContext): Promise<VideoMetadata | null> {
  const exists = await fs.pathExists(context.metadataPath);
  if (!exists) {
    return null;
  }

  const metadata = await fs.readJson(context.metadataPath);
  if (!isVideoMetadata(metadata)) {
    throw new Error(`Metadata JSON does not match the expected schema: ${context.metadataPath}`);
  }

  return metadata;
}

export async function fetchMetadata(context: IngestContext): Promise<VideoMetadata> {
  const { METADATA_DIR } = getDataDirs();
  await fs.ensureDir(METADATA_DIR);
  const ytDlp = await resolveExecutable("yt-dlp");

  const result = await execa(
    ytDlp,
    ["--dump-single-json", "--no-download", context.sourceUrl],
    { reject: false },
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr || result.stdout || "Video metadata fetch failed.");
  }

  const metadata = parseYtDlpMetadata(context, result.stdout);
  await fs.writeJson(context.metadataPath, metadata, { spaces: 2 });
  return metadata;
}

export async function ensureMetadata(context: IngestContext): Promise<VideoMetadata> {
  const cachedMetadata = await readCachedMetadata(context);
  if (cachedMetadata) {
    return cachedMetadata;
  }

  return fetchMetadata(context);
}
