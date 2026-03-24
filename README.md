# DS.media AI Agent

A Node.js + TypeScript pipeline that ingests YouTube videos and produces structured JSON analysis with stable, source-linked artifact names. Supports single videos and batch ingest from playlists, channels, or URL lists. Can be run as a CLI, an MCP server for use with Claude Desktop, or wired into Open WebUI via a proxy.

![DS.media AI Agent demo in Open WebUI](./assets/ds-media-ai-agent-demo.gif)

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

### CLI

Run the full pipeline directly with a YouTube URL:

```sh
npx tsx src/ingest.ts '<youtube-url>'
```

Example:

```sh
npx tsx src/ingest.ts 'https://www.youtube.com/watch?v=5MK3SkNST-0'
```

Supported URL shapes include standard watch URLs, `youtu.be` links, and common YouTube embed/shorts variants as long as a valid video ID can be derived.

### MCP Server

The pipeline is also exposed as an MCP server with composable tools. This allows AI agents and clients to call each pipeline step independently.

Start the server:

```sh
npm run server
```

The server communicates over stdio and exposes these tools:

- `parse_video_id` — parse a YouTube URL and return the video ID and expected artifact paths
- `download_audio` — download the audio track as an MP3
- `fetch_subtitles` — attempt to download YouTube subtitles or auto-captions
- `transcribe_audio` — transcribe the audio using Whisper (fallback when subtitles are unavailable)
- `analyse_transcript` — send the transcript to Ollama and return structured JSON analysis
- `expand_playlist` — expand a playlist or channel URL into a flat list of individual video URLs and titles

#### Testing with MCP Inspector

To test tools individually without a client:

```sh
npx @modelcontextprotocol/inspector tsx src/server.ts
```

This opens a local web UI where you can call each tool and inspect the response.

#### Wiring into Claude Desktop

Add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dsmedia-ai-agent": {
      "command": "npx",
      "args": ["tsx", "/path/to/your/repo/src/server.ts"]
    }
  }
}
```

Restart Claude Desktop, then ask it to analyse a YouTube video and it will call the tools automatically.

#### Wiring into Open WebUI

Open WebUI requires HTTP-based MCP connections rather than stdio. Use `mcpo` to proxy the server over HTTP.

**Step 1:** Install `uv` if you don't have it:

```sh
brew install uv
```

**Step 2:** Start the proxy:

```sh
uvx mcpo --port 8000 --api-key "your-secret" -- npx tsx src/server.ts
```

Your tools are now available at `http://localhost:8000`. Visit `http://localhost:8000/docs` to verify.

**Step 3:** Add the tool in Open WebUI under **Admin Settings → Tools → Add Tool**:

- URL: `http://localhost:8000` (use `http://host.docker.internal:8000` if Open WebUI is running in Docker)
- API Key: the key you set above
- Type: `OpenAPI`

**Step 4:** Enable the tools for your model. There are two ways:

- **Per chat**: click the **➕** button in the chat input and toggle on `dsmedia-ai-agent`
- **By default**: go to **Workspace → Models → (your model) → Tools**, check **DS.Media AI Agent**, and save — the tools will be active for every chat with that model without needing to toggle them on each time

The full local stack looks like this:

```
Open WebUI  ←→  mcpo (port 8000)  ←→  src/server.ts (stdio)  ←→  yt-dlp / Whisper / Ollama
```

## Batch Ingest

The MCP server supports batch processing via the `expand_playlist` tool. Pass a playlist URL, channel URL, or a plain text file of URLs — the agent will expand the list, skip already-processed videos, and work through each one sequentially with automatic retries.

### URL list file format

Create a plain text file with one URL per line. Blank lines and lines starting with `#` are ignored. Playlist and channel URLs are automatically expanded into individual video URLs.

```
# My batch list
https://www.youtube.com/watch?v=abc123
https://www.youtube.com/watch?v=def456
https://www.youtube.com/playlist?list=PLxxxxxxxx
```

### How the agent handles the batch

Before starting, the agent classifies every video into one of three states:

- **DONE** — analysis already exists, skip
- **PARTIAL** — audio or transcript exists but analysis does not, resume from the right step
- **NEW** — no artifacts exist, run the full pipeline

It then processes videos sequentially, retrying each failed step up to 2 times before moving on. A summary of successes and failures is presented at the end.

See `skill/SKILL-batch-ingest.md` for the full agent guidance.

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

## Agent Skills

The `skill/` folder contains guidance documents for AI agents using the MCP server. They encode the decision logic, retry behaviour, error handling, and output formatting that an agent needs to use the tools effectively.

- `skill/SKILL.md` — single video ingest
- `skill/SKILL-batch-ingest.md` — batch ingest from playlists, channels, or URL lists

## Development

Typecheck the project:

```sh
npx tsc --noEmit
```

Run the pipeline:

```sh
npx tsx src/ingest.ts '<youtube-url>'
```
