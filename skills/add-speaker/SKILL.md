---
name: add-speaker
description: Use when a designsystems.media entry has a speaker who is not in the controlled speakers list, or when asked to add or correct a speaker name in frontmatter.json.
---

# Add a speaker

`speakers` is a controlled list. Its options are in `frontmatter.json` in the site repo, under `frontMatter.taxonomy.customTaxonomy` with `id: "speakers"`. Entries may only use names from that list. The retag tools write a speaker only on an exact match, and leave other names for manual review. This skill handles those names.

## Process

1. **Get the name from a source.** Use the video title, description, or the show's own pages. If you cannot find the full name in a source, stop and ask the user. Do not guess a spelling.
2. **Check for an existing match.** Search the list case-insensitively, including common variants (nickname, middle initial, accents). If a match exists, use the existing spelling and do not add a new name.
3. **Add the name** to the speakers `options` array in `frontmatter.json`. The list is kept in alphabetical order with no duplicates. Insert in place. Do not reformat the file.
4. **Check the JSON is valid and the list is still sorted and unique:**

   ```sh
   node -e 'const d=JSON.parse(require("fs").readFileSync("frontmatter.json","utf8"));const s=d["frontMatter.taxonomy.customTaxonomy"].find(t=>t.id==="speakers").options;const sorted=[...s].sort();console.log(s.length, JSON.stringify(s)===JSON.stringify(sorted), new Set(s).size===s.length)'
   ```

   Expect a count, `true`, and `true`.
5. **Set the entry's `speakers`** to the new name: `speakers: ["Full Name"]` in the entry's `index.mdx`.
6. **Run `npm run validate:content`** in the site repo.

## Do not

- Do not add a speaker name from a model's guess without a source.
- Do not rename an existing speaker. Renames affect every entry that uses it. Ask the user first, then update all entries in the same change.

## Verification

- The check in step 4 prints `true` twice.
- `npm run validate:content` passes.
- `git diff` shows one added line in `frontmatter.json` and the intended change in the entry.
