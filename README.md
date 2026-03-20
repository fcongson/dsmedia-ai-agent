# DS.media AI Agent

Milestone 1 is a Node.js + TypeScript CLI that ingests a YouTube video and produces structured JSON analysis with stable, source-linked artifact names.

## What It Does

Given a YouTube URL, the pipeline:

1. Downloads audio with `yt-dlp`
2. Attempts to download YouTube subtitles first
3. Parses `.vtt` subtitles into plain text when available
4. Falls back to Whisper transcription when subtitles are unavailable
5. Summarizes the transcript with Ollama
6. Writes validated JSON to `data/analysis/<videoId>.json`

The YouTube video ID is the canonical identifier for all generated artifacts.

## Artifact Relationship Model

Each ingest derives a `videoId` from the input YouTube URL and uses it as the filename stem for all outputs:

- `data/audio/<videoId>.mp3`
- `data/transcripts/<videoId>.txt`
- `data/transcripts/<videoId>*.vtt`
- `data/analysis/<videoId>.json`

This makes batch processing safe across different videos while preserving a direct relationship between the source URL and every generated file.

Re-ingesting the same video overwrites that video ID's latest artifacts.

## Requirements

- Node.js
- `yt-dlp`
- `whisper` from `openai-whisper`
- Ollama running locally on `http://localhost:11434`
- An available Ollama model, preferably `llama3`

## Install

Install project dependencies:

```sh
npm install
```

Install external tools with Homebrew:

```sh
brew install yt-dlp
brew install openai-whisper
```

Make sure Ollama is running and has a model available:

```sh
ollama list
```

## Usage

Run the CLI with a YouTube URL:

```sh
npx tsx src/ingest.ts '<youtube-url>'
```

Example:

```sh
npx tsx src/ingest.ts 'https://www.youtube.com/watch?v=5MK3SkNST-0'
```

Supported URL shapes include standard watch URLs, `youtu.be` links, and common YouTube embed/shorts variants as long as a valid video ID can be derived.

## Output Files

After a successful run, these files must exist:

- `data/audio/<videoId>.mp3`
- `data/transcripts/<videoId>.txt`
- `data/analysis/<videoId>.json`

If subtitles are available, you may also see downloaded `.vtt` files such as `data/transcripts/<videoId>.en.vtt`.

For the example URL above, the expected outputs are:

- `data/audio/5MK3SkNST-0.mp3`
- `data/transcripts/5MK3SkNST-0.txt`
- `data/analysis/5MK3SkNST-0.json`

## Transcript Strategy

The transcript pipeline is subtitle-first:

1. Run:

```sh
yt-dlp --skip-download --write-sub --write-auto-sub <url>
```

2. If a subtitle `.vtt` file exists:
   - parse it into plain text
   - save it as `data/transcripts/<videoId>.txt`
   - use it as the transcript

3. If no usable subtitles exist:
   - fall back to Whisper transcription

Subtitle absence is not treated as a fatal error. The pipeline continues with Whisper.

Only files for the active `videoId` are cleaned up or overwritten during a run.

## Analysis Output Schema

`data/analysis/<videoId>.json` must be valid JSON with this shape:

```json
{
  "id": "string",
  "source_url": "string",
  "summary": "string",
  "tags": ["string"],
  "key_takeaways": ["string"]
}
```

Field meanings:

- `id`: canonical YouTube video ID used for all related artifacts
- `source_url`: original ingest URL
- `summary`: model-generated summary
- `tags`: array of topic labels
- `key_takeaways`: array of concise takeaways

The CLI validates the JSON before exiting successfully and checks that `id` and `source_url` match the current ingest context.

## Development

Typecheck the project:

```sh
npx tsc --noEmit
```

Run the pipeline:

```sh
npx tsx src/ingest.ts '<youtube-url>'
```
