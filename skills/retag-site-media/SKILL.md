---
name: retag-site-media
description: Use when asked to bulk-tag or retag untagged designsystems.media entries, or to write series, topics, tools, systems, and speakers into entry frontmatter. Dry run first, then apply after review.
---

# Retag site media

Finds entries in the site's `media` (or `podcast`) collection that are missing `series`, `topics`, `tools`, and `systems`, runs each through ingest and classification, and writes the results into the entry's frontmatter. Entries missing `speakers` also get a speaker proposal.

This is a long batch job. It is available on the command line only, not as an MCP tool.

## Where to run

This is a CLI-only command, so run `npm run retag_site_media` from the `dsmedia-ai-agent` checkout, not from the site repo. Pass the site location with `--site-path <path>` or set `DSMEDIA_SITE_DIR` if the site is not a sibling directory. Run the review and verification steps (`git status`, `git diff`, `npm run validate:content`) in the site repo.

## Requirements

`yt-dlp`, `whisper`, and Ollama running with the configured model. See the Requirements section of the README.

## Process

Follow these steps in order. Do not skip step 2.

1. **Start on a clean branch** in the site repo. Run `git status` there. If it has unrelated changes, tell the user before continuing.
2. **Test one entry first.** Dry run, then apply, on a single entry:

   ```sh
   npm run retag_site_media -- --only <slug-or-url-substring>
   npm run retag_site_media -- --only <slug-or-url-substring> --apply
   ```

3. **Dry run a small batch** and read the report:

   ```sh
   npm run retag_site_media -- --limit 5
   ```

   Add `--kind podcast` for the podcast collection and `--site-path <path>` if the site is not a sibling checkout. The report is written to `data/retag-reports/` on every run.
4. **Review the report with the user.** Check each entry's `classification`, `speakerProposal`, `changedKeys`, and `error`. Summarise: entries processed, entries that failed, `droppedValues` that recur.
5. **Apply** only after the user approves the dry run:

   ```sh
   npm run retag_site_media -- --apply
   ```

6. **Verify in the site repo:**

   ```sh
   npm run validate:content
   git diff --stat
   ```

## Behavior to know

- A value outside a closed list is never discarded. It moves into `tags` and appears under `droppedValues` in the report.
- Speakers are written only when the proposal matches a name already in the site's `frontmatter.json`. Unmatched names are left for manual review. An entry that already has `speakers` is not changed.
- The merge edits only the frontmatter keys it touches. A diff that rewrites unrelated lines means something is wrong. Stop and report it.

## Do not

| Temptation | Rule |
|---|---|
| "Apply everything now to save time." | Always dry run and review first. |
| "Add the dropped value to the taxonomy." | Taxonomy changes are a separate decision with an ADR. |
| "Guess the speaker from the title." | Use `add-speaker` for a new name. Never write an unmatched name. |
| "Skip validation, the diff looks fine." | `npm run validate:content` must pass. |

## Verification

- `npm run validate:content` passes in the site repo.
- `git diff --stat` in the site repo shows changes only in the intended `src/content/**/index.mdx` files.
- The report file path is given to the user.
