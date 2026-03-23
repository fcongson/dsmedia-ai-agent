import { execa } from "execa";
import { resolveExecutable } from "./runtime.js";

export interface PlaylistEntry {
  id: string;
  url: string;
  title: string;
}

export async function expandPlaylist(url: string): Promise<PlaylistEntry[]> {
  const ytDlp = await resolveExecutable("yt-dlp");

  // --flat-playlist skips downloading anything — just dumps the playlist metadata
  // --print outputs one value per line for each entry
  const result = await execa(ytDlp, [
    "--flat-playlist",
    "--print",
    "%(id)s\t%(title)s",
    url,
  ]);

  const entries: PlaylistEntry[] = [];

  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [id, ...titleParts] = trimmed.split("\t");
    const title = titleParts.join("\t").trim();

    if (!id) continue;

    entries.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: title || id,
    });
  }

  if (entries.length === 0) {
    throw new Error("No videos found. The playlist or channel may be empty, private, or the URL may be invalid.");
  }

  return entries;
}
