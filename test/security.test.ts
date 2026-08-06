import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { RunnerDatabase } from "../src/database.js";
import { AgentRunner } from "../src/runner.js";
import { unprivilegedChildEnvironment } from "../src/environment.js";
import type { Executor, JobReporter } from "../src/types.js";
import { testConfig, waitFor } from "./helpers.js";

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
  const executor: Executor = {
    execute: async () => ({
      output: "completed",
      usage: { cost: 0, inputTokens: 1, outputTokens: 1 },
      openCodeSessionId: "session",
      workingDirectory: root,
    }),
  };
  const runner = new AgentRunner(config, database, executor, audit, () => reporter);
  await runner.start();
  const { job } = await runner.submit({
    sourceEventId: "delivery-event",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "1.0",
    userId: "U_ALLOWED",
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
  const executor: Executor = {
    execute: async (_job, _session, callbacks) => {
      await callbacks.onText("12345");
      throw new Error("output callback should reject");
    },
  };
  const runner = new AgentRunner(config, database, executor, audit, () => reporter);
  await runner.start();
  const { job } = await runner.submit({
    sourceEventId: "output-limit-event",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "2.0",
    userId: "U_ALLOWED",
    prompt: "produce output",
  });
  await waitFor(() => database.getJob(job.id)?.status === "failed");
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
  assert.match(launcher, /Refusing to inject a Slack credential/);
  assert.match(launcher, /OPENCODE_CONFIG_CONTENT/);
  assert.match(launcher, /external_directory = "deny"/);
  assert.match(launcher, /webfetch = "deny"/);
  assert.match(gatewayLauncher, /gateway-secrets\.bin/);
  assert.match(workerService, /NT SERVICE\\OpenCodeServer/);
  assert.match(gatewayService, /NT SERVICE\\AgentRunner/);
});

test("Slack manifest includes files:read for screenshot support", async () => {
  const manifest = await readFile("slack/manifest.json", "utf8");
  const parsed = JSON.parse(manifest) as { oauth_config: { scopes: { bot: string[] } } };
  const botScopes = parsed.oauth_config.scopes.bot;
  assert(botScopes.includes("files:read"));
  assert(botScopes.includes("assistant:write"));
  assert(botScopes.includes("chat:write"));
  assert(botScopes.includes("im:history"));
});

test("gateway child processes receive an allowlisted environment without secrets", () => {
  const child = unprivilegedChildEnvironment({
    PATH: "trusted-path",
    SystemRoot: "C:\\Windows",
    SLACK_BOT_TOKEN: "xoxb-secret",
    OPENCODE_SERVER_PASSWORD: "worker-password",
    ANTHROPIC_API_KEY: "provider-secret",
  });
  assert.equal(child.PATH, "trusted-path");
  assert.equal(child.SystemRoot, "C:\\Windows");
  assert.equal(child.SLACK_BOT_TOKEN, undefined);
  assert.equal(child.OPENCODE_SERVER_PASSWORD, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
});
