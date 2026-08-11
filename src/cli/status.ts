import { loadConfig } from "../config.js";
import { readRunnerStatus } from "../status.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const status = readRunnerStatus(config.storage.databasePath);
  console.log(JSON.stringify(status, null, 2));
  if (!status.ready) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`Unable to read AgentRunner status: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
