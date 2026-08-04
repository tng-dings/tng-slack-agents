import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import { OpenCodeExecutor } from "../src/opencode.js";
import { WorkspaceManager } from "../src/workspace.js";
import { testConfig } from "./helpers.js";

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
    if (request.method === "POST" && url.pathname === "/session") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "session-1" }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/session-1") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "session-1" }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/session-1/message") {
      const events = [
        {
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "session-1" }, delta: "Hello " },
        },
        {
          type: "message.part.updated",
          properties: {
            part: { type: "tool", sessionID: "session-1", tool: "read", state: { status: "completed" } },
          },
        },
        {
          type: "message.part.updated",
          properties: { part: { type: "text", sessionID: "session-1" }, delta: "world" },
        },
        {
          type: "message.updated",
          properties: { info: { sessionID: "session-1", cost: 0.25, tokens: { input: 12, output: 3 } } },
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
    sourceEventId: "event-1",
    workspaceId: "T1",
    channelId: "D1",
    threadTs: "1.0",
    userId: "U_ALLOWED",
    prompt: "Say hello",
  });
  const deltas: string[] = [];
  const tools: unknown[] = [];
  const result = await executor.execute(
    job,
    database.getSession(job.sessionKey)!,
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
  assert.match(result.workingDirectory, /worktrees/);
  assert.match(await readFile(path.join(result.workingDirectory, "README.md"), "utf8"), /fixture/);

  await audit.flush();
  database.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await rm(root, { recursive: true, force: true });
});
