import path from "node:path";
import fs from "fs-extra";

const LOCAL_VENV_BIN = path.resolve(".venv/bin");

export async function resolveExecutable(command: string): Promise<string> {
  const pathValue = process.env.PATH ?? "";
  const candidates = pathValue.split(path.delimiter).filter(Boolean);
  candidates.push(LOCAL_VENV_BIN);

  for (const directory of candidates) {
    const executablePath = path.join(directory, command);
    if (await fs.pathExists(executablePath)) {
      return executablePath;
    }
  }

  throw new Error(`Required command is not available: ${command}`);
}
