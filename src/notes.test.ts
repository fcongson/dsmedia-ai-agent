import test from "node:test";
import assert from "node:assert/strict";
import { loadVideoSummaryFormat, renderVideoSummaryMarkdown } from "./notes.js";
import { createIngestContext } from "./runtime.js";
import type { AnalysisResult } from "./analyze.js";
import type { VideoMetadata } from "./metadata.js";

test("loadVideoSummaryFormat reads the canonical markdown spec", async () => {
  const format = await loadVideoSummaryFormat();
  assert.match(format, /^---\ntype: video-summary/mu);
  assert.match(format, /## Key Takeaways/u);
});

test("renderVideoSummaryMarkdown includes resources and quoted transcript excerpts", () => {
  const context = createIngestContext("https://www.youtube.com/watch?v=abc123def45");
  const analysis: AnalysisResult = {
    id: context.id,
    source_url: context.sourceUrl,
    description: "Read more at https://example.com/resource and https://example.org/tool",
    summary: "A practical walkthrough of a production workflow and why the decisions matter.",
    tags: ["workflow", "ops"],
    key_takeaways: [
      "Automate the boring steps",
      "Keep artifacts deterministic",
      "Prefer reusable formats",
      "Surface references for later review",
    ],
  };
  const metadata: VideoMetadata = {
    id: context.id,
    sourceUrl: context.sourceUrl,
    title: "Example Video",
    channel: "Example Channel",
    uploadDate: "2026-04-06",
    durationSeconds: 600,
    chapters: [
      { title: "Introduction", startTime: 0 },
      { title: "Workflow", startTime: 180 },
    ],
  };
  const transcript = [
    "This is a longer transcript line that clearly captures a concrete point about how the workflow stays deterministic over time.",
    "Another transcript line explains why saving references and artifacts makes later analysis dramatically easier for teams.",
    "A third transcript line talks about writing outputs in a stable format so humans and tools can both reuse them.",
  ].join("\n");

  const markdown = renderVideoSummaryMarkdown({
    context,
    metadata,
    analysis,
    transcript,
    description: analysis.description,
  });

  assert.match(markdown, /^source: https:\/\/www\.youtube\.com\/watch\?v=abc123def45/mu);
  assert.match(markdown, /<iframe width="560" height="315" src="https:\/\/www\.youtube\.com\/embed\/abc123def45"/u);
  assert.match(markdown, /## Notable Quotes/u);
  assert.match(markdown, /## Resources/u);
  assert.match(markdown, /\[example\.com\]\(https:\/\/example\.com\/resource\)/u);
  assert.match(markdown, /\| 03:00 \| Workflow \|/u);
});

test("renderVideoSummaryMarkdown omits resources when there are no substantive links", () => {
  const context = createIngestContext("https://www.youtube.com/watch?v=abc123def45");
  const analysis: AnalysisResult = {
    id: context.id,
    source_url: context.sourceUrl,
    description: null,
    summary: "A concise summary.",
    tags: ["summary"],
    key_takeaways: ["Keep outputs reusable"],
  };
  const metadata: VideoMetadata = {
    id: context.id,
    sourceUrl: context.sourceUrl,
    title: "Example Video",
    channel: "Example Channel",
    uploadDate: null,
    durationSeconds: 120,
    chapters: [],
  };

  const markdown = renderVideoSummaryMarkdown({
    context,
    metadata,
    analysis,
    transcript: "Short transcript line.\nAnother short transcript line.",
    description: null,
  });

  assert.doesNotMatch(markdown, /## Resources/u);
  assert.match(markdown, /## Chapters/u);
});
