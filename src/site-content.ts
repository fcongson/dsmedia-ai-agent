import path from "node:path";
import fs from "fs-extra";
import { getTopLevelArray, getTopLevelScalar, hasTopLevelKey, splitFrontMatter } from "./frontmatter-merge.js";
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
  /** Populated regardless of hasTaxonomy/hasSpeakers, for consumers (like
   * find_content's site-fallback search source) that want the actual
   * values rather than just presence - e.g. an entry that's partially
   * tagged still has real series/topics to search on. */
  series: string[];
  topics: string[];
  tools: string[];
  systems: string[];
  speakers: string[];
  /** Raw markdown body (the entry's description/notes), truncated - good
   * enough as fallback search text for an entry with no ingest analysis. */
  bodyExcerpt: string;
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
  const existingTags = getTopLevelArray(split.frontMatter, "tags");

  return {
    filePath,
    slug: path.relative(contentRoot(sitePath, kind), path.dirname(filePath)),
    kind,
    title: getTopLevelScalar(split.frontMatter, "title"),
    videoUrl: getTopLevelScalar(split.frontMatter, kind === "media" ? "videoUrl" : "episodeUrl"),
    hasTaxonomy,
    hasSpeakers,
    existingTags,
    series: getTopLevelArray(split.frontMatter, "series"),
    topics: getTopLevelArray(split.frontMatter, "topics"),
    tools: getTopLevelArray(split.frontMatter, "tools"),
    systems: getTopLevelArray(split.frontMatter, "systems"),
    speakers: getTopLevelArray(split.frontMatter, "speakers"),
    bodyExcerpt: split.body.trim().slice(0, 1500),
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
