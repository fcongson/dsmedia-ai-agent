import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { retagSiteMedia, writeRetagReport } from "./retag.js";
import type { IngestVideoResult } from "./pipeline.js";
import type { ClassificationResult } from "./classify.js";

async function makeFakeSite(): Promise<string> {
  const sitePath = await fs.mkdtemp(path.join(os.tmpdir(), "dsmedia-site-"));

  await fs.outputFile(path.join(sitePath, "src", "content.config.ts"), "export const collections = {};\n");

  await fs.outputFile(
    path.join(sitePath, "src", "lib", "content-domain", "taxonomy.ts"),
    `export const SERIES = ["Converge"] as const;\n` +
      `export const TOPICS = ["Design Tokens", "Accessibility"] as const;\n` +
      `export const TOOLS = ["Figma"] as const;\n` +
      `export const SYSTEMS = ["Spectrum"] as const;\n`,
  );

  await fs.outputJson(path.join(sitePath, "frontmatter.json"), {
    "frontMatter.taxonomy.customTaxonomy": [{ id: "speakers", options: ["Jane Doe"] }],
  });

  // Untagged, missing speakers - should get both taxonomy and speakers written.
  await fs.outputFile(
    path.join(sitePath, "src", "content", "media", "untagged-no-speakers", "index.mdx"),
    `---\ntitle: "Untagged talk"\nvideoUrl: "https://www.youtube.com/watch?v=aaa111"\nlocalImages: true\ntags: ["Misc"]\ndraft: false\n---\n\nBody text.\n`,
  );

  // Untagged, already has speakers - speakers must stay untouched.
  await fs.outputFile(
    path.join(sitePath, "src", "content", "media", "untagged-has-speakers", "index.mdx"),
    `---\ntitle: "Another talk"\nvideoUrl: "https://www.youtube.com/watch?v=bbb222"\nlocalImages: true\ndraft: false\nspeakers: ["Existing Person"]\n---\n\nBody text.\n`,
  );

  // Already tagged - must not be touched or processed at all.
  await fs.outputFile(
    path.join(sitePath, "src", "content", "media", "already-tagged", "index.mdx"),
    `---\ntitle: "Tagged talk"\nvideoUrl: "https://www.youtube.com/watch?v=ccc333"\nlocalImages: true\ndraft: false\ntopics:\n  - Accessibility\n---\n\nBody text.\n`,
  );

  return sitePath;
}

function fakeIngestResult(): IngestVideoResult {
  return {
    analysis: {
      id: "fake",
      source_url: "https://www.youtube.com/watch?v=aaa111",
      description: "Jane Doe discusses design tokens.",
      summary: "A talk about design tokens and Figma.",
      tags: ["Design tokens", "Random One-Off Thing"],
      key_takeaways: ["Tokens matter"],
    },
    transcript: "transcript text",
    transcriptSource: "existing",
    stateBeforeRun: "DONE",
    reusedExistingAnalysis: true,
    notePath: "/tmp/fake-note.md",
  };
}

function fakeClassification(): ClassificationResult {
  return {
    series: ["Converge"],
    topics: ["Design Tokens"],
    tools: ["Figma"],
    systems: [],
    tags: ["Random One-Off Thing"],
    droppedValues: [],
  };
}

test("retagSiteMedia dry run reports planned changes without writing files", async () => {
  const sitePath = await makeFakeSite();
  try {
    const summary = await retagSiteMedia(
      { sitePath, apply: false },
      undefined,
      {
        ingest: async () => fakeIngestResult(),
        classify: async () => fakeClassification(),
        proposeSpeakers: async () => ({ matched: ["Jane Doe"], unmatched: [] }),
      },
    );

    assert.equal(summary.totalUntagged, 2);
    assert.equal(summary.processed, 2);
    assert.ok(summary.results.every((r) => r.success));
    assert.ok(summary.results.every((r) => r.applied === false));

    const untouched = await fs.readFile(
      path.join(sitePath, "src", "content", "media", "untagged-no-speakers", "index.mdx"),
      "utf8",
    );
    assert.ok(!untouched.includes("topics:"), "dry run must not write to disk");
  } finally {
    await fs.remove(sitePath);
  }
});

test("retagSiteMedia apply:true writes taxonomy fields, adds speakers only where absent, and never touches already-tagged entries", async () => {
  const sitePath = await makeFakeSite();
  try {
    const summary = await retagSiteMedia(
      { sitePath, apply: true },
      undefined,
      {
        ingest: async () => fakeIngestResult(),
        classify: async () => fakeClassification(),
        proposeSpeakers: async () => ({ matched: ["Jane Doe"], unmatched: [] }),
      },
    );

    assert.equal(summary.totalUntagged, 2);

    const noSpeakers = await fs.readFile(
      path.join(sitePath, "src", "content", "media", "untagged-no-speakers", "index.mdx"),
      "utf8",
    );
    assert.match(noSpeakers, /series:\n {2}- Converge/u);
    assert.match(noSpeakers, /topics:\n {2}- Design Tokens/u);
    assert.match(noSpeakers, /tools:\n {2}- Figma/u);
    assert.match(noSpeakers, /speakers:\n {2}- Jane Doe/u);
    // Leftover tag merged into the existing flow-style tags array.
    assert.match(noSpeakers, /tags:\n {2}- Misc\n {2}- Random One-Off Thing/u);
    assert.match(noSpeakers, /Body text\.\n$/u, "body content must be preserved verbatim");

    const hasSpeakers = await fs.readFile(
      path.join(sitePath, "src", "content", "media", "untagged-has-speakers", "index.mdx"),
      "utf8",
    );
    assert.match(hasSpeakers, /speakers: \["Existing Person"\]/u, "existing speakers must not be modified");
    assert.match(hasSpeakers, /topics:\n {2}- Design Tokens/u);

    const alreadyTagged = await fs.readFile(
      path.join(sitePath, "src", "content", "media", "already-tagged", "index.mdx"),
      "utf8",
    );
    assert.equal(
      alreadyTagged,
      `---\ntitle: "Tagged talk"\nvideoUrl: "https://www.youtube.com/watch?v=ccc333"\nlocalImages: true\ndraft: false\ntopics:\n  - Accessibility\n---\n\nBody text.\n`,
      "an already-tagged entry must never be selected for processing",
    );

    const noSpeakersResult = summary.results.find((r) => r.slug === "untagged-no-speakers");
    const hasSpeakersResult = summary.results.find((r) => r.slug === "untagged-has-speakers");
    assert.ok(noSpeakersResult?.changedKeys.includes("speakers"));
    // An entry that already has speakers never even triggers the speaker
    // proposal step, so there's nothing to skip - it's just never asked.
    assert.equal(hasSpeakersResult?.speakerProposal, undefined);
    assert.ok(!hasSpeakersResult?.changedKeys.includes("speakers"));
  } finally {
    await fs.remove(sitePath);
  }
});

test("retagSiteMedia records a failed entry without aborting the batch", async () => {
  const sitePath = await makeFakeSite();
  try {
    const summary = await retagSiteMedia(
      { sitePath, apply: true },
      undefined,
      {
        ingest: async (url: string) => {
          if (url.includes("aaa111")) {
            throw new Error("simulated yt-dlp failure");
          }
          return fakeIngestResult();
        },
        classify: async () => fakeClassification(),
        proposeSpeakers: async () => ({ matched: [], unmatched: [] }),
      },
    );

    assert.equal(summary.processed, 2);
    const failed = summary.results.find((r) => r.slug === "untagged-no-speakers");
    const succeeded = summary.results.find((r) => r.slug === "untagged-has-speakers");
    assert.equal(failed?.success, false);
    assert.match(failed?.error ?? "", /simulated yt-dlp failure/u);
    assert.equal(succeeded?.success, true);
  } finally {
    await fs.remove(sitePath);
  }
});

test("retagSiteMedia respects limit and only filters", async () => {
  const sitePath = await makeFakeSite();
  try {
    const summary = await retagSiteMedia(
      { sitePath, apply: false, only: "no-speakers" },
      undefined,
      {
        ingest: async () => fakeIngestResult(),
        classify: async () => fakeClassification(),
        proposeSpeakers: async () => ({ matched: [], unmatched: [] }),
      },
    );

    assert.equal(summary.totalUntagged, 1);
    assert.equal(summary.results[0]?.slug, "untagged-no-speakers");
  } finally {
    await fs.remove(sitePath);
  }
});

test("writeRetagReport writes a JSON report file that round-trips the summary", async () => {
  const summary = {
    sitePath: "/tmp/site",
    kind: "media" as const,
    applied: false,
    totalUntagged: 0,
    processed: 0,
    results: [],
  };

  const reportsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dsmedia-reports-"));
  try {
    const reportPath = await writeRetagReport(summary, reportsDir);
    assert.ok(await fs.pathExists(reportPath));
    const written = await fs.readJson(reportPath);
    assert.deepEqual(written, summary);
  } finally {
    await fs.remove(reportsDir);
  }
});
