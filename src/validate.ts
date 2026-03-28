import { getOperationById, getOperationsForSurface, OPERATIONS } from "./operations.js";
import { resolveLlmConfig, DEFAULT_LLM_PROFILES } from "./config.js";
import { validateSkillManifests } from "./skills.js";

async function run(): Promise<void> {
  const ids = new Set<string>();
  for (const operation of OPERATIONS) {
    if (ids.has(operation.id)) {
      throw new Error(`Duplicate operation id: ${operation.id}`);
    }
    ids.add(operation.id);
  }

  for (const operation of getOperationsForSurface("mcp")) {
    if (!operation.inputSchema) {
      throw new Error(`MCP operation missing input schema: ${operation.id}`);
    }
  }

  for (const operation of getOperationsForSurface("cli")) {
    if (!getOperationById(operation.id)) {
      throw new Error(`CLI operation not found in registry: ${operation.id}`);
    }
    if (!operation.cli) {
      throw new Error(`CLI operation is missing a CLI adapter: ${operation.id}`);
    }
  }

  const config = await resolveLlmConfig();
  if (config.profile && !DEFAULT_LLM_PROFILES[config.profile]) {
    throw new Error(`Default profile is invalid: ${config.profile}`);
  }

  await validateSkillManifests();
}

run().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
