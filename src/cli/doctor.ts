import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig, loadSecrets } from "../config.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const checks: Array<{ name: string; run: () => Promise<string> }> = [];
  const config = await loadConfig();
  const secrets = loadSecrets(config);
  checks.push({
    name: "working repository",
    run: async () => {
      await access(config.openCode.workingRepository);
      const result = await execFileAsync("git", ["-C", config.openCode.workingRepository, "rev-parse", "--verify", "HEAD"]);
      return result.stdout.trim().slice(0, 12);
    },
  });
  checks.push({
    name: "OpenCode health and authentication",
    run: async () => {
      const authorization = `Basic ${Buffer.from(`${config.openCode.username}:${secrets.openCodePassword}`).toString("base64")}`;
      const response = await fetch(`${config.openCode.baseUrl}/global/health`, {
        headers: { authorization },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = (await response.json()) as { healthy?: boolean; version?: string };
      if (!health.healthy) throw new Error("server reported unhealthy");
      return health.version ?? "healthy";
    },
  });
  if (config.slack.enabled) {
    checks.push({
      name: "Slack token shapes",
      run: async () => {
        if (!secrets.slackBotToken?.startsWith("xoxb-")) throw new Error("SLACK_BOT_TOKEN must start with xoxb-");
        if (!secrets.slackAppToken?.startsWith("xapp-")) throw new Error("SLACK_APP_TOKEN must start with xapp-");
        return "present";
      },
    });
  }

  let failed = false;
  for (const check of checks) {
    try {
      console.log(`PASS ${check.name}: ${await check.run()}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
