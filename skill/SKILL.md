---
name: dsmedia-ai-agent
description: "Use this skill when asked to analyse, summarise, transcribe, or ingest a YouTube video. Covers the full pipeline: parsing the video ID, downloading audio, obtaining a transcript (subtitles preferred, Whisper fallback), and generating structured JSON analysis via Ollama. Also covers partial runs — re-analysing an existing transcript, re-transcribing without re-downloading, or inspecting previously generated artifacts. Do NOT use this skill for non-YouTube URLs or for tasks that don't involve video content."
---

# DS.media AI Agent Skill

## Overview

This skill drives the `dsmedia-ai-agent` MCP server. The server exposes five composable tools that map to discrete stages of the pipeline. This skill tells you when to call each tool, how to handle branching decisions, and what to do with the outputs.

The pipeline has one canonical input — a YouTube URL — and one canonical output — a structured JSON analysis file at `data/analysis/<videoId>.json`.

## Tools

| Tool | What it does |
|---|---|
| `parse_video_id` | Parses a YouTube URL into a video ID and returns expected artifact paths |
| `download_audio` | Downloads the audio track as an MP3 via yt-dlp |
| `fetch_subtitles` | Attempts to download YouTube subtitles or auto-captions |
| `transcribe_audio` | Transcribes the audio file using Whisper (fallback only) |
| `analyse_transcript` | Sends a transcript to Ollama and returns structured JSON analysis |

## Decision Tree

Always start with `parse_video_id`. It costs nothing and tells you what already exists on disk, which determines which steps to skip.

```
User provides a YouTube URL
        ↓
parse_video_id(url)
        ↓
Does data/analysis/<videoId>.json already exist?
  ├── YES → Ask the user: re-analyse, or return the existing result?
  └── NO  → continue
        ↓
Does data/transcripts/<videoId>.txt already exist?
  ├── YES → Skip to analyse_transcript — no need to re-download or re-transcribe
  └── NO  → continue
        ↓
Does data/audio/<videoId>.mp3 already exist?
  ├── YES → Skip download_audio — go straight to fetch_subtitles
  └── NO  → download_audio(url)
        ↓
fetch_subtitles(url)
  ├── transcript returned → go to analyse_transcript
  └── null returned       → transcribe_audio(url)
        ↓
analyse_transcript(url, transcript)
        ↓
Return the analysis result to the user
```

## Step-by-step Guidance

### 1. parse_video_id

Always call this first. Use the returned paths to check what already exists before deciding what to run.

Supported URL formats: standard watch URLs (`youtube.com/watch?v=`), short links (`youtu.be/`), shorts (`/shorts/`), and embeds (`/embed/`). If the URL is not a YouTube URL or the video ID cannot be extracted, this tool will error — report the error to the user and ask for a valid URL.

### 2. download_audio

Only call this if `data/audio/<videoId>.mp3` does not already exist.

This step can take a while for long videos. Let the user know it's in progress. If it fails, check:
- Is `yt-dlp` installed and on `$PATH`?
- Is the video private, age-restricted, or region-blocked?
- Is the URL valid and accessible?

Do not proceed to transcription if this step fails.

### 3. fetch_subtitles

Call this before `transcribe_audio`. Subtitles are faster, more accurate for speech with proper nouns, and don't require the audio file to be downloaded first (though in practice audio will already be present).

If `fetch_subtitles` returns `null`, it means no subtitles or auto-captions were available — this is not an error. Proceed to `transcribe_audio`.

If `fetch_subtitles` returns a transcript, skip `transcribe_audio` entirely.

### 4. transcribe_audio (fallback only)

Only call this if `fetch_subtitles` returned `null`.

Requires the audio file to exist at `data/audio/<videoId>.mp3`. Uses Whisper's `base` model — accurate for most spoken English content but may struggle with heavy accents, technical jargon, or low-quality audio. For better accuracy the user can manually run Whisper with a larger model and place the output at `data/transcripts/<videoId>.txt`, then call `analyse_transcript` directly.

### 5. analyse_transcript

Requires a running Ollama instance at `http://localhost:11434` with at least one model available. Prefers `llama3` but will use whatever model is available.

Pass the full transcript text. Retries up to 3 times if Ollama returns malformed JSON. If all retries fail, report the error and suggest the user check Ollama is running (`ollama list`) and has a capable model loaded.

The output is written to `data/analysis/<videoId>.json` and has this shape:

```json
{
  "id": "string",
  "source_url": "string",
  "summary": "string",
  "tags": ["string"],
  "key_takeaways": ["string"]
}
```

## Partial Runs

The composable tool design means you don't always need to run the full pipeline. Common partial-run patterns:

**Re-analyse with a different model:** The user has swapped Ollama models and wants a fresh analysis. Call `analyse_transcript` directly with the existing transcript from `data/transcripts/<videoId>.txt`. No need to re-download or re-transcribe.

**Re-transcribe only:** The user wants better transcription accuracy. They can run Whisper manually with a larger model and save the output to `data/transcripts/<videoId>.txt`. Then call `analyse_transcript` with the new transcript.

**Batch processing:** For multiple URLs, run each through the full decision tree independently. Each video ID is isolated — processing one will never overwrite another's artifacts.

**Transcript only:** If the user just wants a transcript without analysis, run the pipeline through `fetch_subtitles` or `transcribe_audio` and stop. The transcript is saved to `data/transcripts/<videoId>.txt`.

## Error Handling

| Situation | What to do |
|---|---|
| Invalid or non-YouTube URL | Report clearly. Ask for a valid YouTube URL. |
| Video unavailable (private, deleted, region-blocked) | Report the yt-dlp error. Nothing can be done without a downloadable video. |
| No subtitles available | Not an error — proceed to `transcribe_audio`. |
| Whisper not installed | Ask the user to install it: `brew install openai-whisper`. |
| yt-dlp not installed | Ask the user to install it: `brew install yt-dlp`. |
| Ollama not reachable | Ask the user to start Ollama and confirm a model is available with `ollama list`. |
| Ollama returns malformed JSON | `analyse_transcript` retries 3 times automatically. If it still fails, suggest trying a more capable model (e.g. `llama3` instead of a smaller variant). |
| Empty transcript | Whisper produced no output — the audio may be silent or too short. Report to the user. |

## What to Present to the User

After a successful full run, present the analysis in a readable way — don't just dump the raw JSON. A good response includes:

- A one-paragraph prose summary (from `summary`)
- The tags as a compact list
- The key takeaways as a short bulleted list
- A note of which transcript source was used (subtitles or Whisper) and the artifact paths for reference

If the user asked a specific question about the video (e.g. "what does this video say about X?"), use the analysis as context but answer their question directly rather than presenting the full schema output.
