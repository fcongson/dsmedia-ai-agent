import path from "node:path";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs-extra";
import { parseCliInvocation } from "./cli.js";

test("parseCliInvocation parses url-only commands", async () => {
  const invocation = await parseCliInvocation([
    "parse_video_id",
    "https://www.youtube.com/watch?v=abc123def45",
  ]);

  assert.equal(invocation.command, "parse_video_id");
  assert.deepEqual(invocation.input, { url: "https://www.youtube.com/watch?v=abc123def45" });
  assert.deepEqual(invocation.requiredDependencies, []);
});

test("parseCliInvocation parses fetch_description", async () => {
  const invocation = await parseCliInvocation([
    "fetch_description",
    "https://www.youtube.com/watch?v=abc123def45",
  ]);

  assert.equal(invocation.command, "fetch_description");
  assert.deepEqual(invocation.input, { url: "https://www.youtube.com/watch?v=abc123def45" });
  assert.deepEqual(invocation.requiredDependencies, ["yt-dlp"]);
});

test("parseCliInvocation loads transcript content from file for analyse_transcript", async () => {
  const transcriptPath = path.join(os.tmpdir(), `dsmedia-cli-test-${Date.now()}.txt`);
  await fs.writeFile(transcriptPath, "hello transcript\n", "utf8");

  try {
    const invocation = await parseCliInvocation([
      "analyse_transcript",
      "https://www.youtube.com/watch?v=abc123def45",
      transcriptPath,
    ]);

    assert.equal(invocation.command, "analyse_transcript");
    assert.deepEqual(invocation.input, {
      url: "https://www.youtube.com/watch?v=abc123def45",
      transcript: "hello transcript",
    });
    assert.deepEqual(invocation.requiredDependencies, ["ollama"]);
  } finally {
    await fs.remove(transcriptPath);
  }
});

test("parseCliInvocation rejects missing transcript file argument", async () => {
  await assert.rejects(
    () => parseCliInvocation(["analyse_transcript", "https://www.youtube.com/watch?v=abc123def45"]),
    /Missing required argument: transcript-file/u,
  );
});

test("parseCliInvocation rejects unknown commands", async () => {
  await assert.rejects(
    () => parseCliInvocation(["does_not_exist"]),
    /Unknown command: does_not_exist/u,
  );
});
