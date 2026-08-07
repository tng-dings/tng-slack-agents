import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import { IntegrationReporterRegistry, MissingIntegrationReporterError } from "../src/integrations.js";
import { AgentRunner, ConsoleReporter } from "../src/runner.js";
import type { Executor, IntegrationId, JobRecord, JobReporter } from "../src/types.js";
import { testAuthorizationPolicy, testConfig, waitFor } from "./helpers.js";

function job(integration: IntegrationId): JobRecord {
  return {
    id: `${integration}-job`,
    integration,
    sourceEventId: `${integration}-event`,
    sessionKey: `${integration}:tenant:conversation:thread`,
    tenantId: "tenant",
    conversationId: "conversation",
    threadId: "thread",
    replyTs: null,
    actorId: "actor",
    prompt: "work",
    attachments: [],
    status: "queued",
    output: "",
    error: null,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

function reporter(label: string, calls: string[]): JobReporter {
  return {
    start: async () => { calls.push(`${label}:start`); },
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => { calls.push(`${label}:fail`); },
  };
}

test("reporter registry routes from the integration persisted on each job", async () => {
  const calls: string[] = [];
  const registry = new IntegrationReporterRegistry({
    slack: () => reporter("slack", calls),
    discord: () => reporter("discord", calls),
  });

  await registry.reporter(job("discord")).start();
  await registry.reporter(job("slack")).start();
  assert.deepEqual(calls, ["discord:start", "slack:start"]);
});

test("reporter registry fails closed unless console delivery is explicitly registered", () => {
  const registry = new IntegrationReporterRegistry({ local: () => new ConsoleReporter() });
  assert(registry.reporter(job("local")) instanceof ConsoleReporter);
  assert.throws(
    () => registry.reporter(job("discord")),
    (error: unknown) => error instanceof MissingIntegrationReporterError &&
      error.code === "DELIVERY_ADAPTER_MISSING" && /discord/.test(error.message),
  );
});

test("restart recovery uses the persisted integration reporter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-routing-restart-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const queued = database.insertJob("persisted-slack-job", {
    integration: "slack",
    sourceEventId: "persisted-slack-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_ALLOWED",
    prompt: "work",
  });
  assert.equal(database.claimNextJob(1, 1)?.id, queued.id);
  database.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, reopened);
  const calls: string[] = [];
  const registry = new IntegrationReporterRegistry({
    slack: () => reporter("slack", calls),
    discord: () => reporter("discord", calls),
  });
  const runner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    reopened,
    { execute: async () => Promise.reject(new Error("must not execute")) },
    audit,
    (persistedJob) => registry.reporter(persistedJob),
  );

  await runner.start();
  assert.equal(reopened.getJob(queued.id)?.status, "failed");
  assert.deepEqual(calls, ["slack:fail"]);
  await runner.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("missing persisted integration delivery is audited without failing execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-routing-missing-"));
  const config = testConfig(root);
  config.integrations.discord = { allowedTenants: ["T1"], allowedActors: ["U_ALLOWED"] };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const executor: Executor = {
    execute: async () => ({
      output: "output-that-must-not-reach-console",
      usage: { cost: 0, inputTokens: 1, outputTokens: 1 },
      openCodeSessionId: "session",
      workingDirectory: root,
    }),
  };
  const registry = new IntegrationReporterRegistry({});
  const runner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    database,
    executor,
    audit,
    (persistedJob) => registry.reporter(persistedJob),
  );

  await runner.start();
  const { job: persisted } = await runner.submit({
    integration: "discord",
    sourceEventId: "missing-reporter",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_ALLOWED",
    prompt: "work",
  });
  await waitFor(() => database.getJob(persisted.id)?.status === "succeeded");
  await runner.stop();

  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  const events = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    eventType: string;
    payload: { integration?: string; error?: string; errorCode?: string };
  });
  assert(events.some((event) =>
    event.eventType === "delivery_failed" &&
    event.payload.integration === "discord" &&
    event.payload.error === 'No delivery adapter is registered for integration "discord"' &&
    event.payload.errorCode === "DELIVERY_ADAPTER_MISSING"
  ));
  assert.equal(database.getJob(persisted.id)?.status, "succeeded");
  database.close();
  await rm(root, { recursive: true, force: true });
});
