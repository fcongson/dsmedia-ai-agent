import fs from "fs-extra";
import { analyzeTranscript } from "./analyze.js";
import { downloadVideo } from "./download.js";
import { expandPlaylist } from "./expand_playlist.js";
import { ingestBatch, ingestVideo, type DependencyName, type ProgressLogger } from "./pipeline.js";
import { createIngestContext } from "./runtime.js";
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
];

export function getOperationsForSurface(surface: OperationSurface): OperationDefinition[] {
  return OPERATIONS.filter((operation) => operation.surfaces.includes(surface));
}

export function getOperationById(id: string): OperationDefinition | undefined {
  return OPERATIONS.find((operation) => operation.id === id);
}
