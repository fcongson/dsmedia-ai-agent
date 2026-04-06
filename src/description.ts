import { execa } from "execa";
import fs from "fs-extra";
import { getDataDirs, type IngestContext, resolveExecutable } from "./runtime.js";

export async function readCachedDescription(context: IngestContext): Promise<string | null> {
  const exists = await fs.pathExists(context.descriptionPath);
  if (!exists) {
    return null;
  }

  const description = (await fs.readFile(context.descriptionPath, "utf8")).trim();
  return description || null;
}

export async function fetchDescription(context: IngestContext): Promise<string | null> {
  const { DESCRIPTIONS_DIR } = getDataDirs();
  await fs.ensureDir(DESCRIPTIONS_DIR);
  await fs.remove(context.descriptionPath);
  const ytDlp = await resolveExecutable("yt-dlp");

  const result = await execa(ytDlp, ["--print", "description", context.sourceUrl], { reject: false });
  const description = result.stdout.trim();

  if (result.exitCode !== 0 || !description) {
    return null;
  }

  await fs.writeFile(context.descriptionPath, `${description}\n`, "utf8");
  return description;
}

export async function ensureDescription(context: IngestContext): Promise<string | null> {
  const cachedDescription = await readCachedDescription(context);
  if (cachedDescription) {
    return cachedDescription;
  }

  return fetchDescription(context);
}
