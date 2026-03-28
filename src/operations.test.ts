import test from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS, getOperationsForSurface } from "./operations.js";

test("operation ids are unique", () => {
  const ids = OPERATIONS.map((operation) => operation.id);
  assert.equal(ids.length, new Set(ids).size);
});

test("mcp operations all provide schemas", () => {
  for (const operation of getOperationsForSurface("mcp")) {
    assert.ok(operation.inputSchema);
  }
});

test("cli operations include canonical ingest commands", () => {
  const cliIds = getOperationsForSurface("cli").map((operation) => operation.id);
  assert.deepEqual(cliIds.sort(), [
    "analyse_transcript",
    "download_audio",
    "expand_playlist",
    "fetch_subtitles",
    "ingest_batch",
    "ingest_video",
    "parse_video_id",
    "transcribe_audio",
  ]);
});
