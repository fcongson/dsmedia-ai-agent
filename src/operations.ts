import fs from "fs-extra";
import { analyzeTranscript } from "./analyze.js";
import { classifyAgainstTaxonomy } from "./classify.js";
import { fetchDescription } from "./description.js";
import { downloadVideo } from "./download.js";
import { expandPlaylist } from "./expand_playlist.js";
import { ensureMetadata } from "./metadata.js";
import { ingestBatch, ingestVideo, type DependencyName, type ProgressLogger } from "./pipeline.js";
import { retagSiteMedia, writeRetagReport, type RetagOptions } from "./retag.js";
import { createIngestContext } from "./runtime.js";
import { findContent } from "./search.js";
import { loadSiteTaxonomy, resolveSitePath } from "./site.js";
import type { ContentKind } from "./site-content.js";
import { transcribeAudio, tryDownloadSubtitles } from "./transcribe.js";

export type OperationSurface = "mcp" | "cli";

export interface OperationDefinition<TInput = any> {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  surfaces: OperationSurface[];
  handler: (input: TInput) => Promise<unknown>;
  cli?: {
    usage: string;
    requiredDependencies: DependencyName[];
    parseArgs: (args: string[]) => Promise<TInput>;
    run?: (input: TInput, log: ProgressLogger) => Promise<unknown>;
  };
  examples?: string[];
}

const TOOL_INPUT_URL = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description: "A YouTube video URL.",
    },
  },
  required: ["url"],
};

function requireArg(value: string | undefined, label: string, usage: string): string {
  if (!value) {
    throw new Error(`Missing required argument: ${label}\n\nUsage:\n  ${usage}`);
  }

  return value;
}

async function readTranscriptFile(filePath: string): Promise<string> {
  const transcript = (await fs.readFile(filePath, "utf8")).trim();
  if (!transcript) {
    throw new Error(`Transcript file is empty: ${filePath}`);
  }

  return transcript;
}

export const OPERATIONS: OperationDefinition[] = [
  {
    id: "parse_video_id",
    description:
      "Parse a YouTube URL and return the canonical video ID plus the expected file paths for all artifacts. Use this first to check what already exists before deciding which steps to run.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const context = createIngestContext(input.url);
      return {
        id: context.id,
        sourceUrl: context.sourceUrl,
        audioPath: context.audioPath,
        descriptionPath: context.descriptionPath,
        metadataPath: context.metadataPath,
        notePath: context.notePath,
        transcriptPath: context.transcriptPath,
        analysisPath: context.analysisPath,
      };
    },
    cli: {
      usage: "node --import tsx src/cli.ts parse_video_id <youtube-url>",
      requiredDependencies: [],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts parse_video_id <youtube-url>") }),
    },
  },
  {
    id: "download_audio",
    description: "Download the audio track from a YouTube video as an MP3 file using yt-dlp. Returns the path to the saved file.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const context = createIngestContext(input.url);
      return { audioPath: await downloadVideo(context) };
    },
    cli: {
      usage: "node --import tsx src/cli.ts download_audio <youtube-url>",
      requiredDependencies: ["yt-dlp"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts download_audio <youtube-url>") }),
    },
  },
  {
    id: "fetch_description",
    description:
      "Fetch the full description of a YouTube video using yt-dlp. The description often contains chapter timestamps, speaker bios, and resource links. Returns null if unavailable.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const context = createIngestContext(input.url);
      return { description: await fetchDescription(context) };
    },
    cli: {
      usage: "node --import tsx src/cli.ts fetch_description <youtube-url>",
      requiredDependencies: ["yt-dlp"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts fetch_description <youtube-url>") }),
    },
  },
  {
    id: "fetch_subtitles",
    description:
      "Attempt to download YouTube subtitles or auto-generated captions for a video and return them as plain text. Returns null if no subtitles are available.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const context = createIngestContext(input.url);
      const transcript = await tryDownloadSubtitles(context);
      return transcript ? { transcript, source: "subtitles" } : { transcript: null, source: null };
    },
    cli: {
      usage: "node --import tsx src/cli.ts fetch_subtitles <youtube-url>",
      requiredDependencies: ["yt-dlp"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts fetch_subtitles <youtube-url>") }),
    },
  },
  {
    id: "write_video_summary",
    description:
      "Generate a markdown video summary note at data/notes/<videoId>.md using cached metadata, transcript, description, and analysis artifacts.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const result = await ingestVideo(input.url);
      return { notePath: result.notePath };
    },
    cli: {
      usage: "node --import tsx src/cli.ts write_video_summary <youtube-url>",
      requiredDependencies: ["yt-dlp", "whisper", "ollama"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts write_video_summary <youtube-url>") }),
      run: async (input: { url: string }, log) => {
        const result = await ingestVideo(input.url, log);
        return { notePath: result.notePath };
      },
    },
  },
  {
    id: "transcribe_audio",
    description:
      "Transcribe a previously downloaded audio file using OpenAI Whisper. Requires the audio file to already exist at the expected path.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const context = createIngestContext(input.url);
      const transcript = await transcribeAudio(context);
      return { transcript, source: "whisper" };
    },
    cli: {
      usage: "node --import tsx src/cli.ts transcribe_audio <youtube-url>",
      requiredDependencies: ["yt-dlp", "whisper"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts transcribe_audio <youtube-url>") }),
    },
  },
  {
    id: "analyse_transcript",
    description:
      "Send a transcript to a local Ollama model and return a structured JSON analysis with a summary, tags, and key takeaways. Saves the result to data/analysis/<videoId>.json.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The original YouTube video URL.",
        },
        transcript: {
          type: "string",
          description: "The plain text transcript to analyse.",
        },
      },
      required: ["url", "transcript"],
    },
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string; transcript: string }) => {
      const context = createIngestContext(input.url);
      return analyzeTranscript(context, input.transcript);
    },
    cli: {
      usage: "node --import tsx src/cli.ts analyse_transcript <youtube-url> <transcript-file>",
      requiredDependencies: ["ollama"],
      parseArgs: async (args: string[]) => {
        const url = requireArg(args[0], "url", "node --import tsx src/cli.ts analyse_transcript <youtube-url> <transcript-file>");
        const transcriptPath = requireArg(args[1], "transcript-file", "node --import tsx src/cli.ts analyse_transcript <youtube-url> <transcript-file>");
        return {
          url,
          transcript: await readTranscriptFile(transcriptPath),
        };
      },
      run: async (input: { url: string; transcript: string }, log) => {
        const context = createIngestContext(input.url);
        return analyzeTranscript(context, input.transcript, undefined, log);
      },
    },
  },
  {
    id: "classify_taxonomy",
    description:
      "Classify a YouTube video against designsystems.media's closed content taxonomy (series/topics/tools/systems from src/lib/content-domain/taxonomy.ts), plus freeform tags for anything that doesn't fit. Reuses or generates the video's cached analysis first. Does not write to any site content file - use retag_site_media for that.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "A YouTube video URL.",
        },
        sitePath: {
          type: "string",
          description: "Absolute path to the designsystems.media checkout. Defaults to a sibling directory or DSMEDIA_SITE_DIR.",
        },
      },
      required: ["url"],
    },
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string; sitePath?: string }) => {
      const sitePath = resolveSitePath({ override: input.sitePath });
      const context = createIngestContext(input.url);
      const [ingestResult, metadata, taxonomy] = await Promise.all([
        ingestVideo(input.url),
        ensureMetadata(context),
        loadSiteTaxonomy(sitePath),
      ]);
      return classifyAgainstTaxonomy(
        {
          title: metadata.title,
          description: ingestResult.analysis.description,
          summary: ingestResult.analysis.summary,
          keyTakeaways: ingestResult.analysis.key_takeaways,
          freeformTags: ingestResult.analysis.tags,
          existingTags: [],
        },
        taxonomy,
      );
    },
    cli: {
      usage: "node --import tsx src/cli.ts classify_taxonomy <youtube-url> [--site-path <path>]",
      requiredDependencies: ["yt-dlp", "whisper", "ollama"],
      parseArgs: async (args: string[]) => {
        const url = requireArg(args[0], "url", "node --import tsx src/cli.ts classify_taxonomy <youtube-url> [--site-path <path>]");
        const siteFlagIndex = args.indexOf("--site-path");
        const sitePath = siteFlagIndex >= 0 ? args[siteFlagIndex + 1] : undefined;
        return { url, sitePath };
      },
      run: async (input: { url: string; sitePath?: string }, log) => {
        const sitePath = resolveSitePath({ override: input.sitePath });
        const context = createIngestContext(input.url);
        const [ingestResult, metadata, taxonomy] = await Promise.all([
          ingestVideo(input.url, log),
          ensureMetadata(context),
          loadSiteTaxonomy(sitePath),
        ]);
        return classifyAgainstTaxonomy(
          {
            title: metadata.title,
            description: ingestResult.analysis.description,
            summary: ingestResult.analysis.summary,
            keyTakeaways: ingestResult.analysis.key_takeaways,
            freeformTags: ingestResult.analysis.tags,
            existingTags: [],
          },
          taxonomy,
          undefined,
          log,
        );
      },
    },
  },
  {
    id: "find_content",
    description:
      "Search for content relevant to a natural-language request and return a short conversational recommendation plus the matching videos with links. Searches already-analyzed videos (data/analysis) plus, as a fallback for anything not yet analysed, designsystems.media's own tagged frontmatter directly.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A natural-language description of what the user wants to watch or learn about.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching videos to consider. Defaults to 5.",
        },
        sitePath: {
          type: "string",
          description:
            "Absolute path to the designsystems.media checkout, used for the frontmatter fallback source. Defaults to a sibling directory or DSMEDIA_SITE_DIR; silently skipped if not found.",
        },
      },
      required: ["query"],
    },
    surfaces: ["mcp", "cli"],
    handler: async (input: { query: string; limit?: number; sitePath?: string }) =>
      findContent(input.query, { limit: input.limit, sitePath: input.sitePath }),
    cli: {
      usage: "node --import tsx src/cli.ts find_content <query> [--limit N] [--site-path <path>]",
      requiredDependencies: ["ollama"],
      parseArgs: async (args: string[]) => {
        const limitFlagIndex = args.indexOf("--limit");
        const limitRaw = limitFlagIndex >= 0 ? args[limitFlagIndex + 1] : undefined;
        const limit = limitRaw ? Number(limitRaw) : undefined;
        if (limitRaw && (!Number.isFinite(limit) || (limit as number) <= 0)) {
          throw new Error(`--limit must be a positive number, got: ${limitRaw}`);
        }

        const siteFlagIndex = args.indexOf("--site-path");
        const sitePath = siteFlagIndex >= 0 ? args[siteFlagIndex + 1] : undefined;

        const flagIndexes = new Set<number>();
        if (limitFlagIndex >= 0) {
          flagIndexes.add(limitFlagIndex);
          flagIndexes.add(limitFlagIndex + 1);
        }
        if (siteFlagIndex >= 0) {
          flagIndexes.add(siteFlagIndex);
          flagIndexes.add(siteFlagIndex + 1);
        }

        const query = args.filter((_, index) => !flagIndexes.has(index)).join(" ").trim();
        if (!query) {
          throw new Error(
            "Missing required argument: query\n\nUsage:\n  node --import tsx src/cli.ts find_content <query> [--limit N] [--site-path <path>]",
          );
        }

        return { query, limit, sitePath };
      },
      run: async (input: { query: string; limit?: number; sitePath?: string }, log) =>
        findContent(input.query, { limit: input.limit, sitePath: input.sitePath, log }),
    },
  },
  {
    id: "expand_playlist",
    description:
      "Expand a YouTube playlist or channel URL into a flat list of individual video URLs and titles. Also accepts individual video URLs and returns a single-item list.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["mcp", "cli"],
    handler: async (input: { url: string }) => {
      const entries = await expandPlaylist(input.url);
      return { count: entries.length, videos: entries };
    },
    cli: {
      usage: "node --import tsx src/cli.ts expand_playlist <youtube-url>",
      requiredDependencies: ["yt-dlp"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts expand_playlist <youtube-url>") }),
    },
  },
  {
    id: "ingest_video",
    description: "Run the full single-video ingest pipeline with resume support and write the analysis artifact.",
    inputSchema: TOOL_INPUT_URL,
    surfaces: ["cli"],
    handler: async (input: { url: string }) => ingestVideo(input.url),
    cli: {
      usage: "node --import tsx src/cli.ts ingest_video <youtube-url>",
      requiredDependencies: ["yt-dlp", "whisper", "ollama"],
      parseArgs: async (args: string[]) => ({ url: requireArg(args[0], "url", "node --import tsx src/cli.ts ingest_video <youtube-url>") }),
      run: async (input: { url: string }, log) => ingestVideo(input.url, log),
    },
  },
  {
    id: "ingest_batch",
    description: "Run the batch ingest pipeline from a playlist URL, channel URL, video URL, or a text file of URLs.",
    inputSchema: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "A playlist/channel/video URL or a path to a text file of URLs.",
        },
      },
      required: ["input"],
    },
    surfaces: ["cli"],
    handler: async (input: { input: string }) => ingestBatch(input.input),
    cli: {
      usage: "node --import tsx src/cli.ts ingest_batch <url-or-file>",
      requiredDependencies: ["yt-dlp", "whisper", "ollama"],
      parseArgs: async (args: string[]) => ({ input: requireArg(args[0], "input", "node --import tsx src/cli.ts ingest_batch <url-or-file>") }),
      run: async (input: { input: string }, log) => ingestBatch(input.input, log),
    },
  },
  {
    id: "retag_site_media",
    description:
      "Bulk-classify every untagged designsystems.media content entry (missing series/topics/tools/systems, or missing speakers) against the site's closed taxonomy, and write the results back into each entry's frontmatter. Dry-run by default (pass apply: true to write); writes a JSON report either way.",
    inputSchema: {
      type: "object",
      properties: {
        sitePath: { type: "string", description: "Absolute path to the designsystems.media checkout." },
        kind: { type: "string", enum: ["media", "podcast"], description: "Content collection to process. Defaults to media." },
        limit: { type: "number", description: "Cap the number of entries processed, for testing." },
        only: { type: "string", description: "Only process entries whose slug or videoUrl contains this substring." },
        apply: { type: "boolean", description: "Actually write frontmatter changes. Defaults to false (dry run)." },
      },
      required: [],
    },
    surfaces: ["cli"],
    handler: async (input: RetagOptions) => {
      const summary = await retagSiteMedia(input);
      const reportPath = await writeRetagReport(summary);
      return { reportPath, summary };
    },
    cli: {
      usage:
        "node --import tsx src/cli.ts retag_site_media [--site-path <path>] [--kind media|podcast] [--limit N] [--only <substring>] [--apply]",
      requiredDependencies: ["yt-dlp", "whisper", "ollama"],
      parseArgs: async (args: string[]): Promise<RetagOptions> => {
        const getFlagValue = (flag: string): string | undefined => {
          const index = args.indexOf(flag);
          return index >= 0 ? args[index + 1] : undefined;
        };

        const kind = getFlagValue("--kind");
        if (kind && kind !== "media" && kind !== "podcast") {
          throw new Error(`--kind must be "media" or "podcast", got: ${kind}`);
        }

        const limitRaw = getFlagValue("--limit");
        const limit = limitRaw ? Number(limitRaw) : undefined;
        if (limitRaw && (!Number.isFinite(limit) || (limit as number) <= 0)) {
          throw new Error(`--limit must be a positive number, got: ${limitRaw}`);
        }

        return {
          sitePath: getFlagValue("--site-path"),
          kind: kind as ContentKind | undefined,
          limit,
          only: getFlagValue("--only"),
          apply: args.includes("--apply"),
        };
      },
      run: async (input: RetagOptions, log) => {
        const summary = await retagSiteMedia(input, log);
        const reportPath = await writeRetagReport(summary);
        log(`Report written to ${reportPath}`);
        return { reportPath, summary };
      },
    },
  },
];

export function getOperationsForSurface(surface: OperationSurface): OperationDefinition[] {
  return OPERATIONS.filter((operation) => operation.surfaces.includes(surface));
}

export function getOperationById(id: string): OperationDefinition | undefined {
  return OPERATIONS.find((operation) => operation.id === id);
}
