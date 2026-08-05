import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WebClient } from "@slack/web-api";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import { AuthorizationError } from "../src/errors.js";
import { AgentRunner } from "../src/runner.js";
import { SlackJobReporter } from "../src/slack.js";
import type { Executor, JobRecord, JobReporter } from "../src/types.js";
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
    sourceEventId: "slack-event-1",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "100.1",
    replyTs: "100.2",
    userId: "U_ALLOWED",
    prompt: "Do work with password=super-secret",
  };
  const { job } = await runner.submit(submission);
  const duplicate = await runner.submit(submission);
  assert.equal(duplicate.job.id, job.id);
  assert.equal(duplicate.isNew, false);
  await waitFor(() => database.getJob(job.id)?.status === "succeeded");

  assert.equal(database.getJob(job.id)?.output, "done");
  assert.equal(database.getSession(job.sessionKey)?.openCodeSessionId, "oc-session");
  assert.deepEqual(database.dailyUsage("U_ALLOWED"), { cost: 0.4, inputTokens: 10, outputTokens: 2 });
  assert.equal(reports.get(job.id)?.output, "done");
  await assert.rejects(
    runner.submit({ ...submission, sourceEventId: "unauthorized", userId: "U_DENIED" }),
    AuthorizationError,
  );
  assert.equal(database.getJobBySourceEvent("unauthorized"), undefined);
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
    sourceEventId: "event-running",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "200.1",
    userId: "U_ALLOWED",
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
    sourceEventId: "event-slack",
    sessionKey: "T1:D1:1.0",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "1.0",
    replyTs: "1.1",
    userId: "U1",
    prompt: "hello",
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
