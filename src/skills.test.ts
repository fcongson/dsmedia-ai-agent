import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "fs-extra";
import { ROOT_DIR } from "./runtime.js";
import { loadSkillManifests, validateSkillManifests } from "./skills.js";

test("skill manifests load", async () => {
  const manifests = await loadSkillManifests();
  assert.ok(manifests.length >= 6);
});

test("skill manifests reference valid tools and commands", async () => {
  await validateSkillManifests();
});

test("every skill manifest has a matching skills/<id>/SKILL.md", async () => {
  const manifests = await loadSkillManifests();
  for (const manifest of manifests) {
    const filePath = path.join(ROOT_DIR, "skills", manifest.id, "SKILL.md");
    assert.ok(await fs.pathExists(filePath), `missing ${filePath}`);
  }
});
