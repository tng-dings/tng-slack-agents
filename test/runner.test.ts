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
import { readRunnerStatus } from "../src/status.js";
import type { Attachment, Executor, JobRecord, JobReporter } from "../src/types.js";
import { persistSessionExecution, testAuthorizationPolicy, testConfig, testExecutor, waitFor } from "./helpers.js";

test("runner status is read-only, bounded, and hides session identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-status-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const job = database.insertJob("status-job", {
    integration: "slack",
    sourceEventId: "status-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "status-thread",
    actorId: "U_ALLOWED",
    prompt: "status",
  });
  assert.deepEqual(readRunnerStatus(config.storage.databasePath), {
    state: "queued",
    ready: true,
    jobs: { queued: 1, running: 0, succeeded: 0, failed: 0, timed_out: 0, rejected: 0 },
    reconciliation: { blockedSessionCount: 0, sessionReferences: [], referencesTruncated: false },
  });
  assert.equal(database.claimNextJob(1, 1)?.id, job.id);
  database.requireSessionReconciliation(job.sessionKey);
  const blocked = readRunnerStatus(config.storage.databasePath);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.jobs.running, 1);
  assert.equal(blocked.reconciliation.blockedSessionCount, 1);
  assert.equal(blocked.reconciliation.referencesTruncated, false);
  assert.match(blocked.reconciliation.sessionReferences[0]!, /^[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(blocked), new RegExp(job.sessionKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  database.close();
  await rm(root, { recursive: true, force: true });
});

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
  const executor: Executor = testExecutor(`${root}/worktree`, async (_job, _session, callbacks) => {
      await callbacks.onTool({ tool: "shell", output: "password=super-secret" });
      await callbacks.onText("done");
      await callbacks.onUsage({ cost: 0.4, inputTokens: 10, outputTokens: 2 });
      return {
        output: "done",
        usage: { cost: 0.4, inputTokens: 10, outputTokens: 2 },
      };
    }, "oc-session");
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, (job) => reporterFactory(job.id));
  await runner.start();
  const submission = {
    integration: "slack" as const,
    sourceEventId: "slack-event-1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "100.1",
    deliveryMessageId: "100.2",
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
  assert.equal(database.getSession(job.sessionKey)?.providerSessionId, "oc-session");
  assert.deepEqual(database.dailyUsage("slack", "T1", "U_ALLOWED"), { cost: 0.4, inputTokens: 10, outputTokens: 2 });
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
  assert.equal(reopened.getSession(job.sessionKey)?.providerSessionId, "oc-session");
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
    testAuthorizationPolicy(config),
    reopened,
    testExecutor(root, async () => Promise.reject(new Error("must not execute"))),
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

test("graceful shutdown aborts active job controllers and waits for settlement", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-shutdown-"));
  const config = testConfig(root);
  config.limits.jobTimeoutSeconds = 60;
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  let executionStarted = false;
  let abortReason: unknown;
  const executor: Executor = {
    prepareSession: async (job, session, callbacks) => {
      const workingDirectory = session.workingDirectory ?? path.join(root, "worktree");
      await callbacks.onWorkingDirectory(workingDirectory);
      return { providerId: session.providerId, providerSessionId: session.providerSessionId ?? `session-${job.id}`, workingDirectory };
    },
    executeTurn: async (_job, _session, _callbacks, signal) => {
      executionStarted = true;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          abortReason = signal.reason;
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const { job } = await runner.submit({
    integration: "slack",
    sourceEventId: "shutdown-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "shutdown-thread",
    actorId: "U_ALLOWED",
    prompt: "wait",
  });
  await waitFor(() => executionStarted);
  const startedAt = Date.now();
  await runner.stop();
  assert(Date.now() - startedAt < 2_000);
  assert(abortReason instanceof Error);
  assert.equal((abortReason as { code?: string }).code, "RUNNER_SHUTDOWN");
  assert.equal(database.getJob(job.id)?.status, "failed");
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("graceful shutdown cancels a claimed job before delivery setup completes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-shutdown-delivery-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  let releaseDelivery!: () => void;
  const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
  let preparationStarted = false;
  let failedMessage = "";
  const executor: Executor = {
    prepareSession: async () => {
      preparationStarted = true;
      throw new Error("must not prepare after shutdown");
    },
    executeTurn: async () => Promise.reject(new Error("must not execute after shutdown")),
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => ({
    start: async () => deliveryGate,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async (message) => { failedMessage = message; },
  }));
  await runner.start();
  const submitting = runner.submit({
    integration: "slack",
    sourceEventId: "shutdown-delivery-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "shutdown-delivery-thread",
    actorId: "U_ALLOWED",
    prompt: "wait for delivery",
  });
  await waitFor(() => database.countRunning() === 1);
  const job = database.getJobBySourceEvent("slack", "shutdown-delivery-event")!;
  const stopping = runner.stop();
  releaseDelivery();
  await submitting;
  await stopping;
  assert.equal(preparationStarted, false);
  assert.equal(database.getJob(job.id)?.status, "failed");
  assert.equal(database.getSession(job.sessionKey)?.reconciliationRequired, false);
  assert.match(failedMessage, new RegExp(job.id));
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("startup reconciliation blocks a session until abort confirms it stopped", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-reconcile-stopped-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const running = database.insertJob("interrupted-job", {
    integration: "slack",
    sourceEventId: "interrupted-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "reconcile-thread",
    actorId: "U_ALLOWED",
    prompt: "interrupted",
  });
  persistSessionExecution(database, running.sessionKey, "opencode", "old-provider-session", path.join(root, "worktree"));
  assert.equal(database.claimNextJob(1, 1)?.id, running.id);
  const queued = database.insertJob("queued-after-interruption", {
    integration: "slack",
    sourceEventId: "queued-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "reconcile-thread",
    actorId: "U_ALLOWED",
    prompt: "next",
  });
  database.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, reopened);
  let reconciliationStarted!: () => void;
  const started = new Promise<void>((resolve) => { reconciliationStarted = resolve; });
  let releaseReconciliation!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReconciliation = resolve; });
  let turnStarted = false;
  const executor: Executor = {
    reconcileSession: async (session) => {
      assert.equal(session.providerSessionId, "old-provider-session");
      reconciliationStarted();
      await gate;
    },
    prepareSession: async (_job, session, callbacks) => {
      assert.equal(session.providerSessionId, null);
      assert.equal(session.executionGeneration, 1);
      await callbacks.onWorkingDirectory(session.workingDirectory!);
      return { providerId: session.providerId, providerSessionId: "replacement-provider-session", workingDirectory: session.workingDirectory! };
    },
    executeTurn: async () => {
      turnStarted = true;
      return { output: "continued", usage: { cost: 0, inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), reopened, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  const starting = runner.start();
  await started;
  assert.equal(reopened.getJob(running.id)?.status, "failed");
  assert.equal(reopened.getJob(queued.id)?.status, "queued");
  assert.equal(reopened.getSession(running.sessionKey)?.reconciliationRequired, true);
  assert.equal(turnStarted, false);
  releaseReconciliation();
  await starting;
  await waitFor(() => reopened.getJob(queued.id)?.status === "succeeded");
  assert.equal(turnStarted, true);
  assert.equal(reopened.getSession(running.sessionKey)?.providerSessionId, "replacement-provider-session");
  assert.equal(reopened.getSession(running.sessionKey)?.executionGeneration, 1);
  assert.equal(reopened.getSession(running.sessionKey)?.reconciliationRequired, false);
  await runner.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("durable reconciliation state survives a second restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-reconcile-restart-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const running = database.insertJob("twice-interrupted-job", {
    integration: "slack",
    sourceEventId: "twice-interrupted-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "twice-interrupted-thread",
    actorId: "U_ALLOWED",
    prompt: "interrupted",
  });
  persistSessionExecution(database, running.sessionKey, "opencode", "durable-provider-session", path.join(root, "worktree"));
  assert.equal(database.claimNextJob(1, 1)?.id, running.id);
  assert.equal(database.recoverInterruptedJobs().length, 1);
  assert.equal(database.getSession(running.sessionKey)?.reconciliationRequired, true);
  database.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, reopened);
  let reconciled = false;
  const executor: Executor = {
    reconcileSession: async (session) => {
      reconciled = true;
      assert.equal(session.providerSessionId, "durable-provider-session");
    },
    prepareSession: async () => Promise.reject(new Error("must not prepare")),
    executeTurn: async () => Promise.reject(new Error("must not execute")),
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), reopened, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  assert.equal(reconciled, true);
  assert.equal(reopened.getSession(running.sessionKey)?.reconciliationRequired, false);
  assert.equal(reopened.getSession(running.sessionKey)?.providerSessionId, null);
  assert.equal(reopened.getSession(running.sessionKey)?.executionGeneration, 1);
  await runner.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("failed startup reconciliation fails visibly and preserves queued work for a later restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-reconcile-quarantine-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const running = database.insertJob("ambiguous-job", {
    integration: "slack",
    sourceEventId: "ambiguous-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "quarantine-thread",
    actorId: "U_ALLOWED",
    prompt: "ambiguous",
  });
  persistSessionExecution(database, running.sessionKey, "opencode", "ambiguous-provider-session", path.join(root, "worktree"));
  assert.equal(database.claimNextJob(1, 1)?.id, running.id);
  const queued = database.insertJob("queued-after-quarantine", {
    integration: "slack",
    sourceEventId: "replacement-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "quarantine-thread",
    actorId: "U_ALLOWED",
    prompt: "replacement",
  });
  database.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, reopened);
  let preparationStarted = false;
  const executor: Executor = {
    reconcileSession: async () => { throw new Error("abort endpoint unavailable"); },
    prepareSession: async () => {
      preparationStarted = true;
      throw new Error("must remain blocked");
    },
    executeTurn: async () => Promise.reject(new Error("must remain blocked")),
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), reopened, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await assert.rejects(
    runner.start(),
    (error: unknown) => error instanceof Error &&
      (error as { code?: string }).code === "SESSION_RECONCILIATION_REQUIRED",
  );
  assert.equal(reopened.getJob(queued.id)?.status, "queued");
  assert.equal(preparationStarted, false);
  assert.equal(reopened.getSession(running.sessionKey)?.providerSessionId, "ambiguous-provider-session");
  assert.equal(reopened.getSession(running.sessionKey)?.executionGeneration, 0);
  assert.equal(reopened.getSession(running.sessionKey)?.reconciliationRequired, true);
  await runner.stop();
  reopened.close();

  const recovered = new RunnerDatabase(config.storage.databasePath);
  const recoveredAudit = new AuditLogger(config.storage.auditLogPath, recovered);
  let sawReplacementPreparation = false;
  const recoveredExecutor: Executor = {
    reconcileSession: async (session) => {
      assert.equal(session.providerSessionId, "ambiguous-provider-session");
    },
    prepareSession: async (_job, session, callbacks) => {
      sawReplacementPreparation = session.providerSessionId === null && session.executionGeneration === 1;
      await callbacks.onWorkingDirectory(session.workingDirectory!);
      return { providerId: "opencode", providerSessionId: "replacement-provider-session", workingDirectory: session.workingDirectory! };
    },
    executeTurn: async () => ({
      output: "replacement complete",
      usage: { cost: 0, inputTokens: 1, outputTokens: 1 },
    }),
  };
  const recoveredRunner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    recovered,
    recoveredExecutor,
    recoveredAudit,
    () => ({
      start: async () => undefined,
      append: async () => undefined,
      succeed: async () => undefined,
      fail: async () => undefined,
    }),
  );
  await recoveredRunner.start();
  await waitFor(() => recovered.getJob(queued.id)?.status === "succeeded");
  assert.equal(sawReplacementPreparation, true);
  assert.equal(recovered.getSession(running.sessionKey)?.providerSessionId, "replacement-provider-session");
  assert.equal(recovered.getSession(running.sessionKey)?.reconciliationRequired, false);
  assert.equal(recovered.getSession(running.sessionKey)?.executionGeneration, 1);
  await recoveredRunner.stop();

  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  assert.match(auditText, /"outcome":"quarantined"/);
  assert.match(auditText, /"outcome":"stopped"/);
  recovered.close();
  await rm(root, { recursive: true, force: true });
});

test("runtime reconciliation retries release queued work after a transient provider failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-reconcile-retry-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  let turns = 0;
  let reconciliationAttempts = 0;
  const executor: Executor = {
    reconcileSession: async () => {
      reconciliationAttempts += 1;
      if (reconciliationAttempts === 1) throw new Error("temporary provider outage");
    },
    prepareSession: async (_job, session, callbacks) => {
      const workingDirectory = session.workingDirectory ?? path.join(root, "worktree");
      await callbacks.onWorkingDirectory(workingDirectory);
      return {
        providerId: session.providerId,
        providerSessionId: session.providerSessionId ?? `provider-session-${session.executionGeneration}`,
        workingDirectory,
      };
    },
    executeTurn: async () => {
      turns += 1;
      if (turns === 1) throw new Error("provider turn failed");
      return { output: "recovered", usage: { cost: 0, inputTokens: 1, outputTokens: 1 } };
    },
  };
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const first = await runner.submit({
    integration: "slack",
    sourceEventId: "reconcile-retry-first",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "reconcile-retry-thread",
    actorId: "U_ALLOWED",
    prompt: "fail once",
  });
  await waitFor(() => database.getJob(first.job.id)?.status === "failed");
  assert.equal(database.getSession(first.job.sessionKey)?.reconciliationRequired, true);
  const second = await runner.submit({
    integration: "slack",
    sourceEventId: "reconcile-retry-second",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "reconcile-retry-thread",
    actorId: "U_ALLOWED",
    prompt: "run after reconciliation",
  });
  await waitFor(() => database.getJob(second.job.id)?.status === "succeeded", 3_000);
  assert.equal(reconciliationAttempts, 2);
  assert.equal(database.getSession(first.job.sessionKey)?.reconciliationRequired, false);
  assert.equal(database.getSession(first.job.sessionKey)?.executionGeneration, 1);
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("runner persists attachments and passes them to the executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-attachments-"));
  const config = testConfig(root);
  config.limits.maxAttachmentBytes = 4;
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["secret"]);
  let capturedAttachments: Attachment[] | undefined;
  const executor: Executor = testExecutor(root, async (job, _session, callbacks) => {
      capturedAttachments = job.attachments;
      await callbacks.onText("done");
      await callbacks.onUsage({ cost: 0.1, inputTokens: 5, outputTokens: 1 });
      return { output: "done", usage: { cost: 0.1, inputTokens: 5, outputTokens: 1 } };
    }, "s1");
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const attachment: Attachment = { mime: "image/png", filename: "screenshot.png", dataUrl: "data:image/png;base64,AQIDBA==" };
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
  await assert.rejects(
    runner.submit({
      integration: "slack",
      sourceEventId: "attach-event-too-large",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "300.2",
      actorId: "U_ALLOWED",
      prompt: "Review a larger screenshot",
      attachments: [{ mime: "image/png", filename: "large.png", dataUrl: "data:image/png;base64,AQIDBAU=" }],
    }),
    /attachment exceeds/i,
  );
  await assert.rejects(
    runner.submit({
      integration: "slack",
      sourceEventId: "attach-event-malformed",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "300.3",
      actorId: "U_ALLOWED",
      prompt: "Review a malformed screenshot",
      attachments: [{ mime: "image/png", filename: "bad.png", dataUrl: "data:image/png;base64,!!!!" }],
    }),
    /attachment exceeds/i,
  );
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
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, testExecutor(root, async () => Promise.reject(new Error("must not execute"))), audit, () => ({
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
      reply_ts, user_id, prompt, status, created_at
    ) VALUES ('legacy-job', 'Ev1', 'T1:D1:1.0', 'T1', 'D1', '1.0', 'legacy-reply', 'U1', 'work', 'queued', '2026-01-01');
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
  assert.equal(job?.deliveryMessageId, "legacy-reply");
  migrated.close();

  const reopened = new RunnerDatabase(filename);
  assert.equal(reopened.getJobBySourceEvent("slack", "Ev1")?.id, "legacy-job");
  assert.equal(reopened.getSession("slack:T1:D1:1.0")?.providerId, "opencode");
  assert.equal(reopened.getSession("slack:T1:D1:1.0")?.providerSessionId, "oc-1");
  assert.equal(reopened.getSession("slack:T1:D1:1.0")?.executionGeneration, 0);
  assert.equal(reopened.getSession("slack:T1:D1:1.0")?.reconciliationRequired, false);
  const migratedColumns = reopened.sqlite.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  assert(migratedColumns.some((column) => column.name === "opencode_session_id"));
  assert(migratedColumns.some((column) => column.name === "provider_id"));
  assert(migratedColumns.some((column) => column.name === "provider_session_id"));
  const migratedIds = reopened.sqlite.prepare(`
    SELECT opencode_session_id, provider_id, provider_session_id FROM sessions WHERE session_key = ?
  `).get("slack:T1:D1:1.0") as Record<string, unknown>;
  assert.deepEqual({ ...migratedIds }, {
    opencode_session_id: "oc-1",
    provider_id: "opencode",
    provider_session_id: "oc-1",
  });
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("database migrates legacy daily_usage rows to integration-aware budget tracking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-usage-migration-"));
  const filename = path.join(root, "runner.db");
  const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      session_key TEXT PRIMARY KEY,
      integration TEXT NOT NULL DEFAULT 'slack',
      tenant_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
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
      integration TEXT NOT NULL DEFAULT 'slack',
      tenant_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '',
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      reply_ts TEXT,
      user_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      attachments TEXT,
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
    CREATE TABLE daily_usage (
      usage_date TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (usage_date, user_id)
    );
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      event_type TEXT NOT NULL,
      job_id TEXT,
      user_id TEXT,
      session_key TEXT,
      payload_json TEXT NOT NULL
    );
    INSERT INTO daily_usage(usage_date, user_id, cost, input_tokens, output_tokens)
      VALUES ('LEGACY_DATE', 'U1', 1.5, 100, 50);
  `.replace("LEGACY_DATE", today));
  legacy.close();

  const migrated = new RunnerDatabase(filename);
  // Legacy daily_usage row is backfilled as a Slack record.
  assert.deepEqual(migrated.dailyUsage("slack", "", "U1"), { cost: 1.5, inputTokens: 100, outputTokens: 50 });
  // A different integration with the same user ID is not affected.
  assert.deepEqual(migrated.dailyUsage("discord", "", "U1"), { cost: 0, inputTokens: 0, outputTokens: 0 });
  migrated.close();

  // Reopening is idempotent.
  const reopened = new RunnerDatabase(filename);
  assert.deepEqual(reopened.dailyUsage("slack", "", "U1"), { cost: 1.5, inputTokens: 100, outputTokens: 50 });
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("Slack reporter edits its own working message when live updates are enabled", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const fakeClient = {
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
    deliveryMessageId: "1.1",
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

  // The persisted delivery message is edited in place; no second message and no
  // Slack-native stream is opened for the thread.
  assert(!calls.some((call) => call.kind === "post"));
  const update = calls.find((call) => call.kind === "update")?.value as Record<string, unknown>;
  assert.equal(update.channel, "D1");
  assert.equal(update.ts, "1.1");
  assert.equal(update.text, "hello");
});

test("runner rejects submissions for an integration with no authorization policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-no-policy-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const runner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    database,
    testExecutor(root, async () => Promise.reject(new Error("must not execute"))),
    audit,
    () => ({
      start: async () => undefined,
      append: async () => undefined,
      succeed: async () => undefined,
      fail: async () => undefined,
    }),
  );
  await runner.start();
  await assert.rejects(
    runner.submit({
      integration: "discord",
      sourceEventId: "discord-event-1",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "1.0",
      actorId: "U_ALLOWED",
      prompt: "hello from discord",
    }),
    AuthorizationError,
  );
  assert.equal(database.getJobBySourceEvent("discord", "discord-event-1"), undefined);
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("runner isolates per-principal limits across integrations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-cross-integration-"));
  const config = testConfig(root);
  // Add a Discord authorization rule alongside Slack so both are accepted.
  config.integrations.discord = { allowedTenants: ["T1"], allowedActors: ["U_SHARED"] };
  config.integrations.slack = { allowedTenants: ["T1"], allowedActors: ["U_SHARED"] };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);

  // Pre-insert a completed Slack job with usage so the Slack principal has a
  // daily budget entry. The Discord principal with the same actor ID must start
  // with a clean budget.
  database.insertJob("slack-done", {
    integration: "slack",
    sourceEventId: "slack-usage-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_SHARED",
    prompt: "work",
  });
  database.completeJob("slack-done", "succeeded", "done", null, { cost: 3, inputTokens: 10, outputTokens: 5 }, true);

  // Same actor ID, different integration: budget must be independent.
  assert.deepEqual(database.dailyUsage("slack", "T1", "U_SHARED"), { cost: 3, inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(database.dailyUsage("discord", "T1", "U_SHARED"), { cost: 0, inputTokens: 0, outputTokens: 0 });

  // Queue limits are also per-principal. Pre-insert a queued Slack job so the
  // Slack queue is full, then verify a second Slack submission is rejected
  // while a Discord submission with the same actor ID is accepted.
  config.limits.maxQueuedJobsPerUser = 1;
  database.insertJob("slack-queued", {
    integration: "slack",
    sourceEventId: "slack-queued-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "2.0",
    actorId: "U_SHARED",
    prompt: "queued slack work",
  });
  assert.equal(database.countJobs("slack", "T1", "U_SHARED", "queued"), 1);
  assert.equal(database.countJobs("discord", "T1", "U_SHARED", "queued"), 0);

  // The runner is not started so the pump does not claim jobs between
  // submissions; we are testing the submission boundary limit check only.
  const runner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    database,
    testExecutor(root, async () => Promise.reject(new Error("must not execute"))),
    audit,
    () => ({
      start: async () => undefined,
      append: async () => undefined,
      succeed: async () => undefined,
      fail: async () => undefined,
    }),
  );

  // Second Slack submission must be rejected: the Slack queue is full.
  await assert.rejects(
    runner.submit({
      integration: "slack",
      sourceEventId: "slack-second",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "2.1",
      actorId: "U_SHARED",
      prompt: "more slack work",
    }),
    /queue is full/i,
  );

  // The Discord principal with the same actor ID is unaffected: its queue
  // is empty, so the submission is accepted.
  const { job: discordJob } = await runner.submit({
    integration: "discord",
    sourceEventId: "discord-first",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "3.0",
    actorId: "U_SHARED",
    prompt: "discord work",
  });
  assert.equal(discordJob.integration, "discord");
  assert.equal(database.getJob(discordJob.id)?.integration, "discord");
  assert.equal(database.getJobBySourceEvent("slack", "slack-second"), undefined);

  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});
