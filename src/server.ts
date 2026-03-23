import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createIngestContext } from "./runtime.js";
import { downloadVideo } from "./download.js";
import { transcribeAudio as transcribeWithWhisper } from "./transcribe.js";
import { analyzeTranscript, ensureOllamaReachable } from "./analyze.js";
import { tryDownloadSubtitles } from "./transcribe.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "parse_video_id",
    description:
      "Parse a YouTube URL and return the canonical video ID plus the expected file paths for all artifacts. Use this first to check what already exists before deciding which steps to run.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "A YouTube video URL (watch, youtu.be, shorts, or embed format).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "download_audio",
    description:
      "Download the audio track from a YouTube video as an MP3 file using yt-dlp. Returns the path to the saved file.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The YouTube video URL to download audio from.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_subtitles",
    description:
      "Attempt to download YouTube subtitles or auto-generated captions for a video and return them as plain text. Returns null if no subtitles are available — in that case, fall back to transcribe_audio.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The YouTube video URL to fetch subtitles for.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "transcribe_audio",
    description:
      "Transcribe a previously downloaded audio file using OpenAI Whisper. Only call this if fetch_subtitles returned null. Requires the audio file to already exist at the expected path.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The original YouTube video URL (used to resolve the audio file path).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "analyse_transcript",
    description:
      "Send a transcript to a local Ollama model and return a structured JSON analysis with a summary, tags, and key takeaways. Saves the result to data/analysis/<videoId>.json.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The original YouTube video URL (used as the canonical source reference).",
        },
        transcript: {
          type: "string",
          description: "The plain text transcript to analyse.",
        },
      },
      required: ["url", "transcript"],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleParseVideoId(args: { url: string }) {
  const context = createIngestContext(args.url);
  return {
    id: context.id,
    sourceUrl: context.sourceUrl,
    audioPath: context.audioPath,
    transcriptPath: context.transcriptPath,
    analysisPath: context.analysisPath,
  };
}

async function handleDownloadAudio(args: { url: string }) {
  const context = createIngestContext(args.url);
  const audioPath = await downloadVideo(context);
  return { audioPath };
}

async function handleFetchSubtitles(args: { url: string }) {
  const context = createIngestContext(args.url);
  const transcript = await tryDownloadSubtitles(context);
  if (!transcript) {
    return { transcript: null, source: null };
  }
  return { transcript, source: "subtitles" };
}

async function handleTranscribeAudio(args: { url: string }) {
  const context = createIngestContext(args.url);
  // transcribeAudio in transcribe.ts already does subtitle-first then Whisper,
  // but here we call it knowing subtitles already failed (the caller decided).
  // We re-use it for simplicity; the subtitle check will be near-instant since
  // no .vtt files will be present for this videoId.
  const transcript = await transcribeWithWhisper(context);
  return { transcript, source: "whisper" };
}

async function handleAnalyseTranscript(args: { url: string; transcript: string }) {
  const context = createIngestContext(args.url);
  await ensureOllamaReachable();
  const result = await analyzeTranscript(context, args.transcript);
  return result;
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "dsmedia-ai-agent", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "parse_video_id":
        result = await handleParseVideoId(args as { url: string });
        break;
      case "download_audio":
        result = await handleDownloadAudio(args as { url: string });
        break;
      case "fetch_subtitles":
        result = await handleFetchSubtitles(args as { url: string });
        break;
      case "transcribe_audio":
        result = await handleTranscribeAudio(args as { url: string });
        break;
      case "analyse_transcript":
        result = await handleAnalyseTranscript(args as { url: string; transcript: string });
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${(error as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
