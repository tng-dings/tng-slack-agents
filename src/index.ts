import { AuditLogger } from "./audit.js";
import { IntegrationAuthorizationPolicy, loadConfig, loadSecrets } from "./config.js";
import { RunnerDatabase } from "./database.js";
import { IntegrationReporterRegistry } from "./integrations.js";
import { OpenCodeExecutor } from "./opencode.js";
import { AgentRunner } from "./runner.js";
import { SlackGateway } from "./slack.js";
import { WorkspaceManager } from "./workspace.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const secrets = loadSecrets(config);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, [
    secrets.openCodePassword,
    secrets.slackBotToken ?? "",
    secrets.slackAppToken ?? "",
    secrets.slackSigningSecret ?? "",
  ], config.limits.maxAuditEventCharacters);
  const workspaces = new WorkspaceManager(config.openCode.workingRepository, config.storage.worktreeRoot);
  const executor = new OpenCodeExecutor(
    config.openCode,
    secrets.openCodePassword,
    workspaces,
    audit,
    config.limits.maxOutputCharacters + 64_000,
  );
  const authorization = new IntegrationAuthorizationPolicy(config.integrations);
  const slack = config.slack.enabled ? new SlackGateway(config, secrets, database) : undefined;
  const reporters = new IntegrationReporterRegistry({
    ...(slack ? { slack: (job) => slack.reporter(job) } : {}),
  });
  const runner = new AgentRunner(config, authorization, database, executor, audit, (job) => reporters.reporter(job));
  slack?.attachRunner(runner);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; stopping agent runner…`);
    await slack?.stop().catch((error: unknown) => console.error("Slack shutdown failed", error));
    await runner.stop();
    database.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));

  try {
    const health = await executor.health();
    console.log(`OpenCode ${health.version ?? "unknown"} is healthy.`);
  } catch (error) {
    console.warn("OpenCode is not reachable yet; queued jobs will fail until it is available.", error);
  }
  await runner.start();
  if (slack) {
    await slack.start();
    console.log(`Agent runner is connected to Slack through ${config.slack.ingress}.`);
  } else {
    console.log("Agent runner started with Slack disabled.");
  }
}

main().catch((error: unknown) => {
  console.error("Agent runner failed to start", error);
  process.exitCode = 1;
});
