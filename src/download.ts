import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { AUDIO_DIR, type IngestContext, resolveExecutable } from "./runtime.js";

export async function downloadVideo(context: IngestContext): Promise<string> {
  await fs.ensureDir(AUDIO_DIR);
  await fs.remove(context.audioPath);
  const ytDlp = await resolveExecutable("yt-dlp");

  await execa(ytDlp, [
    "-x",
    "--audio-format",
    "mp3",
    "-o",
    path.join("data", "audio", `${context.id}.%(ext)s`),
    context.sourceUrl,
  ]);

  const exists = await fs.pathExists(context.audioPath);
  if (!exists) {
    throw new Error(`Expected audio file was not created: ${context.audioPath}`);
  }

  return context.audioPath;
}
