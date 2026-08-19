import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { App, HTTPReceiver } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { RunnerDatabase } from "../src/database.js";
import {
  SlackAdapter,
  SlackDurableEventHandler,
  SlackHttpIngress,
  SlackHttpSecurityLogger,
} from "../src/slack.js";
import type { JobSubmission } from "../src/types.js";
import { testConfig, testJob, waitFor } from "./helpers.js";

const signingSecret = "test-signing-secret";

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("HTTP acknowledgement was not sent promptly")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1_000)): Record<string, string> {
  const signature = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  };
}

function slackBody(eventId: string, user = "U_ALLOWED", team = "T1"): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: team,
    api_app_id: "A1",
    event_id: eventId,
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user,
      ts: "100.1",
      text: "investigate",
    },
  };
}

function clientDouble(calls: unknown[]): WebClient {
  return {
    chat: {
      postMessage: async (value: unknown) => {
        calls.push(value);
        return { ok: true, ts: "reply-ts" };
      },
    },
    assistant: { threads: { setSuggestedPrompts: async () => ({ ok: true }) } },
  } as unknown as WebClient;
}

async function rawIncompleteRequest(port: number, request: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for hardened HTTP rejection"));
    }, 2_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", (error) => {
      if (response) finish();
      else reject(error);
    });
  });
}

test("Slack HTTP ingress commits before acknowledgement and deduplicates retries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-slack-http-"));
  const config = testConfig(root);
  config.slack.enabled = true;
  config.slack.ingress = "events-api";
  config.slack.appId = "A1";
  const database = new RunnerDatabase(config.storage.databasePath);
  const calls: unknown[] = [];
  const adapter = new SlackAdapter(
    config,
    { openCodePassword: "password", slackBotToken: "xoxb-test", slackSigningSecret: signingSecret },
    clientDouble(calls),
  );
  let releaseSubmission!: () => void;
  const submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve; });
  const submissions: JobSubmission[] = [];
  adapter.attachRunner({
    submit: async (submission) => {
      submissions.push(submission);
      await submissionGate;
      return { job: testJob(), isNew: true };
    },
  });

  const receiver = new HTTPReceiver({
    signingSecret,
    endpoints: "/slack/events",
    logger: new SlackHttpSecurityLogger(),
    processBeforeResponse: true,
    signatureVerification: true,
  });
  const app = new App({
    token: "xoxb-test",
    botId: "B1",
    botUserId: "U_BOT",
    receiver,
    tokenVerificationEnabled: false,
    ignoreSelf: false,
  });
  const handler = new SlackDurableEventHandler(database, adapter, 5);
  const ingress = new SlackHttpIngress(app, receiver, handler, {
    ...config.slack.http,
    port: 0,
    maxBodyBytes: 1_024,
    maxHeaderBytes: 1_024,
    requestTimeoutMs: 250,
    headersTimeoutMs: 250,
  });
  const server = await ingress.start();
  const port = (server.address() as AddressInfo).port;
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");

  const wrongMethod = await fetch(`http://127.0.0.1:${port}/slack/events`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(await wrongMethod.text(), "");
  const wrongHealthMethod = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST" });
  assert.equal(wrongHealthMethod.status, 405);
  const wrongPath = await fetch(`http://127.0.0.1:${port}/not-public`);
  assert.equal(wrongPath.status, 404);
  const queryPath = await fetch(`http://127.0.0.1:${port}/slack/events?debug=true`, { method: "POST" });
  assert.equal(queryPath.status, 404);

  const malformedBody = '{"private":"prompt-fragment"';
  const malformed = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(malformedBody),
    body: malformedBody,
  });
  assert.equal(malformed.status, 400);
  assert.equal(calls.length, 0);

  const oversizedBody = "x".repeat(1_025);
  const oversized = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(oversizedBody),
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, 0);

  const oversizedHeaderResponse = await rawIncompleteRequest(port,
    `POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Oversized: ${"a".repeat(1_100)}\r\nContent-Length: 0\r\n\r\n`);
  assert.match(oversizedHeaderResponse, /^HTTP\/1\.1 431 /);

  const oversizedChunkedResponse = await rawIncompleteRequest(
    port,
    "POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: chunked\r\n\r\n401\r\n"
      + "x".repeat(1_025) + "\r\n0\r\n\r\n",
  );
  assert.match(oversizedChunkedResponse, /^HTTP\/1\.1 413 /);

  const slowResponse = await rawIncompleteRequest(port,
    "POST /slack/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{");
  assert.match(slowResponse, /^HTTP\/1\.1 408 /);
  assert.equal(calls.length, 0);
  const body = JSON.stringify(slackBody("Ev-http-1"));

  const response = await within(fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  }), 1_000);
  assert.equal(response.status, 200);
  assert(database.getInboundEvent("slack", "Ev-http-1"));
  await waitFor(() => submissions.length === 1);

  const retry = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: { ...signedHeaders(body), "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" },
    body,
  });
  assert.equal(retry.status, 200);
  assert.equal(submissions.length, 1);

  const invalidBody = JSON.stringify(slackBody("Ev-invalid-signature"));
  const invalid = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: { ...signedHeaders(invalidBody), "x-slack-signature": "v0=invalid" },
    body: invalidBody,
  });
  assert.equal(invalid.status, 401);
  assert.equal(database.getInboundEvent("slack", "Ev-invalid-signature"), undefined);

  const staleBody = JSON.stringify(slackBody("Ev-stale"));
  const stale = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(staleBody, Math.floor(Date.now() / 1_000) - 600),
    body: staleBody,
  });
  assert.equal(stale.status, 401);
  assert.equal(database.getInboundEvent("slack", "Ev-stale"), undefined);

  const challengeBody = JSON.stringify({ type: "url_verification", challenge: "challenge-value" });
  const challenge = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(challengeBody),
    body: challengeBody,
  });
  assert.equal(challenge.status, 200);
  assert.equal((await challenge.json() as { challenge: string }).challenge, "challenge-value");

  const deniedBody = JSON.stringify(slackBody("Ev-denied", "U_DENIED"));
  const denied = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(deniedBody),
    body: deniedBody,
  });
  assert.equal(denied.status, 200);
  assert.equal(database.getInboundEvent("slack", "Ev-denied"), undefined);
  await waitFor(() => calls.length === 1);

  const wrongWorkspaceBody = JSON.stringify(slackBody("Ev-wrong-workspace", "U_ALLOWED", "T_OTHER"));
  const wrongWorkspace = await fetch("http://127.0.0.1:" + port + "/slack/events", {
    method: "POST",
    headers: signedHeaders(wrongWorkspaceBody),
    body: wrongWorkspaceBody,
  });
  assert.equal(wrongWorkspace.status, 200);
  assert.equal(database.getInboundEvent("slack", "Ev-wrong-workspace"), undefined);
  await waitFor(() => calls.length === 2);

  const wrongAppPayload = { ...slackBody("Ev-wrong-app"), api_app_id: "A_OTHER" };
  const wrongAppBody = JSON.stringify(wrongAppPayload);
  const wrongApp = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: signedHeaders(wrongAppBody),
    body: wrongAppBody,
  });
  assert.equal(wrongApp.status, 200);
  assert.equal(database.getInboundEvent("slack", "Ev-wrong-app"), undefined);

  releaseSubmission();
  await waitFor(() => database.getInboundEvent("slack", "Ev-http-1")?.status === "processed");
  assert.deepEqual(database.getInboundEvent("slack", "Ev-http-1")?.payload, {});
  assert.equal(calls.length, 2);

  await ingress.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("Slack HTTP rejection logging is content-free and rate limited", () => {
  const lines: string[] = [];
  let now = 1_000;
  const logger = new SlackHttpSecurityLogger(
    {
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    },
    2,
    () => now,
  );
  for (let index = 0; index < 10; index += 1) {
    logger.warn("Malformed request body: secret-signature prompt-fragment attachment-name");
  }
  assert.deepEqual(lines, [
    "Slack HTTP request rejected as malformed.",
    "Slack HTTP request rejected as malformed.",
    "Further Slack HTTP receiver failures suppressed for this minute.",
  ]);
  assert.doesNotMatch(lines.join(" "), /secret-signature|prompt-fragment|attachment-name/);

  now += 60_000;
  logger.warn("Malformed request body: another-secret");
  assert.equal(lines.at(-1), "Slack HTTP request rejected as malformed.");
});

test("Slack inbox recovers an event claimed before restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-slack-inbox-recovery-"));
  const config = testConfig(root);
  const first = new RunnerDatabase(config.storage.databasePath);
  first.insertInboundEvent("slack", "Ev-recover", {
    message: {
      sourceEventId: "Ev-recover",
      tenantId: "T1",
      conversationId: "D1",
      threadId: "100.1",
      actorId: "U_ALLOWED",
      text: "recover me",
      files: [],
    },
  });
  assert.equal(first.claimNextInboundEvent("slack")?.status, "processing");
  first.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const adapter = new SlackAdapter(
    config,
    { openCodePassword: "password", slackBotToken: "xoxb-test" },
    clientDouble([]),
  );
  const submissions: JobSubmission[] = [];
  adapter.attachRunner({
    submit: async (submission) => {
      submissions.push(submission);
      return { job: testJob(), isNew: true };
    },
  });
  const handler = new SlackDurableEventHandler(reopened, adapter, 5);
  handler.start();
  await waitFor(() => reopened.getInboundEvent("slack", "Ev-recover")?.status === "processed");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.prompt, "recover me");

  await handler.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});
