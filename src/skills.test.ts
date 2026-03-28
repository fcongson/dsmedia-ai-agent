import test from "node:test";
import assert from "node:assert/strict";
import { loadSkillManifests, validateSkillManifests } from "./skills.js";

test("skill manifests load", async () => {
  const manifests = await loadSkillManifests();
  assert.ok(manifests.length >= 2);
});

test("skill manifests reference valid tools and commands", async () => {
  await validateSkillManifests();
});
