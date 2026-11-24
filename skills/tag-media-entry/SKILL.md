---
name: tag-media-entry
description: Use when asked what series, topics, tools, systems, or speakers a designsystems.media video should have, or to preview tagging for one video before writing anything. Read-only.
---

# Tag one media entry (preview)

Classifies one video against the site's closed taxonomy and shows the result. It does not write to any site file. To write changes, use `retag-site-media`.

## When to use

- The user asks "how would this video be tagged?" or shares a YouTube URL and asks for taxonomy values.
- You are checking whether a tagging prompt or taxonomy change gives sensible results on a known entry.

## Process

1. Confirm the site checkout is found. It is a sibling directory named `designsystems.media`, or the path in `DSMEDIA_SITE_DIR`, or `--site-path`.
2. Run the tool. In an MCP client, call `classify_taxonomy` with `url` (and `sitePath` if needed). On the command line:

   ```sh
   npm run classify_taxonomy -- '<youtube-url>'
   ```

3. Report the result in four groups: `series`, `topics`, `tools`, `systems`. Then list `tags` (freeform leftovers) and `droppedValues`.
4. For each value, say why it fits, using the title, summary, or description.

## Rules the tool enforces (do not work around them)

| Field | Limit | Notes |
|---|---|---|
| `series` | at most 2 | Only when the video is presented as part of that show or event. A passing mention of a similarly named person or thing is not enough. |
| `topics` | at most 5 | Most videos deserve 1 to 3. |
| `tools` | at most 4 | Tools discussed at some length, not named once. |
| `systems` | at most 3 | Named design system products (Spectrum, Polaris, Carbon), not companies. |

Values must match a closed-list entry exactly. A value that does not match goes into `tags` and is also listed in `droppedValues`.

## Red flags

- A field is full to its limit. Small local models sometimes echo the candidate list back instead of choosing. Treat this as a failed run and say so.
- The same `droppedValues` entry appears across several videos. That may justify a taxonomy change. Do not add it yourself. Describe it to the user and suggest an ADR (see ADR 0012 and ADR 0014 in the site repo).

## Verification

- Every value in `series`, `topics`, `tools`, and `systems` appears verbatim in `src/lib/content-domain/taxonomy.ts` in the site repo.
- No site file changed. `git status` in the site repo shows no new modifications from this skill.
