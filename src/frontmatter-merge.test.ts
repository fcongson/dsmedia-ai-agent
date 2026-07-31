import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFrontMatterMerge,
  hasTopLevelKey,
  mergeFrontMatterFields,
  parseExistingArrayValue,
  splitFrontMatter,
} from "./frontmatter-merge.js";

const SAMPLE_FILE = `---
title: "10: Design System Consulting"
publishedAt: "2023-03-22T16:00:02Z"
image: "./poster.jpg"
poster: "./poster.jpg"
videoUrl: "https://www.youtube.com/watch?v=5sEQzF7tgmk"
localImages: true
tags: ["Consulting"]
categories: ["Video"]
duration: "0:27:46"
draft: false
speakers: ["Ben Callahan"]
---

We're joined by Ben Callahan, who shares his experience.
`;

test("splitFrontMatter separates frontmatter block from body", () => {
  const split = splitFrontMatter(SAMPLE_FILE);
  assert.ok(split);
  assert.match(split!.frontMatter, /^title:/u);
  assert.match(split!.body, /We're joined by Ben Callahan/u);
});

test("splitFrontMatter returns null when there is no frontmatter block", () => {
  assert.equal(splitFrontMatter("# Just a heading\n"), null);
});

test("parseExistingArrayValue reads flow-style arrays", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  const lines = split.frontMatter.split("\n");
  const range = { key: "tags", start: lines.findIndex((l) => l.startsWith("tags:")), end: lines.length };
  range.end = lines.findIndex((l, i) => i > range.start && /^[A-Za-z_]/u.test(l));
  assert.deepEqual(parseExistingArrayValue(lines, range), ["Consulting"]);
});

test("mergeFrontMatterFields appends a brand-new key as a block list", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  const result = mergeFrontMatterFields(split.frontMatter, {
    topics: ["Consulting", "Career"],
    series: [],
  });

  assert.deepEqual(result.changedKeys, ["topics"]);
  assert.match(result.frontMatter, /\ntopics:\n {2}- Consulting\n {2}- Career/u);
});

test("mergeFrontMatterFields merges new unique values into an existing block list without touching existing formatting", () => {
  const withBlockTopics = `title: "x"
topics:
  - Accessibility
  - Governance
draft: false`;

  const result = mergeFrontMatterFields(withBlockTopics, { topics: ["governance", "AI"] });
  assert.deepEqual(result.changedKeys, ["topics"]);
  assert.match(result.frontMatter, /topics:\n {2}- Accessibility\n {2}- Governance\n {2}- AI/u);
  // Case-insensitive duplicate ("governance") must not be re-added.
  const occurrences = result.frontMatter.match(/Governance/giu) ?? [];
  assert.equal(occurrences.length, 1);
});

test("mergeFrontMatterFields merges into an existing flow-style array and preserves other keys untouched", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  const result = mergeFrontMatterFields(split.frontMatter, { tags: ["Consulting", "Sparkbox"] });

  assert.deepEqual(result.changedKeys, ["tags"]);
  assert.match(result.frontMatter, /tags:\n {2}- Consulting\n {2}- Sparkbox/u);
  // Untouched keys keep their original quoting/style exactly.
  assert.match(result.frontMatter, /title: "10: Design System Consulting"/u);
  assert.match(result.frontMatter, /speakers: \["Ben Callahan"\]/u);
});

test("mergeFrontMatterFields is a no-op when all candidate values already exist", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  const result = mergeFrontMatterFields(split.frontMatter, { tags: ["consulting"] });
  assert.deepEqual(result.changedKeys, []);
  assert.equal(result.frontMatter, split.frontMatter);
});

test("mergeFrontMatterFields respects skipIfPresent and never touches an existing speakers list", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  const result = mergeFrontMatterFields(
    split.frontMatter,
    { speakers: ["Someone Else"] },
    { skipIfPresent: ["speakers"] },
  );

  assert.deepEqual(result.changedKeys, []);
  assert.deepEqual(result.skippedKeys, ["speakers"]);
  assert.match(result.frontMatter, /speakers: \["Ben Callahan"\]/u);
});

test("mergeFrontMatterFields adds speakers when the key is entirely absent", () => {
  const withoutSpeakers = `title: "x"
draft: false`;
  const result = mergeFrontMatterFields(withoutSpeakers, { speakers: ["New Person"] }, { skipIfPresent: ["speakers"] });
  assert.deepEqual(result.changedKeys, ["speakers"]);
  assert.match(result.frontMatter, /speakers:\n {2}- New Person/u);
});

test("mergeFrontMatterFields quotes values that need it and leaves safe values bare", () => {
  const result = mergeFrontMatterFields("title: \"x\"", {
    topics: ["Design Tokens", "ROI: it matters", "2025"],
  });
  assert.match(result.frontMatter, / {2}- Design Tokens/u);
  assert.match(result.frontMatter, / {2}- "ROI: it matters"/u);
  assert.match(result.frontMatter, / {2}- "2025"/u);
});

test("hasTopLevelKey detects presence and emptiness correctly", () => {
  const split = splitFrontMatter(SAMPLE_FILE)!;
  assert.equal(hasTopLevelKey(split.frontMatter, "speakers"), true);
  assert.equal(hasTopLevelKey(split.frontMatter, "series"), false);
  assert.equal(hasTopLevelKey(split.frontMatter, "speakers", { requireNonEmpty: true }), true);
});

test("applyFrontMatterMerge reassembles the full file and leaves the body untouched", () => {
  const result = applyFrontMatterMerge(SAMPLE_FILE, { topics: ["Career"] });
  assert.ok(result);
  assert.deepEqual(result!.changedKeys, ["topics"]);
  assert.match(result!.text, /We're joined by Ben Callahan/u);
  assert.match(result!.text, /^---\n/u);
});

test("applyFrontMatterMerge returns null for files without frontmatter", () => {
  assert.equal(applyFrontMatterMerge("no frontmatter here", { topics: ["Career"] }), null);
});
