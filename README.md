# DS.media AI Agent

Milestone 1 is a Node.js + TypeScript CLI that ingests a YouTube video and produces structured JSON analysis.

## What It Does

Given a YouTube URL, the pipeline:

1. Downloads audio with `yt-dlp`
2. Attempts to download YouTube subtitles first
3. Parses `.vtt` subtitles into plain text when available
4. Falls back to Whisper transcription when subtitles are unavailable
5. Summarizes the transcript with Ollama
6. Writes validated JSON to `data/analysis/video.json`

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

## Output Files

After a successful run, these files must exist:

- `data/audio/video.mp3`
- `data/transcripts/video.txt`
- `data/analysis/video.json`

If subtitles are available, you may also see a downloaded `.vtt` file in `data/transcripts/`.

## Transcript Strategy

The transcript pipeline is subtitle-first:

1. Run:

```sh
yt-dlp --skip-download --write-sub --write-auto-sub <url>
```

2. If a subtitle `.vtt` file exists:
   - parse it into plain text
   - save it as `data/transcripts/video.txt`
   - use it as the transcript

3. If no usable subtitles exist:
   - fall back to Whisper transcription

Subtitle absence is not treated as a fatal error. The pipeline continues with Whisper.

## Analysis Output Schema

`data/analysis/video.json` must be valid JSON with this shape:

```json
{
  "summary": "string",
  "tags": ["string"],
  "key_takeaways": ["string"]
}
```

The CLI validates the JSON before exiting successfully.

## Development

Typecheck the project:

```sh
npx tsc --noEmit
```
