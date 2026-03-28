import { getOperationById, getOperationsForSurface } from "./operations.js";
import { ensureDependencies, type ProgressLogger } from "./pipeline.js";

function formatUsage(): string {
  const commandLines = getOperationsForSurface("cli")
    .map((operation) => operation.cli?.usage)
    .filter(Boolean) as string[];

  return ["Usage:", ...commandLines.map((line) => `  ${line}`)].join("\n");
}

export async function parseCliInvocation(argv = process.argv.slice(2)): Promise<{
  command: string;
  input: unknown;
  requiredDependencies: Array<"yt-dlp" | "whisper" | "ollama">;
}> {
  const [command, ...args] = argv;
  if (!command) {
    throw new Error(formatUsage());
  }

  const operation = getOperationById(command);
  if (!operation || !operation.surfaces.includes("cli") || !operation.cli) {
    throw new Error(`Unknown command: ${command}\n\n${formatUsage()}`);
  }

  return {
    command,
    input: await operation.cli.parseArgs(args),
    requiredDependencies: operation.cli.requiredDependencies,
  };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const log: ProgressLogger = (message) => console.error(`[dsmedia-ai-agent] ${message}`);
  const invocation = await parseCliInvocation(argv);
  const operation = getOperationById(invocation.command);
  if (!operation || !operation.cli) {
    throw new Error(`Unknown command: ${invocation.command}\n\n${formatUsage()}`);
  }

  await ensureDependencies(invocation.requiredDependencies, log);
  const result = operation.cli.run
    ? await operation.cli.run(invocation.input as never, log)
    : await operation.handler(invocation.input as never);

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
