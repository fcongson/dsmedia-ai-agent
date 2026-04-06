import path from "node:path";
import fs from "fs-extra";
import { ensureDescription } from "./description.js";
import { ensureMetadata, type VideoChapter, type VideoMetadata } from "./metadata.js";
import { ROOT_DIR, getDataDirs, type IngestContext } from "./runtime.js";
import type { AnalysisResult } from "./analyze.js";

const VIDEO_SUMMARY_FORMAT_PATH = path.join(ROOT_DIR, "formats", "video-summary.md");

export interface NoteQuote {
  quote: string;
  speaker: string;
  seconds: number;
}

export interface NoteResource {
  label: string;
  url: string;
  note: string;
}

function formatTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatApproximateDuration(durationSeconds: number | null): string {
  return `~${formatTimestamp(durationSeconds ?? 0)}`;
}

function formatFrontmatterDate(uploadDate: string | null): string {
  return uploadDate ?? "unknown";
}

function escapeFrontmatterValue(value: string): string {
  return value.replace(/\n+/gu, " ").trim();
}

function buildEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}`;
}

function trimTranscriptLine(line: string): string {
  return line.replace(/\s+/gu, " ").trim();
}

function pickTranscriptQuotes(transcript: string, durationSeconds: number | null, speaker: string): NoteQuote[] {
  const lines = transcript
    .split(/\r?\n/u)
    .map(trimTranscriptLine)
    .filter((line) => line.length >= 60 && line.length <= 240)
    .filter((line) => !/^\[[^\]]+\]$/u.test(line));

  if (lines.length === 0) {
    return [];
  }

  const selected: NoteQuote[] = [];
  const targetCount = Math.min(5, Math.max(2, Math.min(lines.length, 3)));
  const usedQuotes = new Set<string>();

  for (let index = 0; index < targetCount; index += 1) {
    const position = Math.floor((index * (lines.length - 1)) / Math.max(1, targetCount - 1));
    const quote = lines[position];
    if (!quote || usedQuotes.has(quote)) {
      continue;
    }

    usedQuotes.add(quote);
    const seconds = durationSeconds && lines.length > 1
      ? Math.floor((position / (lines.length - 1)) * durationSeconds)
      : 0;

    selected.push({ quote, speaker, seconds });
  }

  return selected.slice(0, 5);
}

function inferChaptersFromTakeaways(takeaways: string[], durationSeconds: number | null): VideoChapter[] {
  if (takeaways.length === 0) {
    return [{ title: "Overview", startTime: 0 }];
  }

  const titles = ["Introduction", ...takeaways.slice(0, 4)];
  return titles.map((title, index) => ({
    title,
    startTime: durationSeconds && titles.length > 1
      ? Math.floor((index / (titles.length - 1)) * durationSeconds)
      : 0,
  }));
}

function extractUrlResources(text: string): NoteResource[] {
  const matches = text.match(/https?:\/\/[^\s)]+/gu) ?? [];
  const seen = new Set<string>();
  const resources: NoteResource[] = [];

  for (const rawUrl of matches) {
    const url = rawUrl.replace(/[),.;]+$/u, "");
    if (seen.has(url)) {
      continue;
    }

    seen.add(url);

    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./u, "");
    } catch {
      host = url;
    }

    resources.push({
      label: host,
      url,
      note: "Mentioned in the video description or transcript.",
    });
  }

  return resources;
}

function buildSections(summary: string, takeaways: string[], description: string | null): string[] {
  const sections: string[] = [];
  sections.push(`## Overview\n\n${summary}`);

  if (takeaways.length > 0) {
    const bodies = takeaways.slice(0, 4).map((takeaway, index) => `### Theme ${index + 1}\n\n${takeaway}.`).join("\n\n");
    sections.push(`## Main Ideas\n\n${bodies}`);
  }

  if (description) {
    const excerpt = description
      .split(/\r?\n\r?\n/u)
      .map((block) => block.trim())
      .find((block) => block.length >= 80);
    if (excerpt) {
      sections.push(`## Context\n\n${excerpt}`);
    }
  }

  return sections;
}

function renderQuotesSection(videoId: string, quotes: NoteQuote[]): string {
  if (quotes.length < 2) {
    return "";
  }

  return [
    "## Notable Quotes",
    "",
    ...quotes.flatMap((quote) => [
      `> "${quote.quote}"`,
      "",
      `— **${quote.speaker}** (~[${formatTimestamp(quote.seconds)}](https://www.youtube.com/watch?v=${videoId}&t=${quote.seconds}))`,
      "",
    ]),
  ].join("\n").trim();
}

function renderChaptersSection(chapters: VideoChapter[], inferred: boolean): string {
  const rows = chapters.map((chapter, index) => {
    const time = index === 0 && chapter.startTime === 0
      ? "00:00"
      : `${inferred ? "~" : ""}${formatTimestamp(chapter.startTime)}`;
    return `| ${time} | ${chapter.title} |`;
  });

  return [
    "## Chapters",
    "",
    "| Time | Topic |",
    "|------|-------|",
    ...rows,
  ].join("\n");
}

function renderResourcesSection(resources: NoteResource[]): string {
  if (resources.length === 0) {
    return "";
  }

  return [
    "## Resources",
    "",
    ...resources.map((resource) => `- [${resource.label}](${resource.url}) — ${resource.note}`),
  ].join("\n");
}

export async function loadVideoSummaryFormat(): Promise<string> {
  return fs.readFile(VIDEO_SUMMARY_FORMAT_PATH, "utf8");
}

export function renderVideoSummaryMarkdown(input: {
  context: IngestContext;
  metadata: VideoMetadata;
  analysis: AnalysisResult;
  transcript: string;
  description: string | null;
}): string {
  const { context, metadata, analysis, transcript, description } = input;
  const resources = extractUrlResources([description ?? "", transcript].filter(Boolean).join("\n\n"));
  const sections = buildSections(analysis.summary, analysis.key_takeaways, description);
  const quotes = pickTranscriptQuotes(transcript, metadata.durationSeconds, metadata.channel);
  const chapters = metadata.chapters.length > 0 ? metadata.chapters : inferChaptersFromTakeaways(analysis.key_takeaways, metadata.durationSeconds);
  const inferredChapters = metadata.chapters.length === 0;

  const parts = [
    "---",
    "type: video-summary",
    `source: ${context.sourceUrl}`,
    `channel: ${escapeFrontmatterValue(metadata.channel)}`,
    `date: ${formatFrontmatterDate(metadata.uploadDate)}`,
    `duration: ${formatApproximateDuration(metadata.durationSeconds)}`,
    "tags:",
    ...(analysis.tags.length > 0 ? analysis.tags.map((tag) => `  - ${escapeFrontmatterValue(tag)}`) : ["  - uncategorized"]),
    "---",
    "",
    `# ${metadata.title}`,
    "",
    `> ${analysis.summary}`,
    "",
    `<iframe width="560" height="315" src="${buildEmbedUrl(context.id)}" frameborder="0" allowfullscreen></iframe>`,
    "",
    "---",
    "",
    sections.join("\n\n---\n\n"),
    "",
    "---",
    "",
    "## Key Takeaways",
    "",
    ...analysis.key_takeaways.map((takeaway) => `- **${takeaway}** — why it matters in the broader context of the video`),
    "",
    "---",
    "",
    renderQuotesSection(context.id, quotes),
    "",
    "---",
    "",
    renderChaptersSection(chapters, inferredChapters),
    resources.length > 0 ? `\n\n---\n\n${renderResourcesSection(resources)}` : "",
  ];

  return `${parts.filter((part) => part.trim() !== "").join("\n")}\n`;
}

export async function writeVideoSummary(
  context: IngestContext,
  transcript: string,
  analysis: AnalysisResult,
): Promise<string> {
  await loadVideoSummaryFormat();
  const { NOTES_DIR } = getDataDirs();
  await fs.ensureDir(NOTES_DIR);
  const metadata = await ensureMetadata(context);
  const description = analysis.description ?? await ensureDescription(context);
  const markdown = renderVideoSummaryMarkdown({
    context,
    metadata,
    analysis: {
      ...analysis,
      description,
    },
    transcript,
    description,
  });

  await fs.writeFile(context.notePath, markdown, "utf8");
  return context.notePath;
}
