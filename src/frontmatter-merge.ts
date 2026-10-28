// Minimal, hand-rolled frontmatter editor for one purpose: add or extend a
// handful of array fields (series/topics/tools/systems/tags/speakers) in an
// existing .mdx frontmatter block, while leaving every other byte of the
// file untouched. A full YAML parse-then-restringify round trip (e.g. via
// gray-matter + js-yaml) would re-flow quoting/array style on every field in
// the document, producing noisy diffs across hundreds of content files. This
// operates line-by-line instead, and only rewrites the specific key ranges
// it's asked to touch.

export interface SplitFrontMatter {
  frontMatter: string;
  body: string;
}

export function splitFrontMatter(fileText: string): SplitFrontMatter | null {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) {
    return null;
  }

  return { frontMatter: match[1], body: match[2] };
}

interface KeyRange {
  key: string;
  start: number;
  end: number; // exclusive
}

const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u;

function findTopLevelKeyRanges(lines: string[]): KeyRange[] {
  const ranges: KeyRange[] = [];
  let current: KeyRange | null = null;

  for (const [index, line] of lines.entries()) {
    const match = line.match(TOP_LEVEL_KEY_PATTERN);
    if (match) {
      if (current) {
        current.end = index;
        ranges.push(current);
      }
      current = { key: match[1], start: index, end: lines.length };
    }
  }

  if (current) {
    ranges.push(current);
  }

  return ranges;
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if (first === '"' && last === '"') {
      return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
    if (first === "'" && last === "'") {
      return trimmed.slice(1, -1).replace(/''/gu, "'");
    }
  }
  return trimmed;
}

function splitFlowArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === quote && inner[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    items.push(current);
  }

  return items.map((item) => unquote(item)).filter((item) => item.length > 0);
}

/** Parses the existing value of a top-level array key, in either flow
 * (`key: ["a", "b"]`) or block (`key:\n  - a\n  - b`) style. */
export function parseExistingArrayValue(lines: string[], range: KeyRange): string[] {
  const keyLine = lines[range.start];
  const inlineMatch = keyLine.match(TOP_LEVEL_KEY_PATTERN);
  const inlineValue = inlineMatch ? inlineMatch[2].trim() : "";

  if (inlineValue.startsWith("[")) {
    const inner = inlineValue.replace(/^\[/u, "").replace(/\]\s*$/u, "");
    return splitFlowArrayItems(inner);
  }

  const items: string[] = [];
  for (let i = range.start + 1; i < range.end; i += 1) {
    const itemMatch = lines[i].match(/^\s*-\s*(.*)$/u);
    if (itemMatch) {
      items.push(unquote(itemMatch[1]));
    }
  }

  return items;
}

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (/^\s|\s$/u.test(value)) return true;
  if (/^[\[\]{}"'>|*&!%#`@,:]/u.test(value)) return true;
  if (/:(\s|$)/u.test(value)) return true;
  if (/^(true|false|null|yes|no|on|off)$/iu.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/u.test(value)) return true;
  return false;
}

function quoteScalar(value: string): string {
  if (!needsQuoting(value)) {
    return value;
  }
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function formatBlockList(key: string, values: string[]): string[] {
  return [`${key}:`, ...values.map((value) => `  - ${quoteScalar(value)}`)];
}

function dedupeCaseInsensitive(existing: string[], additions: string[]): { merged: string[]; added: string[] } {
  const seen = new Set(existing.map((value) => value.trim().toLowerCase()));
  const added: string[] = [];

  for (const addition of additions) {
    const trimmed = addition.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(trimmed);
  }

  return { merged: [...existing, ...added], added };
}

export interface MergeFrontMatterOptions {
  /** Keys that must not be modified if they already exist in the document,
   * even if new values are supplied for them (used for `speakers`, which is
   * a hand-curated controlled taxonomy we don't want to silently append to). */
  skipIfPresent?: string[];
}

export interface MergeFrontMatterResult {
  frontMatter: string;
  changedKeys: string[];
  skippedKeys: string[];
}

/** Adds or extends array-valued top-level keys in a frontmatter block.
 * `updates` maps key name to the candidate values to ensure are present.
 * Existing values and their formatting are left alone; only new, unique
 * values are added, and only for keys not listed in `skipIfPresent` that
 * already exist. */
export function mergeFrontMatterFields(
  frontMatter: string,
  updates: Record<string, string[]>,
  options: MergeFrontMatterOptions = {},
): MergeFrontMatterResult {
  const skipIfPresent = new Set(options.skipIfPresent ?? []);
  const lines = frontMatter.split(/\r?\n/u);
  const ranges = findTopLevelKeyRanges(lines);
  const rangeByKey = new Map(ranges.map((range) => [range.key, range]));

  const changedKeys: string[] = [];
  const skippedKeys: string[] = [];

  // Process in descending line-start order so earlier splices don't shift
  // the indices of ranges we haven't processed yet.
  const keysToUpdate = Object.keys(updates)
    .filter((key) => (updates[key] ?? []).length > 0)
    .map((key) => ({ key, range: rangeByKey.get(key) }))
    .sort((a, b) => (b.range?.start ?? -1) - (a.range?.start ?? -1));

  let workingLines = [...lines];

  for (const { key, range } of keysToUpdate) {
    const candidates = updates[key];

    if (range) {
      if (skipIfPresent.has(key)) {
        skippedKeys.push(key);
        continue;
      }

      const existingValues = parseExistingArrayValue(workingLines, range);
      const { merged, added } = dedupeCaseInsensitive(existingValues, candidates);
      if (added.length === 0) {
        continue;
      }

      const newBlock = formatBlockList(key, merged);
      workingLines.splice(range.start, range.end - range.start, ...newBlock);
      changedKeys.push(key);
      continue;
    }

    const { merged, added } = dedupeCaseInsensitive([], candidates);
    if (added.length === 0) {
      continue;
    }
    workingLines.push(...formatBlockList(key, merged));
    changedKeys.push(key);
  }

  return {
    frontMatter: workingLines.join("\n"),
    changedKeys: changedKeys.sort(),
    skippedKeys: skippedKeys.sort(),
  };
}

/** Reads a single top-level scalar value (e.g. `title`, `videoUrl`). Returns
 * null if the key is absent or isn't a simple inline scalar (e.g. it opens a
 * block scalar or a nested mapping, neither of which this module needs to
 * read). */
export function getTopLevelScalar(frontMatter: string, key: string): string | null {
  const lines = frontMatter.split(/\r?\n/u);
  const range = findTopLevelKeyRanges(lines).find((entry) => entry.key === key);
  if (!range) {
    return null;
  }

  const match = lines[range.start].match(TOP_LEVEL_KEY_PATTERN);
  const inlineValue = match ? match[2].trim() : "";
  if (!inlineValue || inlineValue === ">" || inlineValue === "|" || inlineValue.startsWith(">") || inlineValue.startsWith("|")) {
    return null;
  }

  return unquote(inlineValue);
}

/** Reads the full values of a top-level array key (e.g. `series`, `tags`),
 * in either flow or block style. Returns an empty array if the key is
 * absent or empty. */
export function getTopLevelArray(frontMatter: string, key: string): string[] {
  const lines = frontMatter.split(/\r?\n/u);
  const range = findTopLevelKeyRanges(lines).find((entry) => entry.key === key);
  if (!range) {
    return [];
  }

  return parseExistingArrayValue(lines, range);
}

export interface HasTopLevelKeyOptions {
  requireNonEmpty?: boolean;
}

export function hasTopLevelKey(frontMatter: string, key: string, options: HasTopLevelKeyOptions = {}): boolean {
  const lines = frontMatter.split(/\r?\n/u);
  const range = findTopLevelKeyRanges(lines).find((entry) => entry.key === key);
  if (!range) {
    return false;
  }

  if (!options.requireNonEmpty) {
    return true;
  }

  return parseExistingArrayValue(lines, range).length > 0;
}

export function applyFrontMatterMerge(fileText: string, updates: Record<string, string[]>, options?: MergeFrontMatterOptions): { text: string; changedKeys: string[]; skippedKeys: string[] } | null {
  const split = splitFrontMatter(fileText);
  if (!split) {
    return null;
  }

  const result = mergeFrontMatterFields(split.frontMatter, updates, options);
  const text = `---\n${result.frontMatter}\n---\n${split.body}`;
  return { text, changedKeys: result.changedKeys, skippedKeys: result.skippedKeys };
}
