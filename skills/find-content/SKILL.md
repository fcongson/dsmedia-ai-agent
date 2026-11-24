---
name: find-content
description: Use when asked to recommend or find designsystems.media videos or episodes for a topic, question, or need, for example "something on getting engineering buy-in for a design system".
---

# Find content

Searches analysed videos and the site's own tagged frontmatter by meaning, then writes a short recommendation with links.

## Requirements

Ollama running, plus the embedding model: `ollama pull nomic-embed-text`. A chat model cannot serve embeddings, so this is a separate model. The tool runs locally only. Site visitors cannot use it.

## Process

1. In an MCP client, call `find_content` with `query` and optional `limit` (default 5) and `sitePath`. On the command line:

   ```sh
   npm run find_content -- '<natural-language request>' --limit 5
   ```

2. Pass the user's request in their own words. Do not rewrite it into keywords.
3. Give the user the recommendation and the matching videos with their links. Do not add videos that were not returned.

## Behavior to know

- Sources: cached analyses in `data/analysis`, and the site's frontmatter as a fallback for entries not yet analysed. If the site checkout is not found, the site source is skipped without an error and only `data/analysis` is searched.
- Results are ranked by embedding similarity. The recommendation is written only from the top matches.
- It does not ingest anything. To add a video to the results, use `ingest-video`.

## Verification

- Every video named in your answer appears in the tool's returned matches.
- If results look empty or unrelated, check that `nomic-embed-text` is installed before concluding nothing matches.
