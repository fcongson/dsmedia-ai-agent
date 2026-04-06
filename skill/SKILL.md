---
name: dsmedia-ai-agent
description: "Use this skill when asked to analyse, summarise, transcribe, or ingest a single YouTube video. The canonical runtime surfaces are the MCP tools in this repo and the `ingest_video` CLI command."
---

# DS.media AI Agent Skill

## Overview

This skill covers the single-video pipeline for the `dsmedia-ai-agent` project. The source of truth for supported tools and commands lives in `skill/dsmedia-ai-agent.manifest.json`.

There are three ways to drive the same pipeline:

- MCP tools for Claude Desktop and other MCP clients
- `ingest_video` from the command line
- per-step CLI commands with the same names as the MCP tools
- Direct runtime modules inside the repo

The pipeline uses a subtitle-first transcript strategy and writes stable artifacts keyed by YouTube video ID.

## Canonical MCP Tools

| Tool | What it does |
|---|---|
| `parse_video_id` | Parses a YouTube URL into a video ID and expected artifact paths |
| `download_audio` | Downloads the audio track as an MP3 via yt-dlp |
| `fetch_description` | Fetches the full YouTube video description via yt-dlp |
| `write_video_summary` | Writes a markdown video note using metadata, transcript, description, and analysis artifacts |
| `fetch_subtitles` | Attempts to download YouTube subtitles or auto-captions |
| `transcribe_audio` | Transcribes audio using Whisper |
| `analyse_transcript` | Sends a transcript to Ollama and writes structured JSON analysis |

## Canonical CLI Command

```sh
npm run ingest_video -- '<youtube-url>'
```

Each MCP tool is also directly testable from CLI:

```sh
npm run parse_video_id -- '<youtube-url>'
npm run download_audio -- '<youtube-url>'
npm run fetch_description -- '<youtube-url>'
npm run write_video_summary -- '<youtube-url>'
npm run fetch_subtitles -- '<youtube-url>'
npm run transcribe_audio -- '<youtube-url>'
npm run analyse_transcript -- '<youtube-url>' 'data/transcripts/<videoId>.txt'
```

Compatibility alias:

```sh
npm run ingest -- '<youtube-url>'
```

## Decision Flow

Always begin by resolving the canonical video ID. Then follow this order:

1. If `data/analysis/<videoId>.json` already exists, reuse it unless the user explicitly wants a fresh analysis.
2. If `data/transcripts/<videoId>.txt` exists, reuse the transcript and skip download/transcription.
3. If audio is missing, run `download_audio`.
4. Try `fetch_subtitles` before Whisper.
5. If subtitles are unavailable, use `transcribe_audio`.
6. Run `analyse_transcript`.

## Model Defaults

The default local profile is `balanced`, which resolves to `llama3.1:8b` in Ollama and is currently the verified local default for this repo. Other built-in profiles remain available but have not been validated locally here yet:

- `fast` → `gemma3:4b`
- `quality` → `qwen3:8b`

Configuration precedence is:

1. explicit runtime override
2. environment variables
3. `dsmedia.config.json`
4. built-in defaults

Useful environment variables:

- `DSMEDIA_LLM_PROFILE`
- `DSMEDIA_LLM_MODEL`
- `DSMEDIA_LLM_BASE_URL`
- `DSMEDIA_LLM_TEMPERATURE`
- `DSMEDIA_LLM_NUM_CTX`
- `DSMEDIA_LLM_STRUCTURED_OUTPUT`

## Portability

This markdown file is human-oriented guidance. Portability across tools comes from two layers:

- MCP for executable cross-tool integration
- `skill/dsmedia-ai-agent.manifest.json` for machine-readable skill metadata

That means Claude and other AI tools can share the same underlying workflow even if each tool needs a different prompt wrapper.

## Error Notes

| Situation | What to do |
|---|---|
| Invalid or non-YouTube URL | Report clearly and stop. |
| `yt-dlp` missing | Ask the user to install `yt-dlp`. |
| Whisper missing | Ask the user to install `openai-whisper`. |
| Ollama unreachable | Ask the user to start Ollama and verify the configured model/profile exists. |
| No subtitles available | Not an error. Fall back to Whisper. |
| Malformed model JSON | `analyse_transcript` retries automatically before failing. |
