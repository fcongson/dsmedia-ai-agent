import path from "node:path";
import { execa } from "execa";
import fs from "fs-extra";
import { resolveExecutable } from "./runtime.js";

const AUDIO_DIR = path.resolve("data/audio");
const AUDIO_FILE = path.resolve(AUDIO_DIR, "video.mp3");

export async function downloadVideo(url: string): Promise<string> {
  await fs.ensureDir(AUDIO_DIR);
  await fs.remove(AUDIO_FILE);
  const ytDlp = await resolveExecutable("yt-dlp");

  await execa(ytDlp, [
    "-x",
    "--audio-format",
    "mp3",
    "-o",
    path.join("data", "audio", "video.%(ext)s"),
    url,
  ]);

  const exists = await fs.pathExists(AUDIO_FILE);
  if (!exists) {
    throw new Error(`Expected audio file was not created: ${AUDIO_FILE}`);
  }

  return AUDIO_FILE;
}

export { AUDIO_DIR, AUDIO_FILE };
