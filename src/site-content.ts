import path from "node:path";
import fs from "fs-extra";
import { getTopLevelScalar, hasTopLevelKey, parseExistingArrayValue, splitFrontMatter } from "./frontmatter-merge.js";
import { assertSitePath } from "./site.js";

export type ContentKind = "media" | "podcast";

const TAXONOMY_KEYS = ["series", "topics", "tools", "systems"] as const;

export interface SiteEntry {
  filePath: string;
  slug: string;
  kind: ContentKind;
  title: string | null;
  videoUrl: string | null;
  hasTaxonomy: boolean;
  hasSpeakers: boolean;
  existingTags: string[];
}

function contentRoot(sitePath: string, kind: ContentKind): string {
  return path.join(sitePath, "src", "content", kind);
}

async function walkForIndexMdx(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkForIndexMdx(entryPath)));
    } else if (entry.isFile() && entry.name === "index.mdx") {
      results.push(entryPath);
    }
  }

  return results;
}

async function readSiteEntry(filePath: string, kind: ContentKind, sitePath: string): Promise<SiteEntry | null> {
  const fileText = await fs.readFile(filePath, "utf8");
  const split = splitFrontMatter(fileText);
  if (!split) {
    return null;
  }

  const hasTaxonomy = TAXONOMY_KEYS.some((key) => hasTopLevelKey(split.frontMatter, key, { requireNonEmpty: true }));
  const hasSpeakers = hasTopLevelKey(split.frontMatter, "speakers", { requireNonEmpty: true });
  const lines = split.frontMatter.split(/\r?\n/u);
  const tagsRangeStart = lines.findIndex((line) => /^tags:/u.test(line));
  let existingTags: string[] = [];
  if (tagsRangeStart >= 0) {
    let end = lines.length;
    for (let i = tagsRangeStart + 1; i < lines.length; i += 1) {
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/u.test(lines[i])) {
        end = i;
        break;
      }
    }
    existingTags = parseExistingArrayValue(lines, { key: "tags", start: tagsRangeStart, end });
  }

  return {
    filePath,
    slug: path.relative(contentRoot(sitePath, kind), path.dirname(filePath)),
    kind,
    title: getTopLevelScalar(split.frontMatter, "title"),
    videoUrl: getTopLevelScalar(split.frontMatter, kind === "media" ? "videoUrl" : "episodeUrl"),
    hasTaxonomy,
    hasSpeakers,
    existingTags,
  };
}

export async function scanSiteContent(sitePath: string, kind: ContentKind): Promise<SiteEntry[]> {
  await assertSitePath(sitePath);
  const root = contentRoot(sitePath, kind);
  const exists = await fs.pathExists(root);
  if (!exists) {
    return [];
  }

  const files = (await walkForIndexMdx(root)).sort();
  const entries: SiteEntry[] = [];
  for (const file of files) {
    const entry = await readSiteEntry(file, kind, sitePath);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

export function findUntaggedEntries(entries: SiteEntry[]): SiteEntry[] {
  return entries.filter((entry) => !entry.hasTaxonomy);
}

export function findEntriesMissingSpeakers(entries: SiteEntry[]): SiteEntry[] {
  return entries.filter((entry) => !entry.hasSpeakers);
}
