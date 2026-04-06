import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createIngestContext, getDataDirs } from "./runtime.js";

test("createIngestContext includes metadata and note artifact paths", () => {
  const context = createIngestContext("https://www.youtube.com/watch?v=abc123def45");
  const { METADATA_DIR, NOTES_DIR } = getDataDirs();

  assert.equal(context.metadataPath, path.resolve(METADATA_DIR, "abc123def45.json"));
  assert.equal(context.notePath, path.resolve(NOTES_DIR, "abc123def45.md"));
});
