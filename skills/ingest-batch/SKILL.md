---
name: ingest-batch
description: "Use when asked to ingest, analyse, or process several YouTube videos at once: a playlist, a channel, a list of URLs, or a text file of URLs."
---

# Ingest a batch of videos

## Overview

This skill extends the single-video pipeline to playlists, channels, individual URLs, or a plain text file of URLs. The source of truth for supported tools and commands lives in `skill/ingest-batch.manifest.json`.

The batch flow uses the same artifact model, model configuration, and subtitle-first transcript strategy as the single-video flow.
The shared step commands are also available on CLI with the same names as the MCP tools for troubleshooting individual stages.

## Canonical MCP Tool

| Tool | What it does |
|---|---|
| `expand_playlist` | Expands a playlist or channel into individual video URLs and titles |

All single-video tools still apply per item:

- `parse_video_id`
- `download_audio`
- `fetch_description`
- `write_video_summary`
- `fetch_subtitles`
- `transcribe_audio`
- `analyse_transcript`

## Where to run

The `npm run` commands in this skill work only from the `dsmedia-ai-agent` checkout, because the scripts are defined in its `package.json`. If the session is in another repo (for example `designsystems.media`), run them from the `dsmedia-ai-agent` directory and point at the site with `--site-path <path>` or `DSMEDIA_SITE_DIR` where the command needs it. MCP tools work from any session where the `dsmedia-ai-agent` MCP server is connected.

## Canonical CLI Command

```sh
npm run ingest_batch -- '<playlist-url-or-file>'
```

Supporting step commands:

```sh
npm run parse_video_id -- '<youtube-url>'
npm run download_audio -- '<youtube-url>'
npm run fetch_description -- '<youtube-url>'
npm run write_video_summary -- '<youtube-url>'
npm run fetch_subtitles -- '<youtube-url>'
npm run transcribe_audio -- '<youtube-url>'
npm run analyse_transcript -- '<youtube-url>' 'data/transcripts/<videoId>.txt'
npm run expand_playlist -- '<playlist-or-channel-url>'
```

Accepted inputs:

- a playlist URL
- a channel URL
- a single YouTube video URL
- a text file containing one URL per line

## Batch Flow

1. Expand playlist or channel inputs into individual videos.
2. Deduplicate by canonical video ID.
3. Classify each video as:
   - `DONE` when analysis already exists
   - `PARTIAL` when transcript or audio exists
   - `NEW` when no artifacts exist
4. Process videos sequentially.
5. Reuse existing analysis/transcripts whenever possible.
6. Retry failed per-video runs up to 2 times before marking them failed.

## Model Defaults

Batch ingest uses the same default model configuration as single-video ingest:

- `balanced` → `llama3.1:8b` (verified locally in this repo)
- `fast` → `gemma3:4b` (available, not yet locally validated here)
- `quality` → `qwen3:8b` (available, not yet locally validated here)

Override with `dsmedia.config.json` or the `DSMEDIA_LLM_*` environment variables.

## Portability

Portability is split across:

- MCP tools for executable cross-client behavior
- `skill/ingest-batch.manifest.json` for machine-readable metadata
- this markdown file for human-readable guidance

That lets Claude and other AI tools share the same runtime workflow without forcing the same prompt format everywhere.

## Error Notes

| Situation | What to do |
|---|---|
| Empty playlist or channel | Report clearly and stop. |
| File path unreadable | Report clearly and stop. |
| Duplicate video IDs | Process once and skip duplicates. |
| Malformed URL in file | Ignore it and continue if at least one valid URL remains. |
| Ollama unavailable | Stop and ask the user to restore the configured Ollama service. |
