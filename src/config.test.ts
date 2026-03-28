import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LLM_PROFILES, resolveLlmConfig } from "./config.js";

test("resolveLlmConfig prefers env over project config and defaults", async () => {
  const config = await resolveLlmConfig({
    projectConfig: {
      llm: {
        profile: "fast",
        baseUrl: "http://example.test",
      },
    },
    env: {
      DSMEDIA_LLM_PROFILE: "quality",
      DSMEDIA_LLM_TEMPERATURE: "0.7",
    },
  });

  assert.equal(config.profile, "quality");
  assert.equal(config.baseUrl, "http://example.test");
  assert.equal(config.temperature, 0.7);
});

test("resolveLlmConfig applies explicit overrides last", async () => {
  const config = await resolveLlmConfig({
    projectConfig: {
      llm: {
        profile: "balanced",
      },
    },
    overrides: {
      model: "custom:model",
    },
  });

  assert.equal(config.model, "custom:model");
  assert.equal(config.profile, "balanced");
});

test("balanced profile resolves to the verified local default model", () => {
  assert.equal(DEFAULT_LLM_PROFILES.balanced.model, "llama3.1:8b");
});
