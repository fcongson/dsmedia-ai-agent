import path from "node:path";
import fs from "fs-extra";
import { ROOT_DIR } from "./runtime.js";
import { OPERATIONS } from "./operations.js";

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  supportedTools: string[];
  supportedCommands: string[];
  artifacts: string[];
  defaults: {
    llmProfile: string;
    transcriptStrategy: string;
  };
  portabilityTargets: string[];
}

function manifestsDir(): string {
  return path.join(ROOT_DIR, "skill");
}

export async function loadSkillManifests(): Promise<SkillManifest[]> {
  const files = await fs.readdir(manifestsDir());
  const manifestFiles = files.filter((file) => file.endsWith(".manifest.json")).sort();
  const manifests: SkillManifest[] = [];

  for (const file of manifestFiles) {
    manifests.push((await fs.readJson(path.join(manifestsDir(), file))) as SkillManifest);
  }

  return manifests;
}

export async function validateSkillManifests(): Promise<void> {
  const manifests = await loadSkillManifests();
  const operationMap = new Map(OPERATIONS.map((operation) => [operation.id, operation]));

  for (const manifest of manifests) {
    for (const toolId of manifest.supportedTools) {
      const operation = operationMap.get(toolId);
      if (!operation) {
        throw new Error(`Skill ${manifest.id} references unknown tool: ${toolId}`);
      }
      if (!operation.surfaces.includes("mcp")) {
        throw new Error(`Skill ${manifest.id} references non-MCP tool as a supported tool: ${toolId}`);
      }
    }

    for (const commandId of manifest.supportedCommands) {
      const operation = operationMap.get(commandId);
      if (!operation) {
        throw new Error(`Skill ${manifest.id} references unknown command: ${commandId}`);
      }
      if (!operation.surfaces.includes("cli")) {
        throw new Error(`Skill ${manifest.id} references non-CLI command: ${commandId}`);
      }
    }
  }
}
