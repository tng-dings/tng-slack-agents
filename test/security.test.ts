import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { loadConfig, loadSecrets } from "../src/config.js";
import { RunnerDatabase } from "../src/database.js";
import { AgentRunner } from "../src/runner.js";
import { unprivilegedChildEnvironment } from "../src/environment.js";
import type { Executor, JobReporter } from "../src/types.js";
import { testAuthorizationPolicy, testConfig, testExecutor, waitFor } from "./helpers.js";

test("configuration rejects a non-loopback OpenCode endpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-config-"));
  const filename = path.join(root, "config.json");
  const config = {
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    openCode: { baseUrl: "http://example.com:4096", workingRepository: root },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  };
  await writeFile(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename), /127\.0\.0\.1/);
  await rm(root, { recursive: true, force: true });
});

test("configuration rejects unsafe native Slack streaming", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-streaming-config-"));
  const filename = path.join(root, "config.json");
  const config = {
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [], nativeStreaming: true },
    openCode: { baseUrl: "http://127.0.0.1:4096", workingRepository: root },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  };
  await writeFile(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename), /cannot be safely redacted/);
  await rm(root, { recursive: true, force: true });
});

test("configuration accepts only an explicit OpenCode version allowlist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-version-config-"));
  const filename = path.join(root, "config.json");
  const config = {
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    openCode: {
      baseUrl: "http://127.0.0.1:4096",
      workingRepository: root,
      approvedVersions: ["1.2.3", "1.2.4"],
    },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  };
  await writeFile(filename, JSON.stringify(config));
  const loaded = await loadConfig(filename);
  assert.equal(loaded.executor, "opencode");
  assert.deepEqual(loaded.executor === "opencode" ? loaded.openCode.approvedVersions : [], ["1.2.3", "1.2.4"]);
  await writeFile(filename, JSON.stringify({ ...config, openCode: { ...config.openCode, approvedVersions: [""] } }));
  await assert.rejects(loadConfig(filename), /openCode\.approvedVersions/);
  await rm(root, { recursive: true, force: true });
});

test("configuration selects Claude Code without OpenCode settings or password", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-claude-config-"));
  const filename = path.join(root, "config.json");
  await writeFile(filename, JSON.stringify({
    executor: "claude-code",
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    claudeCode: { workingRepository: root, model: "claude-sonnet-4-5" },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  }));
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const previousClaudeCredential = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  process.env.ANTHROPIC_API_KEY = "claude-provider-secret";
  try {
    const loaded = await loadConfig(filename);
    assert.equal(loaded.executor, "claude-code");
    if (loaded.executor !== "claude-code") throw new Error("Expected Claude Code configuration");
    assert.equal(loaded.claudeCode.model, "claude-sonnet-4-5");
    assert.equal(loaded.claudeCode.permissionMode, "bypassPermissions");
    const secrets = loadSecrets(loaded);
    assert.equal(secrets.openCodePassword, "");
    assert.deepEqual(secrets.providerCredentials, ["claude-provider-secret"]);
  } finally {
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
    if (previousClaudeCredential === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousClaudeCredential;
  }
  await writeFile(filename, JSON.stringify({
    executor: "claude-code",
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    claudeCode: { workingRepository: root, model: 42 },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  }));
  await assert.rejects(loadConfig(filename), /claudeCode\.model/);
  await writeFile(filename, JSON.stringify({
    executor: "unknown",
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  }));
  await assert.rejects(loadConfig(filename), /executor must be/);
  await rm(root, { recursive: true, force: true });
});

test("Slack credentials are required only by the selected ingress", () => {
  const config = testConfig(".");
  config.slack.enabled = true;
  const previous = {
    bot: process.env.SLACK_BOT_TOKEN,
    app: process.env.SLACK_APP_TOKEN,
    signing: process.env.SLACK_SIGNING_SECRET,
    openCode: process.env.OPENCODE_SERVER_PASSWORD,
  };
  try {
    process.env.OPENCODE_SERVER_PASSWORD = "password";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    delete process.env.SLACK_APP_TOKEN;
    process.env.SLACK_SIGNING_SECRET = "signing-secret";
    config.slack.ingress = "events-api";
    assert.equal(loadSecrets(config).slackSigningSecret, "signing-secret");

    delete process.env.SLACK_SIGNING_SECRET;
    assert.throws(() => loadSecrets(config), /SLACK_SIGNING_SECRET/);

    config.slack.ingress = "socket";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    assert.equal(loadSecrets(config).slackAppToken, "xapp-test");
  } finally {
    for (const [name, value] of [
      ["SLACK_BOT_TOKEN", previous.bot],
      ["SLACK_APP_TOKEN", previous.app],
      ["SLACK_SIGNING_SECRET", previous.signing],
      ["OPENCODE_SERVER_PASSWORD", previous.openCode],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Discord credentials match the selected ingress", () => {
  const config = testConfig(".");
  const previous = {
    bot: process.env.DISCORD_BOT_TOKEN,
    publicKey: process.env.DISCORD_PUBLIC_KEY,
    openCode: process.env.OPENCODE_SERVER_PASSWORD,
  };
  try {
    process.env.OPENCODE_SERVER_PASSWORD = "password";
    config.discord.enabled = true;
    process.env.DISCORD_BOT_TOKEN = "discord-bot-token";
    assert.equal(loadSecrets(config).discordBotToken, "discord-bot-token");
    assert.equal(loadSecrets(config).discordPublicKey, undefined);
    config.discord.ingress = "http";
    delete process.env.DISCORD_PUBLIC_KEY;
    assert.throws(() => loadSecrets(config), /DISCORD_PUBLIC_KEY/);
    process.env.DISCORD_PUBLIC_KEY = "a".repeat(64);
    assert.equal(loadSecrets(config).discordPublicKey, "a".repeat(64));
    config.discord.enabled = false;
    delete process.env.DISCORD_PUBLIC_KEY;
    assert.equal(loadSecrets(config).discordPublicKey, undefined);
  } finally {
    for (const [name, value] of [
      ["DISCORD_BOT_TOKEN", previous.bot],
      ["DISCORD_PUBLIC_KEY", previous.publicKey],
      ["OPENCODE_SERVER_PASSWORD", previous.openCode],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Discord configuration defaults to Gateway with a bounded legacy HTTP option", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-discord-config-"));
  const filename = path.join(root, "config.json");
  const config = {
    discord: {
      enabled: true,
      applicationId: "APP1",
      commandName: "agent",
      allowedGuildIds: ["G1"],
      allowedUserIds: ["U1"],
      http: { host: "127.0.0.1", port: 3001, interactionsPath: "/discord/interactions" },
    },
    slack: { enabled: false, allowedWorkspaceIds: [], allowedUserIds: [] },
    openCode: { baseUrl: "http://127.0.0.1:4096", workingRepository: root },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  };
  await writeFile(filename, JSON.stringify(config));
  const loaded = await loadConfig(filename);
  assert.equal(loaded.discord.ingress, "gateway");
  assert.equal(loaded.discord.commandName, "agent");
  assert.equal(loaded.discord.http.host, "127.0.0.1");
  assert.equal(loaded.discord.http.requestTimeoutMs, 2_500);
  assert.deepEqual(loaded.integrations.discord, { allowedTenants: ["G1"], allowedActors: ["U1"] });

  await writeFile(filename, JSON.stringify({ ...config, discord: { ...config.discord, commandName: "Agent" } }));
  await assert.rejects(loadConfig(filename), /discord\.commandName/);
  await writeFile(filename, JSON.stringify({
    ...config,
    discord: { ...config.discord, http: { ...config.discord.http, host: "0.0.0.0" } },
  }));
  await assert.rejects(loadConfig(filename), /discord\.http\.host/);
  await writeFile(filename, JSON.stringify({ ...config, discord: { ...config.discord, ingress: "invalid" } }));
  await assert.rejects(loadConfig(filename), /discord\.ingress/);
  await rm(root, { recursive: true, force: true });
});

test("Events API configuration requires an app ID and explicit HTTP routes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-http-config-"));
  const filename = path.join(root, "config.json");
  const config = {
    slack: {
      enabled: true,
      ingress: "events-api",
      allowedWorkspaceIds: ["T1"],
      allowedUserIds: ["U1"],
      http: { host: "127.0.0.1", port: 4000, eventsPath: "/slack/events", healthPath: "/healthz" },
    },
    openCode: { baseUrl: "http://127.0.0.1:4096", workingRepository: root },
    storage: { databasePath: "runner.db", auditLogPath: "audit.jsonl", worktreeRoot: "worktrees" },
  };
  await writeFile(filename, JSON.stringify(config));
  await assert.rejects(loadConfig(filename), /slack\.appId/);
  await writeFile(filename, JSON.stringify({ ...config, slack: { ...config.slack, appId: "A1" } }));
  const loaded = await loadConfig(filename);
  assert.equal(loaded.slack.ingress, "events-api");
  assert.equal(loaded.slack.http.port, 4000);
  assert.equal(loaded.slack.http.host, "127.0.0.1");
  assert.equal(loaded.slack.http.maxBodyBytes, 256 * 1024);
  assert.equal(loaded.slack.http.maxHeaderBytes, 16 * 1024);
  await writeFile(filename, JSON.stringify({
    ...config,
    slack: { ...config.slack, appId: "A1", http: { ...config.slack.http, port: 65_536 } },
  }));
  await assert.rejects(loadConfig(filename), /slack\.http\.port must be at most 65535/);
  await writeFile(filename, JSON.stringify({
    ...config,
    slack: { ...config.slack, appId: "A1", http: { ...config.slack.http, host: "0.0.0.0" } },
  }));
  await assert.rejects(loadConfig(filename), /reviewed loopback IPv4 literal/);
  await writeFile(filename, JSON.stringify({
    ...config,
    slack: { ...config.slack, appId: "A1", http: { ...config.slack.http, host: "::1" } },
  }));
  await assert.rejects(loadConfig(filename), /reviewed loopback IPv4 literal/);
  await writeFile(filename, JSON.stringify({
    ...config,
    slack: { ...config.slack, appId: "A1", http: { ...config.slack.http, maxBodyBytes: 262_145 } },
  }));
  await assert.rejects(loadConfig(filename), /slack\.http\.maxBodyBytes must be at most 262144/);
  await writeFile(filename, JSON.stringify({
    ...config,
    slack: { ...config.slack, appId: "A1", http: { ...config.slack.http, requestTimeoutMs: 100 } },
  }));
  await assert.rejects(
    loadConfig(filename),
    /slack\.http\.headersTimeoutMs must be less than or equal to slack\.http\.requestTimeoutMs/,
  );
  await rm(root, { recursive: true, force: true });
});

test("Slack delivery failure cannot change a successful execution result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-delivery-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const reporter: JobReporter = {
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => { throw new Error("Slack unavailable"); },
    fail: async () => undefined,
  };
  const executor: Executor = testExecutor(root, async () => ({
      output: "completed",
      usage: { cost: 0, inputTokens: 1, outputTokens: 1 },
    }), "session");
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => reporter);
  await runner.start();
  const { job } = await runner.submit({
    integration: "slack",
    sourceEventId: "delivery-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_ALLOWED",
    prompt: "work",
  });
  await waitFor(() => database.getJob(job.id)?.status === "succeeded");
  assert.equal(database.getJob(job.id)?.status, "succeeded");
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("runner enforces the configured output bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-output-limit-"));
  const config = testConfig(root);
  config.limits.maxOutputCharacters = 3;
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  let failure = "";
  const reporter: JobReporter = {
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async (message) => { failure = message; },
  };
  const executor: Executor = testExecutor(root, async (_job, _session, callbacks) => {
      await callbacks.onText("12345");
      throw new Error("output callback should reject");
    });
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => reporter);
  await runner.start();
  const { job } = await runner.submit({
    integration: "slack",
    sourceEventId: "output-limit-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "2.0",
    actorId: "U_ALLOWED",
    prompt: "produce output",
  });
  await waitFor(() => database.getJob(job.id)?.status === "failed" && failure.length > 0);
  assert.equal(database.getJob(job.id)?.output, "123");
  assert.match(failure, /output exceeded/i);
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("OpenCode launcher is wired only to the worker secret bundle", async () => {
  const launcher = await readFile("scripts/Start-OpenCode.ps1", "utf8");
  const gatewayLauncher = await readFile("scripts/Start-AgentRunner.ps1", "utf8");
  const workerService = await readFile("service/OpenCodeServer.xml", "utf8");
  const gatewayService = await readFile("service/AgentRunner.xml", "utf8");
  assert.match(launcher, /worker-secrets\.bin/);
  assert.doesNotMatch(launcher, /gateway-secrets\.bin/);
  assert.match(launcher, /Refusing to inject an integration credential/);
  assert.match(launcher, /DISCORD_\*/);
  assert.match(launcher, /OPENCODE_CONFIG_CONTENT/);
  assert.match(launcher, /external_directory = "deny"/);
  assert.match(launcher, /webfetch = "deny"/);
  assert.match(gatewayLauncher, /gateway-secrets\.bin/);
  assert.match(workerService, /NT SERVICE\\OpenCodeServer/);
  assert.match(gatewayService, /NT SERVICE\\AgentRunner/);
});

test("Windows service provisioning accepts only supported Claude credentials and keeps OpenCode as the default", async () => {
  const provisioner = await readFile("scripts/Set-AgentRunnerSecrets.ps1", "utf8");
  const launcher = await readFile("scripts/Start-AgentRunner.ps1", "utf8");
  const securityAudit = await readFile("scripts/Test-AgentRunnerSecurity.ps1", "utf8");
  const service = await readFile("service/AgentRunner.xml", "utf8");

  assert.match(provisioner, /\[ValidateSet\("opencode", "claude-code"\)\]\s*\[string\]\$Executor = "opencode"/);
  assert.match(
    provisioner,
    /\[ValidateSet\("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"\)\]\s*\[string\]\$ClaudeCredentialName = "ANTHROPIC_API_KEY"/,
  );
  const credentialValidation = provisioner.match(
    /\[ValidateSet\(([^\r\n]+)\)\]\s*\[string\]\$ClaudeCredentialName/,
  );
  assert.deepEqual(credentialValidation?.[1]?.match(/[A-Z][A-Z0-9_]+/g), [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  assert.match(provisioner, /if \(\$Executor -eq "opencode"\) \{\s*Assert-Identity \$WorkerServiceIdentity/);
  assert.match(provisioner, /Join-Path \$GatewayDataDirectory "claude"/);
  assert.match(provisioner, /"Modify" \$GatewayServiceIdentity/);
  assert.match(provisioner, /\$gatewaySecrets\[\$ClaudeCredentialName\] = Read-PlainSecret \$ClaudeCredentialName/);
  assert.match(provisioner, /no OpenCode worker bundle was created/);

  assert.match(launcher, /\$executor -eq "claude-code"/);
  assert.match(launcher, /CLAUDE_CONFIG_DIR = Join-Path \$DataDirectory "claude"/);
  assert.match(launcher, /foreach \(\$name in \$injectedEnvironmentNames\)/);
  assert.match(securityAudit, /if \(\$executor -eq "opencode"\)/);
  assert.match(securityAudit, /elseif \(\$executor -eq "claude-code"\)/);
  assert.match(securityAudit, /does not require an OpenCodeServer service/);
  assert.match(securityAudit, /gateway bundle contains exactly one supported Claude credential/);
  assert.match(securityAudit, /Test-IdentityHasRights/);
  assert.match(securityAudit, /AgentRunner owns its Claude config directory/);
  assert.match(securityAudit, /Claude worktree area disables inherited access rules/);
  assert.doesNotMatch(service, /OpenCode agent runner/);
});

test("Slack manifest includes files:read for screenshot support", async () => {
  const manifest = await readFile("slack/manifest.json", "utf8");
  const parsed = JSON.parse(manifest) as { oauth_config: { scopes: { bot: string[] } } };
  const botScopes = parsed.oauth_config.scopes.bot;
  assert(botScopes.includes("files:read"));
  assert(botScopes.includes("assistant:write"));
  assert(botScopes.includes("chat:write"));
  assert(botScopes.includes("im:history"));

  const httpManifest = JSON.parse(await readFile("slack/manifest.events-api.json", "utf8")) as {
    oauth_config: { scopes: { bot: string[] } };
    settings: { socket_mode_enabled: boolean; event_subscriptions: { request_url: string } };
  };
  assert.deepEqual(httpManifest.oauth_config.scopes.bot, botScopes);
  assert.equal(httpManifest.settings.socket_mode_enabled, false);
  assert.match(httpManifest.settings.event_subscriptions.request_url, /^https:\/\//);
});

test("gateway child processes receive an allowlisted environment without secrets", () => {
  const child = unprivilegedChildEnvironment({
    PATH: "trusted-path",
    SystemRoot: "C:\\Windows",
    SLACK_BOT_TOKEN: "xoxb-secret",
    DISCORD_BOT_TOKEN: "discord-secret",
    OPENCODE_SERVER_PASSWORD: "worker-password",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  assert.equal(child.PATH, "trusted-path");
  assert.equal(child.SystemRoot, "C:\\Windows");
  assert.equal(child.SLACK_BOT_TOKEN, undefined);
  assert.equal(child.DISCORD_BOT_TOKEN, undefined);
  assert.equal(child.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
});
