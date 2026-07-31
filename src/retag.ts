import path from "node:path";
import fs from "fs-extra";
import type { ClassificationResult } from "./classify.js";
import { classifyAgainstTaxonomy, proposeSpeakers as proposeSpeakersDefault } from "./classify.js";
import { applyFrontMatterMerge } from "./frontmatter-merge.js";
import { ingestVideo, type IngestVideoResult, type ProgressLogger } from "./pipeline.js";
import { ROOT_DIR } from "./runtime.js";
import { loadKnownSpeakers, loadSiteTaxonomy, resolveSitePath } from "./site.js";
import { findUntaggedEntries, scanSiteContent, type ContentKind, type SiteEntry } from "./site-content.js";

// The pipeline/classification calls are injectable so retagSiteMedia's file
// I/O and merge logic can be integration-tested without yt-dlp/Whisper/a
// running Ollama - those are the collaborators most sensible to fake in
// tests (see retag.test.ts) since the actual network/model calls are
// already covered indirectly by analyze.ts/classify.ts's own unit tests.
export interface RetagDependencies {
  ingest: (url: string, log?: ProgressLogger) => Promise<IngestVideoResult>;
  classify: typeof classifyAgainstTaxonomy;
  proposeSpeakers: typeof proposeSpeakersDefault;
}

export interface RetagOptions {
  sitePath?: string;
  kind?: ContentKind;
  limit?: number;
  /** Substring filter matched against an entry's slug or videoUrl - use to
   * dry-run or apply against a single entry while testing. */
  only?: string;
  /** Defaults to false: report what *would* change without writing anything. */
  apply?: boolean;
}

export interface RetagEntryResult {
  slug: string;
  videoUrl: string;
  filePath: string;
  success: boolean;
  applied: boolean;
  classification?: ClassificationResult;
  speakerProposal?: { matched: string[]; unmatched: string[] };
  changedKeys: string[];
  skippedKeys: string[];
  error?: string;
}

export interface RetagSummary {
  sitePath: string;
  kind: ContentKind;
  applied: boolean;
  totalUntagged: number;
  processed: number;
  results: RetagEntryResult[];
}

function matchesOnly(entry: SiteEntry, only?: string): boolean {
  if (!only) return true;
  return entry.slug.includes(only) || (entry.videoUrl ?? "").includes(only);
}

function hasVideoUrl(entry: SiteEntry): entry is SiteEntry & { videoUrl: string } {
  return Boolean(entry.videoUrl);
}

function noopLogger(): void {}

export async function retagSiteMedia(
  options: RetagOptions = {},
  log: ProgressLogger = noopLogger,
  deps: Partial<RetagDependencies> = {},
): Promise<RetagSummary> {
  const ingest = deps.ingest ?? ingestVideo;
  const classify = deps.classify ?? classifyAgainstTaxonomy;
  const proposeSpeakersFn = deps.proposeSpeakers ?? proposeSpeakersDefault;

  const sitePath = resolveSitePath({ override: options.sitePath });
  const kind: ContentKind = options.kind ?? "media";
  const apply = options.apply ?? false;

  log(`Scanning ${kind} content in ${sitePath}`);
  const [allEntries, taxonomy, knownSpeakers] = await Promise.all([
    scanSiteContent(sitePath, kind),
    loadSiteTaxonomy(sitePath),
    loadKnownSpeakers(sitePath),
  ]);

  const untagged = findUntaggedEntries(allEntries).filter(hasVideoUrl).filter((entry) => matchesOnly(entry, options.only));
  const limited = options.limit ? untagged.slice(0, options.limit) : untagged;

  log(
    `${untagged.length} untagged ${kind} entries match filters; processing ${limited.length}` +
      (apply ? "" : " (dry run - pass --apply to write changes)"),
  );

  const results: RetagEntryResult[] = [];

  for (const [index, entry] of limited.entries()) {
    const label = `[${index + 1}/${limited.length}] ${entry.slug}`;
    try {
      log(`${label}: running ingest pipeline for ${entry.videoUrl}`);
      const ingestResult = await ingest(entry.videoUrl, log);

      log(`${label}: classifying against site taxonomy`);
      const classification = await classify(
        {
          title: entry.title,
          description: ingestResult.analysis.description,
          summary: ingestResult.analysis.summary,
          keyTakeaways: ingestResult.analysis.key_takeaways,
          freeformTags: ingestResult.analysis.tags,
          existingTags: entry.existingTags,
        },
        taxonomy,
        undefined,
        log,
      );

      let speakerProposal: { matched: string[]; unmatched: string[] } | undefined;
      if (!entry.hasSpeakers) {
        log(`${label}: proposing speaker name (${entry.hasSpeakers ? "has" : "missing"} speakers)`);
        speakerProposal = await proposeSpeakersFn(
          { title: entry.title, description: ingestResult.analysis.description },
          knownSpeakers,
          undefined,
          log,
        );
        if (speakerProposal.unmatched.length > 0) {
          log(`${label}: speaker "${speakerProposal.unmatched.join(", ")}" proposed but not confidently matched - left for manual review`);
        }
      }

      const updates: Record<string, string[]> = {
        series: classification.series,
        topics: classification.topics,
        tools: classification.tools,
        systems: classification.systems,
        tags: classification.tags,
      };
      if (speakerProposal && speakerProposal.matched.length > 0) {
        updates.speakers = speakerProposal.matched;
      }

      const fileText = await fs.readFile(entry.filePath, "utf8");
      const merged = applyFrontMatterMerge(fileText, updates, { skipIfPresent: ["speakers"] });
      if (!merged) {
        throw new Error("Could not parse a frontmatter block out of this file.");
      }

      if (apply && merged.changedKeys.length > 0) {
        await fs.writeFile(entry.filePath, merged.text, "utf8");
      }

      results.push({
        slug: entry.slug,
        videoUrl: entry.videoUrl,
        filePath: entry.filePath,
        success: true,
        applied: apply && merged.changedKeys.length > 0,
        classification,
        speakerProposal,
        changedKeys: merged.changedKeys,
        skippedKeys: merged.skippedKeys,
      });
      log(`${label}: ${apply ? "wrote" : "planned"} changes to [${merged.changedKeys.join(", ") || "none"}]`);
    } catch (error) {
      results.push({
        slug: entry.slug,
        videoUrl: entry.videoUrl,
        filePath: entry.filePath,
        success: false,
        applied: false,
        changedKeys: [],
        skippedKeys: [],
        error: (error as Error).message,
      });
      log(`${label}: failed - ${(error as Error).message}`);
    }
  }

  return {
    sitePath,
    kind,
    applied: apply,
    totalUntagged: untagged.length,
    processed: results.length,
    results,
  };
}

export async function writeRetagReport(summary: RetagSummary, reportsDirOverride?: string): Promise<string> {
  const reportsDir = reportsDirOverride ?? path.join(ROOT_DIR, "data", "retag-reports");
  await fs.ensureDir(reportsDir);
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const reportPath = path.join(reportsDir, `${summary.kind}-${timestamp}.json`);
  await fs.writeJson(reportPath, summary, { spaces: 2 });
  return reportPath;
}
