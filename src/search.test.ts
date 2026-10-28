import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { buildAnswerPrompt, cosineSimilarity, embeddingText, findContent, loadSearchCorpus, type SearchCorpusEntry } from "./search.js";
import type { LlmConfig } from "./config.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("cosineSimilarity returns 1 for identical vectors and 0 for orthogonal vectors", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity returns 0 for mismatched lengths or zero vectors instead of throwing", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test("embeddingText joins title, summary, tags, and key takeaways, skipping a missing title", () => {
  const withTitle: SearchCorpusEntry = {
    id: "a",
    sourceUrl: "https://example.test/a",
    title: "A Talk",
    summary: "A summary.",
    tags: ["Tokens", "Figma"],
    keyTakeaways: ["Takeaway one", "Takeaway two"],
  };
  const text = embeddingText(withTitle);
  assert.ok(text.includes("A Talk"));
  assert.ok(text.includes("A summary."));
  assert.ok(text.includes("Tokens, Figma"));
  assert.ok(text.includes("Takeaway one. Takeaway two"));

  const noTitle: SearchCorpusEntry = { ...withTitle, title: null };
  assert.ok(!embeddingText(noTitle).includes("A Talk"));
});

test("buildAnswerPrompt includes the query, every match's title and URL, and an anti-hallucination instruction", () => {
  const prompt = buildAnswerPrompt("design tokens for beginners", [
    { id: "a", sourceUrl: "https://example.test/a", title: "Tokens 101", summary: "s", tags: [], keyTakeaways: [], score: 0.9 },
  ]);
  assert.ok(prompt.includes("design tokens for beginners"));
  assert.ok(prompt.includes("Tokens 101"));
  assert.ok(prompt.includes("https://example.test/a"));
  assert.ok(/don't invent|do not invent/iu.test(prompt));
});

test("loadSearchCorpus reads analysis artifacts, joins titles from metadata, and skips malformed files", async () => {
  const analysisDir = await makeTempDir("dsmedia-analysis-");
  const metadataDir = await makeTempDir("dsmedia-metadata-");
  try {
    await fs.outputJson(path.join(analysisDir, "aaa111.json"), {
      id: "aaa111",
      source_url: "https://www.youtube.com/watch?v=aaa111",
      description: "d",
      summary: "A talk about accessibility testing.",
      tags: ["Accessibility"],
      key_takeaways: ["Test early"],
    });
    await fs.outputJson(path.join(metadataDir, "aaa111.json"), { title: "Accessibility Testing 101" });

    // No matching metadata file - title should fall back to null, not throw.
    await fs.outputJson(path.join(analysisDir, "bbb222.json"), {
      id: "bbb222",
      source_url: "https://www.youtube.com/watch?v=bbb222",
      description: null,
      summary: "A talk about component tooling.",
      tags: ["Tooling"],
      key_takeaways: [],
    });

    // Malformed - missing required fields, must be skipped rather than throw.
    await fs.outputJson(path.join(analysisDir, "corrupt.json"), { summary: "incomplete" });

    const corpus = await loadSearchCorpus({ analysisDir, metadataDir });
    assert.equal(corpus.length, 2);

    const first = corpus.find((entry) => entry.id === "aaa111");
    assert.equal(first?.title, "Accessibility Testing 101");

    const second = corpus.find((entry) => entry.id === "bbb222");
    assert.equal(second?.title, null);
  } finally {
    await fs.remove(analysisDir);
    await fs.remove(metadataDir);
  }
});

test("loadSearchCorpus returns an empty array when the analysis directory doesn't exist", async () => {
  const corpus = await loadSearchCorpus({ analysisDir: path.join(os.tmpdir(), "does-not-exist-dsmedia"), metadataDir: os.tmpdir() });
  assert.deepEqual(corpus, []);
});

function fakeConfig(): LlmConfig {
  return {
    provider: "ollama",
    baseUrl: "http://fake",
    profile: "balanced",
    temperature: 0.2,
    structuredOutput: true,
    embeddingModel: "nomic-embed-text",
  };
}

// Deterministic stand-in for a real embedding: counts how many times each of
// a few marker words appears in the text, lowercased. Good enough to assert
// ranking and caching behavior without a running Ollama.
const MARKER_WORDS = ["accessibility", "tooling", "token"];
async function fakeEmbed(_config: LlmConfig, _model: string, text: string): Promise<number[]> {
  const lower = text.toLowerCase();
  return MARKER_WORDS.map((word) => (lower.match(new RegExp(word, "gu")) ?? []).length);
}

test("findContent ranks the corpus by relevance and grounds the answer in the top matches", async () => {
  const analysisDir = await makeTempDir("dsmedia-analysis-");
  const metadataDir = await makeTempDir("dsmedia-metadata-");
  const embeddingsDir = await makeTempDir("dsmedia-embeddings-");
  try {
    await fs.outputJson(path.join(analysisDir, "a11.json"), {
      id: "a11",
      source_url: "https://www.youtube.com/watch?v=a11",
      description: null,
      summary: "Accessibility accessibility testing for design systems.",
      tags: [],
      key_takeaways: [],
    });
    await fs.outputJson(path.join(metadataDir, "a11.json"), { title: "Accessibility Testing Deep Dive" });
    await fs.outputJson(path.join(analysisDir, "b22.json"), {
      id: "b22",
      source_url: "https://www.youtube.com/watch?v=b22",
      description: null,
      summary: "Component tooling and build pipelines.",
      tags: [],
      key_takeaways: [],
    });
    await fs.outputJson(path.join(metadataDir, "b22.json"), { title: "Component Tooling Overview" });

    let answerPrompt = "";
    const result = await findContent("how do I test for accessibility", {
      analysisDir,
      metadataDir,
      embeddingsDir,
      dependencies: {
        ensureReachable: async () => {},
        resolveModel: async () => "fake-model",
        resolveEmbeddingModel: async () => "fake-embed-model",
        embed: fakeEmbed,
        generateAnswer: async (_config, _model, prompt) => {
          answerPrompt = prompt;
          return "Go watch the accessibility one.";
        },
      },
    });

    assert.equal(result.matches[0].id, "a11");
    assert.ok(result.matches[0].score > (result.matches[1]?.score ?? 0));
    assert.ok(answerPrompt.includes("Accessibility Testing Deep Dive"));
    assert.ok(answerPrompt.includes("https://www.youtube.com/watch?v=a11"));
    assert.equal(result.answer, "Go watch the accessibility one.");
  } finally {
    await fs.remove(analysisDir);
    await fs.remove(metadataDir);
    await fs.remove(embeddingsDir);
  }
});

test("findContent caches corpus embeddings so an unchanged entry isn't re-embedded on a later search", async () => {
  const analysisDir = await makeTempDir("dsmedia-analysis-");
  const metadataDir = await makeTempDir("dsmedia-metadata-");
  const embeddingsDir = await makeTempDir("dsmedia-embeddings-");
  try {
    await fs.outputJson(path.join(analysisDir, "a11.json"), {
      id: "a11",
      source_url: "https://www.youtube.com/watch?v=a11",
      description: null,
      summary: "Accessibility testing for design systems.",
      tags: [],
      key_takeaways: [],
    });

    let embedCalls = 0;
    const dependencies = {
      ensureReachable: async () => {},
      resolveModel: async () => "fake-model",
      resolveEmbeddingModel: async () => "fake-embed-model",
      embed: async (config: LlmConfig, model: string, text: string) => {
        embedCalls += 1;
        return fakeEmbed(config, model, text);
      },
      generateAnswer: async () => "answer",
    };

    await findContent("accessibility", { analysisDir, metadataDir, embeddingsDir, dependencies });
    assert.equal(embedCalls, 2); // 1 corpus entry + 1 query

    await findContent("accessibility", { analysisDir, metadataDir, embeddingsDir, dependencies });
    assert.equal(embedCalls, 3); // corpus entry reused from cache, only the query re-embedded
  } finally {
    await fs.remove(analysisDir);
    await fs.remove(metadataDir);
    await fs.remove(embeddingsDir);
  }
});

test("findContent returns a plain message instead of calling the model when the corpus is empty", async () => {
  const analysisDir = await makeTempDir("dsmedia-analysis-");
  try {
    let called = false;
    const result = await findContent("anything", {
      analysisDir,
      dependencies: {
        ensureReachable: async () => {
          called = true;
        },
        resolveModel: async () => "fake-model",
        resolveEmbeddingModel: async () => "fake-embed-model",
        embed: fakeEmbed,
        generateAnswer: async () => "unused",
      },
    });

    assert.equal(result.matches.length, 0);
    assert.ok(/no analyzed videos/iu.test(result.answer));
    assert.equal(called, false);
  } finally {
    await fs.remove(analysisDir);
  }
});

test("findContent rejects a blank query", async () => {
  await assert.rejects(() => findContent("   "));
});
