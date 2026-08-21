import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig, loadSecrets } from "../config.js";
import { DISCORD_USER_AGENT } from "../discord/delivery.js";
import { unprivilegedChildEnvironment } from "../environment.js";
import { errorMessage } from "../values.js";
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
    checks.push({
      name: "Slack allowlist identifier shapes",
      run: async () => {
        for (const workspaceId of config.slack.allowedWorkspaceIds) {
          if (!/^[TE][A-Z0-9]{2,}$/.test(workspaceId)) {
            throw new Error(`slack.allowedWorkspaceIds contains "${workspaceId}"; a workspace ID looks like T0123456789`);
          }
        }
        for (const userId of config.slack.allowedUserIds) {
          if (!/^[UW][A-Z0-9]{2,}$/.test(userId)) {
            throw new Error(`slack.allowedUserIds contains "${userId}"; copy your member ID (like U0123456789) from your Slack profile`);
          }
        }
        return `${config.slack.allowedWorkspaceIds.length} workspace(s), ${config.slack.allowedUserIds.length} user(s)`;
      },
    });
    checks.push({
      name: "Slack bot token and workspace match",
      run: async () => {
        const response = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { authorization: `Bearer ${secrets.slackBotToken}`, "content-type": "application/x-www-form-urlencoded" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { ok?: boolean; error?: string; team_id?: string; user?: string };
        if (!body.ok) throw new Error(`Slack rejected the bot token: ${body.error ?? "unknown_error"}`);
        const teamId = body.team_id ?? "";
        if (!config.slack.allowedWorkspaceIds.includes(teamId)) {
          throw new Error(`This bot token belongs to workspace ${teamId}, which is not in slack.allowedWorkspaceIds`);
        }
        return `${body.user ?? "bot"} in ${teamId}`;
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
    checks.push({
      name: "Discord allowlist identifier shapes",
      run: async () => {
        const snowflake = /^[0-9]{17,20}$/;
        if (!config.discord.applicationId || !snowflake.test(config.discord.applicationId)) {
          throw new Error("discord.applicationId must be a 17-20 digit Discord application ID");
        }
        for (const guildId of config.discord.allowedGuildIds) {
          if (!snowflake.test(guildId)) {
            throw new Error(`discord.allowedGuildIds contains "${guildId}"; copy the numeric server ID from Discord`);
          }
        }
        for (const userId of config.discord.allowedUserIds) {
          if (!snowflake.test(userId)) {
            throw new Error(`discord.allowedUserIds contains "${userId}"; copy the numeric user ID from Discord`);
          }
        }
        return `${config.discord.allowedGuildIds.length} guild(s), ${config.discord.allowedUserIds.length} user(s)`;
      },
    });
    checks.push({
      name: "Discord bot token and application match",
      run: async () => {
        const response = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
          headers: {
            authorization: `Bot ${secrets.discordBotToken}`,
            "user-agent": DISCORD_USER_AGENT,
          },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { id?: string; name?: string };
        if (!body.id) throw new Error("Discord response did not include the application ID");
        if (body.id !== config.discord.applicationId) {
          throw new Error(`This bot token belongs to application ${body.id}, not configured application ${config.discord.applicationId}`);
        }
        return `${body.name ?? "application"} (${body.id})`;
      },
    });
  }

  let failed = false;
  for (const check of checks) {
    try {
      console.log(`PASS ${check.name}: ${await check.run()}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${check.name}: ${errorMessage(error)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
