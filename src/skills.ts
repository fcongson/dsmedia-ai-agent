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

    await validateSkillFile(manifest);
  }

  validateOperationCoverage(manifests);
}

function skillFilePath(skillId: string): string {
  return path.join(ROOT_DIR, "skills", skillId, "SKILL.md");
}

/** Each manifest must have a skills/<id>/SKILL.md whose frontmatter `name`
 * equals the manifest id, so the machine-readable and human-readable halves
 * of a skill cannot drift apart. */
async function validateSkillFile(manifest: SkillManifest): Promise<void> {
  const filePath = skillFilePath(manifest.id);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Skill ${manifest.id} has no skill file at ${path.relative(ROOT_DIR, filePath)}`);
  }

  const text = await fs.readFile(filePath, "utf8");
  const frontMatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  const nameLine = frontMatter?.[1].match(/^name:\s*(.+)$/mu);
  const name = nameLine?.[1].trim().replace(/^["']|["']$/gu, "");
  if (name !== manifest.id) {
    throw new Error(`Skill file ${path.relative(ROOT_DIR, filePath)} has name "${name ?? "(missing)"}" but its manifest id is "${manifest.id}"`);
  }
}

/** Every registered operation must be covered by at least one skill, so a
 * new tool or command cannot be added without the skills learning about it. */
function validateOperationCoverage(manifests: SkillManifest[]): void {
  const coveredTools = new Set(manifests.flatMap((manifest) => manifest.supportedTools));
  const coveredCommands = new Set(manifests.flatMap((manifest) => manifest.supportedCommands));

  for (const operation of OPERATIONS) {
    if (operation.surfaces.includes("mcp") && !coveredTools.has(operation.id)) {
      throw new Error(`MCP tool ${operation.id} is not covered by any skill manifest (supportedTools)`);
    }
    if (operation.surfaces.includes("cli") && !coveredCommands.has(operation.id)) {
      throw new Error(`CLI command ${operation.id} is not covered by any skill manifest (supportedCommands)`);
    }
  }
}
