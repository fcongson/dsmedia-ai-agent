import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { getDataDirs, type IngestContext, resolveExecutable } from "./runtime.js";

export async function downloadVideo(context: IngestContext): Promise<string> {
  const { AUDIO_DIR } = getDataDirs();
  await fs.ensureDir(AUDIO_DIR);
  await fs.remove(context.audioPath);
  const ytDlp = await resolveExecutable("yt-dlp");

  await execa(ytDlp, [
    "-x",
    "--audio-format",
    "mp3",
    "-o",
    path.join(AUDIO_DIR, `${context.id}.%(ext)s`),
    context.sourceUrl,
  ]);

  const exists = await fs.pathExists(context.audioPath);
  if (!exists) {
    throw new Error(`Expected audio file was not created: ${context.audioPath}`);
  }

  return context.audioPath;
}
