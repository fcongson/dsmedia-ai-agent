import path from "node:path";
import fs from "fs-extra";
import { ROOT_DIR } from "./runtime.js";

export interface SiteTaxonomy {
  series: string[];
  topics: string[];
  tools: string[];
  systems: string[];
}

export interface ResolveSitePathOptions {
  override?: string;
  env?: NodeJS.ProcessEnv;
}

// designsystems.media is developed as a sibling repo to this one
// (.../git/dsmedia-ai-agent and .../git/designsystems.media). That's the
// default; DSMEDIA_SITE_DIR or an explicit --site-path flag override it
// for anyone whose checkout layout differs.
const DEFAULT_SITE_DIR_NAME = "designsystems.media";

// Hardcoded for the same reason as DEFAULT_SITE_DIR_NAME above: this repo is
// purpose-built for this one site, not a generic multi-site tool. Used to
// build absolute links for site-sourced search.ts entries that don't have
// their own ingested YouTube URL (see astro.config.mjs's `site` field).
export const SITE_BASE_URL = "https://designsystems.media";

export function resolveSitePath(options: ResolveSitePathOptions = {}): string {
  const env = options.env ?? process.env;
  const candidate = options.override ?? env.DSMEDIA_SITE_DIR;
  if (candidate) {
    return path.resolve(candidate);
  }

  return path.resolve(ROOT_DIR, "..", DEFAULT_SITE_DIR_NAME);
}

export async function assertSitePath(sitePath: string): Promise<void> {
  const contentConfigPath = path.join(sitePath, "src", "content.config.ts");
  const exists = await fs.pathExists(contentConfigPath);
  if (!exists) {
    throw new Error(
      `Could not find designsystems.media checkout at ${sitePath} (expected ${contentConfigPath} to exist). ` +
        "Pass --site-path or set DSMEDIA_SITE_DIR to the repo's absolute path.",
    );
  }
}

function taxonomyModulePath(sitePath: string): string {
  return path.join(sitePath, "src", "lib", "content-domain", "taxonomy.ts");
}

export async function loadSiteTaxonomy(sitePath: string): Promise<SiteTaxonomy> {
  await assertSitePath(sitePath);
  const modulePath = taxonomyModulePath(sitePath);
  const exists = await fs.pathExists(modulePath);
  if (!exists) {
    throw new Error(`Site taxonomy module not found at ${modulePath}`);
  }

  // Dynamic import of an absolute path outside this project. Requires the
  // process to be running under `node --import tsx` (or an equivalent TS
  // loader) since taxonomy.ts has no build step of its own.
  const moduleUrl = `${new URL(`file://${modulePath}`).href}?t=${Date.now()}`;
  const mod = (await import(moduleUrl)) as {
    SERIES?: readonly string[];
    TOPICS?: readonly string[];
    TOOLS?: readonly string[];
    SYSTEMS?: readonly string[];
  };

  if (!mod.SERIES || !mod.TOPICS || !mod.TOOLS || !mod.SYSTEMS) {
    throw new Error(`Site taxonomy module at ${modulePath} did not export SERIES/TOPICS/TOOLS/SYSTEMS.`);
  }

  return {
    series: [...mod.SERIES],
    topics: [...mod.TOPICS],
    tools: [...mod.TOOLS],
    systems: [...mod.SYSTEMS],
  };
}

interface FrontMatterCustomTaxonomyEntry {
  id?: unknown;
  options?: unknown;
}

interface FrontMatterConfig {
  "frontMatter.taxonomy.customTaxonomy"?: FrontMatterCustomTaxonomyEntry[];
}

export async function loadKnownSpeakers(sitePath: string): Promise<string[]> {
  await assertSitePath(sitePath);
  const frontMatterConfigPath = path.join(sitePath, "frontmatter.json");
  const exists = await fs.pathExists(frontMatterConfigPath);
  if (!exists) {
    return [];
  }

  const config = (await fs.readJson(frontMatterConfigPath)) as FrontMatterConfig;
  const customTaxonomy = config["frontMatter.taxonomy.customTaxonomy"] ?? [];
  const speakersEntry = customTaxonomy.find((entry) => entry.id === "speakers");
  if (!speakersEntry || !Array.isArray(speakersEntry.options)) {
    return [];
  }

  return speakersEntry.options.filter((value): value is string => typeof value === "string");
}
