import { runCli } from "./cli.js";

runCli(["ingest_video", process.argv[2]]).catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
