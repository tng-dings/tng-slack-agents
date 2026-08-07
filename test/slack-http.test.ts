import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { App, HTTPReceiver } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { RunnerDatabase } from "../src/database.js";
import { SlackAdapter, SlackDurableEventHandler, SlackHttpIngress } from "../src/slack.js";
import type { JobRecord, JobSubmission } from "../src/types.js";
import { testConfig, waitFor } from "./helpers.js";

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

function slackBody(eventId: string, user = "U_ALLOWED"): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T1",
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
      return { job: {} as JobRecord, isNew: true };
    },
  });

  const receiver = new HTTPReceiver({
    signingSecret,
    endpoints: "/slack/events",
    processBeforeResponse: true,
    signatureVerification: true,
    customRoutes: [{
      path: "/healthz",
      method: "GET",
      handler: (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
      },
    }],
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
  const ingress = new SlackHttpIngress(app, receiver, handler, "127.0.0.1", 0);
  const server = await ingress.start();
  const port = (server.address() as AddressInfo).port;
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
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
  assert.equal(calls.length, 1);

  await ingress.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
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
      return { job: {} as JobRecord, isNew: true };
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
