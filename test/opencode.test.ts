import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import { OpenCodeError } from "../src/errors.js";
import { OpenCodeExecutor } from "../src/opencode.js";
import { parseEvent, parseMessage } from "../src/opencode-protocol.js";
import { AgentRunner } from "../src/runner.js";
import { WorkspaceManager } from "../src/workspace.js";
import { persistSessionExecution, testAuthorizationPolicy, testConfig, waitFor } from "./helpers.js";

function openCodeSession(id: string, directory: string, title = "Test session") {
  return {
    id,
    projectID: "test-project",
    directory,
    title,
    version: "test",
    time: { created: 1, updated: 1 },
  };
}

test("OpenCode protocol rejects error-bearing assistant messages and surfaces session errors", () => {
  assert.throws(
    () => parseMessage({
      info: {
        error: { name: "ProviderAuthError", data: { message: "must not be exposed" } },
        cost: 0,
        tokens: { input: 0, output: 0 },
      },
      parts: [],
    }),
    (error: unknown) => error instanceof OpenCodeError && error.code === "OPENCODE_PROVIDER_ERROR",
  );
  assert.deepEqual(
    parseEvent({
      type: "session.error",
      properties: {
        sessionID: "failed-session",
        error: { name: "APIError", data: { message: "must not be exposed" } },
      },
    }),
    { kind: "error", sessionId: "failed-session" },
  );
  assert.deepEqual(
    parseEvent({
      type: "session.error",
      properties: { sessionID: "failed-session", error: { name: "must-not-be-audited" } },
    }),
    { kind: "error", sessionId: "failed-session" },
  );
});

test("OpenCode protocol accepts the empty text part used to initialize streaming", () => {
  const part = {
    id: "part-1",
    sessionID: "streaming-session",
    messageID: "message-1",
    type: "text",
    text: "",
  };
  assert.deepEqual(
    parseEvent({
      type: "message.part.updated",
      properties: { part },
    }),
    { kind: "ignored", eventType: "message.part.updated" },
  );
  assert.deepEqual(
    parseEvent({
      type: "message.part.updated",
      properties: { part, delta: "" },
    }),
    { kind: "text", sessionId: "streaming-session", delta: "" },
  );
  assert.equal(
    parseMessage({
      info: { cost: 0, tokens: { input: 0, output: 0 } },
      parts: [part],
    }).parts[0]?.text,
    "",
  );
});

test("OpenCode cleanup removes a known worktree without a provider session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-cleanup-"));
  const config = testConfig(root);
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const workingDirectory = path.join(root, "worktree");
  let cleanedDirectory: string | undefined;
  const workspaces = {
    cleanup: async (directory: string) => { cleanedDirectory = directory; },
  } as unknown as WorkspaceManager;
  const executor = new OpenCodeExecutor(config.openCode, "password", workspaces, audit);
  await executor.cleanup({
    sessionKey: "local:local:cli:cleanup",
    integration: "local",
    tenantId: "local",
    conversationId: "cli",
    threadId: "cleanup",
    providerId: "opencode",
    providerSessionId: null,
    workingDirectory,
    executionGeneration: 1,
    reconciliationRequired: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.equal(cleanedDirectory, workingDirectory);
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("OpenCode executor sends file parts for image attachments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-attach-opencode-"));
  const repository = path.join(root, "repository");
  await writeFile(path.join(root, "placeholder"), "placeholder");
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Agent Runner Test"]);
  await writeFile(path.join(repository, "README.md"), "fixture");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);

  const subscribers = new Set<ServerResponse>();
  let capturedBody: unknown;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/global/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      subscribers.add(response);
      request.on("close", () => subscribers.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end("[]");
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(openCodeSession("session-attach", url.searchParams.get("directory") ?? repository)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/session-attach") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(openCodeSession("session-attach", url.searchParams.get("directory") ?? repository)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/session-attach/message") {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        capturedBody = JSON.parse(raw);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          info: { cost: 0.1, tokens: { input: 5, output: 1 } },
          parts: [{ type: "text", text: "I see the screenshot" }],
        }));
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = {
    ...config.openCode,
    baseUrl: `http://127.0.0.1:${address.port}`,
    workingRepository: repository,
  };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(repository, config.storage.worktreeRoot),
    audit,
  );
  const job = database.insertJob("job-attach", {
    integration: "slack",
    sourceEventId: "event-attach",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_ALLOWED",
    prompt: "What is in this screenshot?",
    attachments: [{ mime: "image/png", filename: "screen.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }],
  });
  const prepared = await executor.prepareSession(job, database.getSession(job.sessionKey)!, {
    onWorkingDirectory: (workingDirectory) => database.updateSessionWorkingDirectory(job.sessionKey, workingDirectory),
  }, AbortSignal.timeout(2_000));
  database.updateSessionProviderSession(job.sessionKey, prepared.providerId, prepared.providerSessionId);
  await executor.executeTurn(job, prepared, {
    onText: () => undefined,
    onTool: () => undefined,
    onUsage: () => undefined,
  }, AbortSignal.timeout(2_000));

  assert(typeof capturedBody === "object" && capturedBody !== null);
  const body = capturedBody as { parts: { type: string; mime?: string; filename?: string; url?: string; text?: string }[] };
  assert(Array.isArray(body.parts));
  assert.equal(body.parts.length, 2);
  const textPart = body.parts[0]!;
  const filePart = body.parts[1]!;
  assert.equal(textPart.type, "text");
  assert.equal(textPart.text, "What is in this screenshot?");
  assert.equal(filePart.type, "file");
  assert.equal(filePart.mime, "image/png");
  assert.equal(filePart.filename, "screen.png");
  assert.equal(filePart.url, "data:image/png;base64,iVBORw0KGgo=");

  await audit.flush();
  database.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

test("OpenCode executor creates a worktree, streams events, and returns usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-"));
  const repository = path.join(root, "repository");
  await writeFile(path.join(root, "placeholder"), "placeholder");
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Agent Runner Test"]);
  await writeFile(path.join(repository, "README.md"), "fixture");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);

  const subscribers = new Set<ServerResponse>();
  const directories: string[] = [];
  let sawAuthorization = false;
  let deletedSession = false;
  const server = createServer((request, response) => {
    sawAuthorization ||= request.headers.authorization === `Basic ${Buffer.from("opencode:test-password").toString("base64")}`;
    const url = new URL(request.url ?? "/", "http://localhost");
    const directory = url.searchParams.get("directory");
    if (directory) directories.push(directory);
    if (request.method === "GET" && url.pathname === "/global/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ healthy: true, version: "test" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      subscribers.add(response);
      request.on("close", () => subscribers.delete(response));
      return;
    }
    if (request.method === "GET" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end("[]");
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(openCodeSession("session-1", url.searchParams.get("directory") ?? repository)));
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/session-1") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(openCodeSession("session-1", url.searchParams.get("directory") ?? repository)));
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/session/session-1") {
      deletedSession = true;
      response.setHeader("content-type", "application/json");
      response.end("true");
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/session-1/message") {
      const events = [
        { type: "future.provider.event", properties: { prompt: "must not be audited" } },
        {
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "session-1", text: "Hello " }, delta: "Hello " },
        },
        {
          type: "message.part.updated",
          properties: {
            part: { type: "tool", sessionID: "session-1", callID: "call-1", tool: "read", state: { status: "completed" } },
          },
        },
        {
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "session-1", text: "Hello world" }, delta: "world" },
        },
        {
          type: "message.updated",
          properties: { info: { sessionID: "session-1", role: "assistant", cost: 0.25, tokens: { input: 12, output: 3 } } },
        },
      ];
      for (const event of events) {
        for (const subscriber of subscribers) subscriber.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            info: { sessionID: "session-1", role: "assistant", cost: 0.25, tokens: { input: 12, output: 3 } },
            parts: [{ type: "text", text: "Hello world" }],
          }),
        );
      }, 20);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = {
    ...config.openCode,
    baseUrl: `http://127.0.0.1:${address.port}`,
    workingRepository: repository,
  };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(repository, config.storage.worktreeRoot),
    audit,
  );
  const job = database.insertJob("job-1", {
    integration: "slack",
    sourceEventId: "event-1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    actorId: "U_ALLOWED",
    prompt: "Say hello",
  });
  const deltas: string[] = [];
  const tools: unknown[] = [];
  const prepared = await executor.prepareSession(
    job,
    database.getSession(job.sessionKey)!,
    { onWorkingDirectory: (workingDirectory) => database.updateSessionWorkingDirectory(job.sessionKey, workingDirectory) },
    AbortSignal.timeout(2_000),
  );
  database.updateSessionProviderSession(job.sessionKey, prepared.providerId, prepared.providerSessionId);
  const result = await executor.executeTurn(
    job,
    prepared,
    {
      onText: (delta) => {
        deltas.push(delta);
      },
      onTool: (event) => {
        tools.push(event);
      },
      onUsage: () => undefined,
    },
    AbortSignal.timeout(2_000),
  );

  assert.equal(result.output, "Hello world");
  assert.deepEqual(result.usage, { cost: 0.25, inputTokens: 12, outputTokens: 3 });
  assert.equal(deltas.join(""), "Hello world");
  assert.equal(tools.length, 1);
  assert.equal(sawAuthorization, true);
  assert(directories.some((directory) => directory.includes("worktrees")));
  assert.match(prepared.workingDirectory, /worktrees/);
  assert.match(await readFile(path.join(prepared.workingDirectory, "README.md"), "utf8"), /fixture/);
  await waitFor(() => subscribers.size === 0);
  assert.equal(subscribers.size, 0, "completed turns must close their SSE subscription");
  await executor.cleanup({
    ...database.getSession(job.sessionKey)!,
    providerId: prepared.providerId,
    providerSessionId: prepared.providerSessionId,
    workingDirectory: prepared.workingDirectory,
  });
  assert.equal(deletedSession, true);
  await assert.rejects(readFile(prepared.workingDirectory, "utf8"), /ENOENT/);

  await audit.flush();
  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  assert.match(auditText, /"eventType":"opencode_unknown_event"/);
  assert.match(auditText, /"eventType":"future.provider.event"/);
  assert.doesNotMatch(auditText, /must not be audited/);
  database.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

test("first-turn provisioning failures persist and recover the worktree and OpenCode session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-boundaries-"));
  const repository = path.join(root, "repository");
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Agent Runner Test"]);
  await writeFile(path.join(repository, "README.md"), "boundary fixture");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "fixture"]);

  const subscribers = new Set<ServerResponse>();
  let createAttempts = 0;
  let messageAttempts = 0;
  let createdSession: ReturnType<typeof openCodeSession> | undefined;
  const directories: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const directory = url.searchParams.get("directory") ?? "";
    if (directory) directories.push(directory);
    if (request.method === "GET" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(createdSession ? [createdSession] : []));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      createAttempts += 1;
      let raw = "";
      request.on("data", (chunk) => { raw += chunk; });
      request.on("end", () => {
        if (createAttempts === 1) {
          response.statusCode = 500;
          response.end("session creation unavailable");
          return;
        }
        const body = JSON.parse(raw) as { title: string };
        createdSession = openCodeSession(
          createAttempts === 2 ? "session-boundary" : "session-replacement",
          directory,
          body.title,
        );
        response.setHeader("content-type", "application/json");
        // Simulate a crash/transport ambiguity after OpenCode has durably
        // created the session but before its ID can be persisted locally.
        response.end(JSON.stringify(createAttempts === 2 ? { created: true } : createdSession));
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/session-boundary") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(createdSession));
      return;
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      subscribers.add(response);
      request.on("close", () => subscribers.delete(response));
      return;
    }
    if (request.method === "POST" && [
      "/session/session-boundary/message",
      "/session/session-replacement/message",
    ].includes(url.pathname)) {
      messageAttempts += 1;
      if (url.pathname === "/session/session-boundary/message") {
        response.statusCode = 500;
        response.end("message unavailable");
      } else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          info: { cost: 0.1, tokens: { input: 3, output: 1 } },
          parts: [{ type: "text", text: "recovered" }],
        }));
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/session-boundary/abort") {
      response.setHeader("content-type", "application/json");
      response.end("true");
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/status") {
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = { ...config.openCode, baseUrl: `http://127.0.0.1:${address.port}`, workingRepository: repository };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(repository, config.storage.worktreeRoot),
    audit,
  );
  const runner = new AgentRunner(config, testAuthorizationPolicy(config), database, executor, audit, () => ({
    start: async () => undefined,
    append: async () => undefined,
    succeed: async () => undefined,
    fail: async () => undefined,
  }));
  await runner.start();
  const submission = (sourceEventId: string) => ({
    integration: "slack" as const,
    sourceEventId,
    tenantId: "T1",
    conversationId: "D1",
    threadId: "boundary-thread",
    actorId: "U_ALLOWED",
    prompt: "recover provisioning",
  });

  const first = await runner.submit(submission("boundary-1"));
  await waitFor(() => database.getJob(first.job.id)?.status === "failed");
  const afterWorktreeFailure = database.getSession(first.job.sessionKey)!;
  assert(afterWorktreeFailure.workingDirectory);
  assert.equal(afterWorktreeFailure.providerSessionId, null);
  assert.match(await readFile(path.join(afterWorktreeFailure.workingDirectory, "README.md"), "utf8"), /boundary fixture/);

  const second = await runner.submit(submission("boundary-2"));
  await waitFor(() => database.getJob(second.job.id)?.status === "failed");
  assert.equal(database.getSession(second.job.sessionKey)?.providerSessionId, null);
  assert(createdSession, "OpenCode session should exist despite the invalid create response");

  const third = await runner.submit(submission("boundary-3"));
  await waitFor(() => database.getJob(third.job.id)?.status === "failed");
  assert.equal(database.getSession(third.job.sessionKey)?.providerSessionId, null);
  assert.equal(database.getSession(third.job.sessionKey)?.executionGeneration, 1);

  const fourth = await runner.submit(submission("boundary-4"));
  await waitFor(() => database.getJob(fourth.job.id)?.status === "succeeded");
  assert.equal(database.getJob(fourth.job.id)?.output, "recovered");
  assert.equal(database.getSession(fourth.job.sessionKey)?.providerSessionId, "session-replacement");
  assert.equal(createAttempts, 3);
  assert.equal(messageAttempts, 2);
  assert(directories.every((value) => value === afterWorktreeFailure.workingDirectory));

  await runner.stop();
  await audit.flush();
  database.close();
  for (const subscriber of subscribers) subscriber.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

test("OpenCode reconciliation aborts an interrupted session and confirms idle status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-reconcile-"));
  let abortCalls = 0;
  let statusCalls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST" && url.pathname === "/session/interrupted-session/abort") {
      abortCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end("true");
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/status") {
      statusCalls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        "interrupted-session": { type: statusCalls === 1 ? "busy" : "idle" },
      }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = { ...config.openCode, baseUrl: `http://127.0.0.1:${address.port}` };
  const database = new RunnerDatabase(config.storage.databasePath);
  const job = database.insertJob("interrupted-job", {
    integration: "slack",
    sourceEventId: "interrupted-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "interrupted-thread",
    actorId: "U_ALLOWED",
    prompt: "interrupted",
  });
  persistSessionExecution(database, job.sessionKey, "opencode", "interrupted-session", path.join(root, "worktree"));
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(root, config.storage.worktreeRoot),
    audit,
  );
  await executor.reconcileSession(database.getSession(job.sessionKey)!, AbortSignal.timeout(2_000));
  assert.equal(abortCalls, 1);
  assert.equal(statusCalls, 2);

  await audit.flush();
  database.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

test("OpenCode health rejects schema mismatches and unapproved versions before work", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-health-schema-"));
  let healthResponse: unknown = { healthy: true };
  let healthStatus = 200;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/global/health") {
      response.statusCode = healthStatus;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(healthResponse));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = { ...config.openCode, baseUrl: `http://127.0.0.1:${address.port}`, approvedVersions: ["1.2.3"] };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(root, config.storage.worktreeRoot),
    audit,
  );

  await assert.rejects(executor.health(), (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: string }).code === "OPENCODE_SCHEMA_MISMATCH"
  );
  healthResponse = { healthy: true, version: "1.2.4" };
  await assert.rejects(executor.health(), (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: string }).code === "OPENCODE_VERSION_UNAPPROVED"
  );
  healthResponse = { healthy: true, version: "1.2.3" };
  assert.deepEqual(await executor.health(), healthResponse);
  healthStatus = 500;
  healthResponse = { error: "provider response must not enter logs" };
  await assert.rejects(executor.health(), (error: unknown) =>
    error instanceof OpenCodeError && error.code === "OPENCODE_HTTP_ERROR" &&
    !error.message.includes("provider response must not enter logs")
  );

  await audit.flush();
  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  assert.match(auditText, /opencode_schema_mismatch/);
  assert.match(auditText, /opencode_version_rejected/);
  database.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});

test("malformed known OpenCode events fail the turn and audit only shape metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-opencode-event-schema-"));
  const subscribers = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      subscribers.add(response);
      request.on("close", () => subscribers.delete(response));
      response.write(`data: ${JSON.stringify({
        type: "message.updated",
        properties: { info: { sessionID: "strict-session", role: "assistant", secret: "must-not-be-audited" } },
      })}\n\n`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/strict-session/message") {
      setTimeout(() => {
        if (!response.destroyed) {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            info: { cost: 0, tokens: { input: 1, output: 1 } },
            parts: [{ type: "text", text: "too late" }],
          }));
        }
      }, 500).unref();
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const config = testConfig(root);
  config.openCode = { ...config.openCode, baseUrl: `http://127.0.0.1:${address.port}` };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database, ["test-password"]);
  const executor = new OpenCodeExecutor(
    config.openCode,
    "test-password",
    new WorkspaceManager(root, config.storage.worktreeRoot),
    audit,
  );
  const job = database.insertJob("strict-event-job", {
    integration: "slack",
    sourceEventId: "strict-event",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "strict-thread",
    actorId: "U_ALLOWED",
    prompt: "work",
  });
  await assert.rejects(
    executor.executeTurn(
      job,
      { providerId: "opencode", providerSessionId: "strict-session", workingDirectory: root },
      { onText: () => undefined, onTool: () => undefined, onUsage: () => undefined },
      AbortSignal.timeout(2_000),
    ),
    (error: unknown) => typeof error === "object" && error !== null &&
      (error as { code?: string }).code === "OPENCODE_SCHEMA_MISMATCH",
  );
  await audit.flush();
  const auditText = await readFile(config.storage.auditLogPath, "utf8");
  assert.match(auditText, /opencode_schema_mismatch/);
  assert.doesNotMatch(auditText, /must-not-be-audited/);

  database.close();
  for (const subscriber of subscribers) subscriber.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});
