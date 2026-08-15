import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig, loadSecrets } from "../config.js";
import { unprivilegedChildEnvironment } from "../environment.js";
import { parseHealth } from "../opencode-protocol.js";
import { assertApprovedOpenCodeVersion } from "../opencode-version.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const checks: Array<{ name: string; run: () => Promise<string> }> = [];
  const config = await loadConfig();
  const secrets = loadSecrets(config);
  checks.push({
    name: "working repository",
    run: async () => {
      await access(config.workingRepository);
      const result = await execFileAsync(
        "git",
        ["-C", config.workingRepository, "rev-parse", "--verify", "HEAD"],
        { env: unprivilegedChildEnvironment() },
      );
      return result.stdout.trim().slice(0, 12);
    },
  });
  if (config.executor === "opencode") {
    checks.push({
      name: "OpenCode health and authentication",
      run: async () => {
        const authorization = `Basic ${Buffer.from(`${config.openCode.username}:${secrets.openCodePassword}`).toString("base64")}`;
        const response = await fetch(`${config.openCode.baseUrl}/global/health`, {
          headers: { authorization },
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const health = parseHealth(await response.json());
        assertApprovedOpenCodeVersion(health.version, config.openCode.approvedVersions);
        return health.version;
      },
    });
  } else {
    checks.push({
      name: "Claude Code SDK configuration",
      run: async () => {
        if (config.claudeCode.executablePath) await access(config.claudeCode.executablePath);
        return config.claudeCode.executablePath ?? "SDK bundled executable";
      },
    });
  }
  if (config.slack.enabled) {
    checks.push({
      name: "Slack credential shapes",
      run: async () => {
        if (!secrets.slackBotToken?.startsWith("xoxb-")) throw new Error("SLACK_BOT_TOKEN must start with xoxb-");
        if (config.slack.ingress === "socket") {
          if (!secrets.slackAppToken?.startsWith("xapp-")) throw new Error("SLACK_APP_TOKEN must start with xapp-");
        } else if (!secrets.slackSigningSecret?.trim()) {
          throw new Error("SLACK_SIGNING_SECRET must be non-empty");
        }
        return config.slack.ingress;
      },
    });
  }
  if (config.discord.enabled) {
    checks.push({
      name: "Discord credential shapes",
      run: async () => {
        if (!secrets.discordBotToken?.trim()) throw new Error("DISCORD_BOT_TOKEN must be non-empty");
        if (config.discord.ingress === "http" && (!secrets.discordPublicKey || !/^[0-9a-f]{64}$/i.test(secrets.discordPublicKey))) {
          throw new Error("DISCORD_PUBLIC_KEY must be a 64-character hexadecimal Ed25519 public key");
        }
        return `${config.discord.ingress}:${config.discord.commandName}`;
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
