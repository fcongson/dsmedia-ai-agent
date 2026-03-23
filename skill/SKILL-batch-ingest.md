---
name: dsmedia-batch-ingest
description: "Use this skill when asked to ingest, analyse, or process multiple YouTube videos at once — including playlists, channels, or a list of URLs from a file or typed in chat. Builds on the single-video pipeline in SKILL.md. Do NOT use this skill for single video requests — use SKILL.md instead."
---

# DS.media Batch Ingest Skill

## Overview

Batch ingest extends the single-video pipeline to handle multiple videos from a text file, a playlist URL, or a channel URL. Each video is processed independently using the same composable tools as the single-video skill. This skill adds the logic for expansion, progress tracking, retry handling, and batch summarisation.

## Additional Tool

This skill introduces one new tool on top of the five in SKILL.md:

| Tool | What it does |
|---|---|
| `expand_playlist` | Expands a playlist or channel URL into a flat list of individual video URLs and titles |

All other tools (`parse_video_id`, `download_audio`, `fetch_subtitles`, `transcribe_audio`, `analyse_transcript`) are used per-video exactly as described in SKILL.md.

## Input Formats

### Text file of URLs
A plain text file with one URL per line. Lines starting with `#` and blank lines are ignored.

```
# DS.media batch ingest list
https://www.youtube.com/watch?v=abc123
https://www.youtube.com/watch?v=def456
https://youtu.be/ghi789
```

Read the file to extract the URL list before starting. Strip whitespace from each line.

### Playlist or channel URL in the file
If a line in the text file is a playlist or channel URL (contains `/playlist?list=`, `/@`, `/c/`, or `/channel/`), call `expand_playlist` on that line to resolve it into individual video URLs before processing. Replace the playlist line with the expanded list in your working set.

### Playlist or channel URL typed directly
If the user provides a playlist or channel URL in chat rather than a file, call `expand_playlist` first to get the full video list, then proceed.

## Pre-flight Check

Before starting any downloads, run `parse_video_id` across all URLs in the batch and classify each video into one of three states:

- **DONE** — `data/analysis/<videoId>.json` already exists → skip entirely
- **PARTIAL** — audio or transcript exists but analysis does not → resume from the appropriate step
- **NEW** — no artifacts exist → full pipeline required

Report the classification to the user before starting:

```
Found 24 videos:
  18 new — full pipeline required
   4 partial — resuming from analysis
   2 already done — skipping

Proceed? (yes/no)
```

Wait for confirmation before starting, especially for large batches. Give the user a chance to adjust scope.

## Processing Loop

Process videos sequentially, not in parallel. Parallel processing risks overwhelming yt-dlp rate limits, exhausting Ollama's context, and making progress hard to follow.

For each video:

1. Follow the single-video decision tree from SKILL.md exactly
2. On success: mark as DONE, log the result, move to the next video
3. On failure: retry up to **2 times** before marking as FAILED

### Retry behaviour

On the first failure, wait 5 seconds then retry the failed step only — not the whole pipeline. For example, if `analyse_transcript` fails, retry `analyse_transcript` with the existing transcript; don't re-download audio.

On the second failure, mark the video as FAILED, log the error, and move on. Do not stop the batch.

### Progress reporting

After each video, report a one-line status to the user:

```
[3/24] ✓ How to build an MCP server (abc123) — subtitles, 1.2s
[4/24] ✓ Intro to Whisper (def456) — whisper, 43s
[5/24] ✗ Private video (ghi789) — failed: Video unavailable (retried 2x)
```

For long batches (10+ videos), also report a summary line every 10 videos:

```
── Progress: 10/24 complete, 1 failed, ~14 remaining ──
```

## Batch Summary

After all videos are processed, present a structured summary:

```
Batch complete — 24 videos processed

✓ 21 succeeded
  • 14 via subtitles
  •  7 via Whisper

✗ 3 failed
  • ghi789 — Video unavailable
  • jkl012 — Ollama timeout after 2 retries
  • mno345 — Audio download failed: region blocked

Output: data/analysis/<videoId>.json for each successful video
```

Then offer two follow-up actions:

1. **Retry failed videos** — re-run the failed list only
2. **Channel summary** — synthesise themes across all successful analyses (uses the `channel-summary` skill if available)

## Edge Cases

**Empty playlist or channel:** `expand_playlist` will return an error. Report it clearly and ask the user to check the URL is public and accessible.

**Very large playlists (100+ videos):** Warn the user before the pre-flight check that this will take significant time. Estimate roughly 1–3 minutes per video depending on length and whether subtitles are available. Let them narrow the scope if needed.

**Duplicate URLs in the file:** Deduplicate by video ID before starting. If the same video ID appears more than once, process it once and log a note.

**Mixed file (individual URLs + playlist URLs):** Expand playlist lines first, deduplicate the full resolved list, then run the pre-flight check on the merged set.

**File not found or unreadable:** Report clearly. Ask the user to confirm the file path.

**Ollama becomes unreachable mid-batch:** This will cause repeated failures. After 3 consecutive Ollama failures, pause the batch and alert the user rather than burning through all remaining retries. Ask them to check Ollama before resuming.

## Error Reference

| Situation | What to do |
|---|---|
| Playlist/channel is private | Report. Ask for a public URL or a text file of individual video URLs. |
| Video is private or deleted | Mark as FAILED, log, continue. |
| yt-dlp rate limited | Wait 30 seconds, retry once. If still failing, pause and alert the user. |
| Whisper takes too long | Not a failure — just slow. Keep the user informed with elapsed time. |
| Ollama unreachable | Pause after 3 consecutive failures. Alert user before continuing. |
| Malformed URL in file | Skip with a warning. Log the line number and the bad URL. |
| Duplicate video IDs | Process once, log the duplicate as skipped. |
