import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSpeakerPrompt,
  buildTaxonomyPrompt,
  findOverCapFields,
  MAX_SELECTIONS,
  matchKnownSpeaker,
  parseSpeakerResponse,
  parseTaxonomyResponse,
  validateTaxonomyResponse,
} from "./classify.js";
import type { SiteTaxonomy } from "./site.js";

const TAXONOMY: SiteTaxonomy = {
  series: ["Design Systems London", "Converge"],
  topics: ["Design Tokens", "Accessibility", "AI"],
  tools: ["Figma", "Storybook"],
  systems: ["Spectrum", "Polaris"],
};

test("buildTaxonomyPrompt embeds every closed-list value so the model can only pick from them", () => {
  const prompt = buildTaxonomyPrompt(
    { title: "t", description: "d", summary: "s", keyTakeaways: [], freeformTags: [], existingTags: [] },
    TAXONOMY,
  );
  for (const value of [...TAXONOMY.series, ...TAXONOMY.topics, ...TAXONOMY.tools, ...TAXONOMY.systems]) {
    assert.ok(prompt.includes(value), `prompt should include ${value}`);
  }
});

test("buildTaxonomyPrompt states an explicit numeric cap for every field", () => {
  const prompt = buildTaxonomyPrompt(
    { title: "t", description: "d", summary: "s", keyTakeaways: [], freeformTags: [], existingTags: [] },
    TAXONOMY,
  );
  for (const max of Object.values(MAX_SELECTIONS)) {
    assert.ok(prompt.includes(`AT MOST ${max}`), `prompt should state the cap of ${max}`);
  }
});

test("parseTaxonomyResponse extracts JSON from a fenced code block", () => {
  const raw = "```json\n{\"series\":[],\"topics\":[\"AI\"],\"tools\":[],\"systems\":[],\"tags\":[\"Something Else\"]}\n```";
  const parsed = parseTaxonomyResponse(raw);
  assert.deepEqual(parsed.topics, ["AI"]);
  assert.deepEqual(parsed.tags, ["Something Else"]);
});

test("parseTaxonomyResponse throws on malformed JSON", () => {
  assert.throws(() => parseTaxonomyResponse("not json at all"));
});

test("parseTaxonomyResponse throws when the shape doesn't match", () => {
  assert.throws(() => parseTaxonomyResponse('{"topics": "AI"}'));
});

test("validateTaxonomyResponse keeps only values that exist verbatim (case-insensitively) in the closed lists", () => {
  const result = validateTaxonomyResponse(
    {
      series: ["converge", "Made Up Conference"],
      topics: ["Design Tokens", "Design tokens", "Blockchain"],
      tools: ["figma"],
      systems: [],
      tags: ["Consulting"],
    },
    TAXONOMY,
  );

  assert.deepEqual(result.series, ["Converge"]);
  assert.deepEqual(result.topics, ["Design Tokens"]);
  assert.deepEqual(result.tools, ["Figma"]);
  assert.deepEqual(result.systems, []);
  // Unmatched closed-list guesses fall through to tags instead of vanishing.
  assert.ok(result.tags.includes("Made Up Conference"));
  assert.ok(result.tags.includes("Blockchain"));
  assert.ok(result.tags.includes("Consulting"));
  assert.deepEqual(result.droppedValues.sort(), ["Blockchain", "Made Up Conference"].sort());
});

test("validateTaxonomyResponse de-duplicates tags case-insensitively", () => {
  const result = validateTaxonomyResponse(
    { series: [], topics: [], tools: [], systems: [], tags: ["Consulting", "consulting"] },
    TAXONOMY,
  );
  assert.deepEqual(result.tags, ["Consulting"]);
});

test("buildSpeakerPrompt includes title and description text", () => {
  const prompt = buildSpeakerPrompt({ title: "Chat with Jane Doe", description: "Jane talks about tokens." });
  assert.ok(prompt.includes("Chat with Jane Doe"));
  assert.ok(prompt.includes("Jane talks about tokens."));
});

test("parseSpeakerResponse returns an empty array for unparseable output", () => {
  assert.deepEqual(parseSpeakerResponse("no json here"), []);
});

test("parseSpeakerResponse extracts names", () => {
  assert.deepEqual(parseSpeakerResponse('{"speakers": ["Jane Doe"]}'), ["Jane Doe"]);
});

test("matchKnownSpeaker finds an exact case/punctuation-insensitive match", () => {
  const result = matchKnownSpeaker("ben callahan", ["Ben Callahan", "Jina Anne"]);
  assert.equal(result.match, "Ben Callahan");
  assert.equal(result.distance, 0);
});

test("matchKnownSpeaker fuzzy-matches a small typo", () => {
  const result = matchKnownSpeaker("Ben Calahan", ["Ben Callahan", "Jina Anne"]);
  assert.equal(result.match, "Ben Callahan");
});

test("matchKnownSpeaker refuses to match a genuinely new name", () => {
  const result = matchKnownSpeaker("Someone Completely New", ["Ben Callahan", "Jina Anne"]);
  assert.equal(result.match, null);
});

test("findOverCapFields is empty for a normal, selective result", () => {
  const result = validateTaxonomyResponse(
    { series: ["Converge"], topics: ["Design Tokens", "AI"], tools: ["Figma"], systems: [], tags: [] },
    TAXONOMY,
  );
  assert.deepEqual(findOverCapFields(result), []);
});

test("findOverCapFields flags a field that blew past its cap - reproduces the real list-echoing failure mode", () => {
  // Regression case: llama3.1:8b once returned 51 of 60 topics verbatim for
  // a single video instead of the 2-3 that were actually central to it.
  const bigTaxonomy = {
    series: [],
    topics: Array.from({ length: 60 }, (_, i) => `Topic ${i}`),
    tools: [],
    systems: [],
  };
  const result = validateTaxonomyResponse(
    { series: [], topics: bigTaxonomy.topics.slice(0, 51), tools: [], systems: [], tags: [] },
    bigTaxonomy,
  );
  assert.deepEqual(findOverCapFields(result), ["topics"]);
});
