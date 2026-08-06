import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import { AuthorizationError } from "../src/errors.js";
import { AgentRunner } from "../src/runner.js";
import { SlackJobReporter } from "../src/slack.js";
import type { Attachment, Executor, JobRecord, JobReporter } from "../src/types.js";
import { testConfig, waitFor } from "./helpers.js";

test("runner persists jobs and sessions, enforces authz, accounts usage, and redacts audits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-control-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["super-secret"]);
  const reports = new Map<string, { output: string; failure?: string }>();
  const reporterFactory = (jobId: string): JobReporter => ({
    start: async () => {
      reports.set(jobId, { output: "" });
    },
    append: async (delta) => {
      reports.get(jobId)!.output += delta;
    },
    succeed: async () => undefined,
    fail: async (message) => {
      const report = reports.get(jobId) ?? { output: "" };
      report.failure = message;
      reports.set(jobId, report);
    },
  });
  const executor: Executor = {
    execute: async (_job, _session, callbacks) => {
      await callbacks.onTool({ tool: "shell", output: "password=super-secret" });
      await callbacks.onText("done");
      await callbacks.onUsage({ cost: 0.4, inputTokens: 10, outputTokens: 2 });
      return {
        output: "done",
        usage: { cost: 0.4, inputTokens: 10, outputTokens: 2 },
        openCodeSessionId: "oc-session",
        workingDirectory: `${root}/worktree`,
      };
    },
  };
  const runner = new AgentRunner(config, database, executor, audit, (job) => reporterFactory(job.id));
  await runner.start();
  const submission = {
    integration: "slack" as const,
    sourceEventId: "slack-event-1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "100.1",
    replyTs: "100.2",
    actorId: "U_ALLOWED",
    prompt: "Do work with password=super-secret",
  };
  const submissions = await Promise.all([runner.submit(submission), runner.submit(submission)]);
  const first = submissions.find((result) => result.isNew);
  const duplicate = submissions.find((result) => !result.isNew);
  assert(first);
  assert(duplicate);
  const { job } = first;
  assert.equal(duplicate.job.id, job.id);
  await waitFor(() => database.getJob(job.id)?.status === "succeeded");

  assert.equal(database.getJob(job.id)?.output, "done");
  assert.equal(database.getSession(job.sessionKey)?.openCodeSessionId, "oc-session");
  assert.deepEqual(database.dailyUsage("U_ALLOWED"), { cost: 0.4, inputTokens: 10, outputTokens: 2 });
  assert.equal(reports.get(job.id)?.output, "done");
  await assert.rejects(
    runner.submit({ ...submission, sourceEventId: "unauthorized", actorId: "U_DENIED" }),
    AuthorizationError,
  );
  assert.equal(database.getJobBySourceEvent("slack", "unauthorized"), undefined);
  await audit.log("redaction_probe", { authorization: "super-secret" });
  await runner.stop();
  await audit.flush();
  database.close();

  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  assert(!auditText.includes("super-secret"));
  assert(auditText.includes("[REDACTED]"));
  assert(auditText.includes('"inputTokens":10'));
  const reopened = new RunnerDatabase(config.storage.databasePath);
  assert.equal(reopened.getJob(job.id)?.status, "succeeded");
  assert.equal(reopened.getSession(job.sessionKey)?.openCodeSessionId, "oc-session");
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("runner marks an in-flight job failed after restart instead of replaying it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-restart-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const submission = {
    integration: "slack" as const,
    sourceEventId: "event-running",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "200.1",
    actorId: "U_ALLOWED",
    prompt: "work",
  };
  const queued = database.insertJob("job-running", submission);
  assert.equal(database.claimNextJob(1, 1)?.id, queued.id);
  database.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, reopened);
  let failure = "";
  const runner = new AgentRunner(
    config,
    reopened,
    { execute: async () => Promise.reject(new Error("must not execute")) },
    audit,
    () => ({
      start: async () => undefined,
      append: async () => undefined,
      succeed: async () => undefined,
      fail: async (message) => {
        failure = message;
      },
    }),
  );
  await runner.start();
  assert.equal(reopened.getJob(queued.id)?.status, "failed");
  assert.match(failure, /interrupted/i);
  await runner.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("runner persists attachments and passes them to the executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-attachments-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["secret"]);
  let capturedAttachments: Attachment[] | undefined;
  const executor: Executor = {
    execute: async (job, _session, callbacks) => {
      capturedAttachments = job.attachments;
      await callbacks.onText("done");
      await callbacks.onUsage({ cost: 0.1, inputTokens: 5, outputTokens: 1 });
      return { output: "done", usage: { cost: 0.1, inputTokens: 5, outputTokens: 1 }, openCodeSessionId: "s1", workingDirectory: root };
    },
  };
  const runner = new AgentRunner(config, database, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const attachment: Attachment = { mime: "image/png", filename: "screenshot.png", dataUrl: "data:image/png;base64,iVBOR" };
  const { job } = await runner.submit({
    integration: "slack",
    sourceEventId: "attach-event-1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "300.1",
    actorId: "U_ALLOWED",
    prompt: "Review this screenshot",
    attachments: [attachment],
  });
  await waitFor(() => database.getJob(job.id)?.status === "succeeded");
  assert.deepEqual(capturedAttachments, [attachment]);
  const stored = database.getJob(job.id);
  assert.equal(stored?.attachments.length, 1);
  assert.equal(stored?.attachments[0]?.filename, "screenshot.png");
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("runner rejects jobs exceeding the attachment count limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-attach-limit-"));
  const config = testConfig(root);
  config.limits.maxAttachmentsPerJob = 1;
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const runner = new AgentRunner(config, database, { execute: async () => Promise.reject(new Error("must not execute")) }, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const attachments: Attachment[] = [
    { mime: "image/png", filename: "a.png", dataUrl: "data:image/png;base64,AAA" },
    { mime: "image/png", filename: "b.png", dataUrl: "data:image/png;base64,BBB" },
  ];
  await assert.rejects(
    runner.submit({ integration: "slack", sourceEventId: "attach-limit", tenantId: "T1", conversationId: "D1", threadId: "400.1", actorId: "U_ALLOWED", prompt: "too many", attachments }),
    /attachment count/i,
  );
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("database namespaces integration event and session identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-identities-"));
  const database = new RunnerDatabase(path.join(root, "runner.db"));
  const common = {
    sourceEventId: "same-event",
    tenantId: "tenant",
    conversationId: "conversation",
    threadId: "thread",
    actorId: "actor",
    prompt: "work",
  };

  const slackJob = database.insertJob("slack-job", { ...common, integration: "slack" });
  const discordJob = database.insertJob("discord-job", { ...common, integration: "discord" });

  assert.equal(slackJob.sessionKey, "slack:tenant:conversation:thread");
  assert.equal(discordJob.sessionKey, "discord:tenant:conversation:thread");
  assert.notEqual(slackJob.sessionKey, discordJob.sessionKey);
  assert.equal(database.getJobBySourceEvent("slack", "same-event")?.id, slackJob.id);
  assert.equal(database.getJobBySourceEvent("discord", "same-event")?.id, discordJob.id);
  assert.throws(
    () => database.insertJob("duplicate-slack-job", {
      ...common,
      integration: "slack",
      threadId: "orphan-if-not-atomic",
    }),
    /UNIQUE constraint failed/,
  );
  assert.equal(database.getSession("slack:tenant:conversation:orphan-if-not-atomic"), undefined);

  database.close();
  await rm(root, { recursive: true, force: true });
});

test("database idempotently upgrades legacy Slack identity rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-migration-"));
  const filename = path.join(root, "runner.db");
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      opencode_session_id TEXT,
      working_directory TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL UNIQUE,
      session_key TEXT NOT NULL REFERENCES sessions(session_key),
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      reply_ts TEXT,
      user_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','timed_out','rejected')),
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      cost REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    INSERT INTO sessions VALUES ('T1:D1:1.0', 'T1', 'D1', '1.0', 'oc-1', '/worktree', '2026-01-01', '2026-01-01');
    INSERT INTO jobs(
      id, source_event_id, session_key, workspace_id, channel_id, thread_ts,
      user_id, prompt, status, created_at
    ) VALUES ('legacy-job', 'Ev1', 'T1:D1:1.0', 'T1', 'D1', '1.0', 'U1', 'work', 'queued', '2026-01-01');
  `);
  legacy.close();

  const migrated = new RunnerDatabase(filename);
  const job = migrated.getJob("legacy-job");
  assert.deepEqual(
    job && {
      integration: job.integration,
      sourceEventId: job.sourceEventId,
      sessionKey: job.sessionKey,
      tenantId: job.tenantId,
      conversationId: job.conversationId,
      threadId: job.threadId,
      actorId: job.actorId,
    },
    {
      integration: "slack",
      sourceEventId: "Ev1",
      sessionKey: "slack:T1:D1:1.0",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "1.0",
      actorId: "U1",
    },
  );
  assert.equal(migrated.getSession("slack:T1:D1:1.0")?.integration, "slack");
  migrated.close();

  const reopened = new RunnerDatabase(filename);
  assert.equal(reopened.getJobBySourceEvent("slack", "Ev1")?.id, "legacy-job");
  assert.equal(reopened.getSession("slack:T1:D1:1.0")?.openCodeSessionId, "oc-1");
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("Slack reporter uses native streaming with the correct destination", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const fakeClient = {
    chatStream: (input: unknown) => {
      calls.push({ kind: "stream", value: input });
      return {
        append: async (value: unknown) => {
          calls.push({ kind: "append", value });
        },
        stop: async () => {
          calls.push({ kind: "stop", value: null });
        },
      };
    },
    chat: {
      update: async (value: unknown) => {
        calls.push({ kind: "update", value });
      },
      postMessage: async (value: unknown) => {
        calls.push({ kind: "post", value });
      },
    },
    assistant: {
      threads: {
        setStatus: async (value: unknown) => {
          calls.push({ kind: "status", value });
        },
      },
    },
  } as unknown as WebClient;
  const job: JobRecord = {
    id: "job-slack",
    integration: "slack",
    sourceEventId: "event-slack",
    sessionKey: "slack:T1:D1:1.0",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    replyTs: "1.1",
    actorId: "U1",
    prompt: "hello",
    attachments: [],
    status: "running",
    output: "",
    error: null,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  const reporter = new SlackJobReporter(fakeClient, job, true);
  await reporter.start();
  await reporter.append("hello");
  await reporter.succeed("hello");

  const streamCall = calls.find((call) => call.kind === "stream")?.value as Record<string, unknown>;
  assert.equal(streamCall.channel, "D1");
  assert.equal(streamCall.thread_ts, "1.0");
  assert.equal(streamCall.recipient_team_id, "T1");
  assert.equal(streamCall.recipient_user_id, "U1");
  assert(calls.some((call) => call.kind === "append"));
  assert(calls.some((call) => call.kind === "stop"));
});
