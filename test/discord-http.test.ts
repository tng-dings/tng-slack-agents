import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger } from "../src/audit.js";
import { RunnerDatabase } from "../src/database.js";
import {
  DiscordAdapter,
  DiscordDurableInteractionHandler,
  DiscordHttpIngress,
  DiscordHttpSecurityLogger,
  type DiscordApi,
  type DiscordSessionApi,
  type ParsedDiscordCommand,
} from "../src/discord.js";
import { AgentRunner } from "../src/runner.js";
import type { Executor, JobRecord, JobSubmission } from "../src/types.js";
import { testAuthorizationPolicy, testConfig, testExecutor, waitFor } from "./helpers.js";

const keyPair = generateKeyPairSync("ed25519");
const publicKeyDer = keyPair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
const publicKey = publicKeyDer.subarray(publicKeyDer.length - 32).toString("hex");

function interaction(id: string, user = "U_ALLOWED", guild = "G1"): Record<string, unknown> {
  return {
    id,
    application_id: "APP1",
    type: 2,
    token: "short-lived-token-must-not-be-persisted",
    guild_id: guild,
    channel_id: "C1",
    channel: { id: "C1", type: 0 },
    member: { user: { id: user } },
    data: {
      id: "COMMAND1",
      name: "agent",
      type: 1,
      options: [{ name: "prompt", type: 3, value: "investigate" }],
    },
  };
}

function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1_000)): Record<string, string> {
  const timestampText = String(timestamp);
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestampText), Buffer.from(body)]),
    keyPair.privateKey,
  ).toString("hex");
  return {
    "content-type": "application/json",
    "x-signature-ed25519": signature,
    "x-signature-timestamp": timestampText,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Discord acknowledgement was not sent promptly")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function apiDouble(): DiscordSessionApi {
  return {
    createMessage: async () => ({ id: "message" }),
    editMessage: async () => undefined,
    createThreadFromMessage: async (_channelId, messageId) => ({ id: messageId }),
    getThread: async () => undefined,
    replyToInteraction: async () => undefined,
  };
}

test("Discord HTTPS ingress verifies, commits, acknowledges promptly, and deduplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-discord-http-"));
  const config = testConfig(root);
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U_ALLOWED"];
  config.discord.http.port = 0;
  config.discord.http.maxBodyBytes = 1_024;
  config.discord.http.maxHeaderBytes = 1_024;
  config.discord.http.requestTimeoutMs = 500;
  config.discord.http.headersTimeoutMs = 500;
  const database = new RunnerDatabase(config.storage.databasePath);
  const adapter = new DiscordAdapter(config, apiDouble(), database, []);
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
  const handler = new DiscordDurableInteractionHandler(database, adapter, 5);
  const ingress = new DiscordHttpIngress(adapter, handler, publicKey, config.discord.http);
  const server = await ingress.start();
  const port = (server.address() as AddressInfo).port;

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  const wrongMethod = await fetch(`http://127.0.0.1:${port}/discord/interactions`);
  assert.equal(wrongMethod.status, 405);
  const wrongPath = await fetch(`http://127.0.0.1:${port}/not-public`);
  assert.equal(wrongPath.status, 404);
  const queryPath = await fetch(`http://127.0.0.1:${port}/discord/interactions?debug=true`, { method: "POST" });
  assert.equal(queryPath.status, 404);

  const pingBody = JSON.stringify({ type: 1 });
  const ping = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(pingBody),
    body: pingBody,
  });
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { type: 1 });

  const body = JSON.stringify(interaction("100000000000000001"));
  const accepted = await within(fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  }), 1_000);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json() as { type: number }).type, 4);
  const persisted = database.getInboundEvent("discord", "100000000000000001");
  assert(persisted);
  assert.doesNotMatch(JSON.stringify(persisted.payload), /short-lived-token/);
  await waitFor(() => submissions.length === 1);

  const duplicate = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  });
  assert.equal(duplicate.status, 200);
  assert.equal(submissions.length, 1);

  const invalidBody = JSON.stringify(interaction("100000000000000002"));
  const invalid = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: { ...signedHeaders(invalidBody), "x-signature-ed25519": "0".repeat(128) },
    body: invalidBody,
  });
  assert.equal(invalid.status, 401);
  assert.equal(database.getInboundEvent("discord", "100000000000000002"), undefined);

  const staleBody = JSON.stringify(interaction("100000000000000003"));
  const stale = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(staleBody, Math.floor(Date.now() / 1_000) - 600),
    body: staleBody,
  });
  assert.equal(stale.status, 401);
  assert.equal(database.getInboundEvent("discord", "100000000000000003"), undefined);

  const deniedBody = JSON.stringify(interaction("100000000000000004", "U_DENIED"));
  const denied = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(deniedBody),
    body: deniedBody,
  });
  assert.equal(denied.status, 200);
  const denial = await denied.json() as { data: { flags: number } };
  assert.equal(denial.data.flags, 64);
  assert.equal(database.getInboundEvent("discord", "100000000000000004"), undefined);

  const wrongGuildBody = JSON.stringify(interaction("100000000000000005", "U_ALLOWED", "G_OTHER"));
  const wrongGuild = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(wrongGuildBody),
    body: wrongGuildBody,
  });
  assert.equal(wrongGuild.status, 200);
  assert.equal(database.getInboundEvent("discord", "100000000000000005"), undefined);

  const wrongAppPayload = { ...interaction("100000000000000006"), application_id: "APP_OTHER" };
  const wrongAppBody = JSON.stringify(wrongAppPayload);
  const wrongApp = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(wrongAppBody),
    body: wrongAppBody,
  });
  assert.equal(wrongApp.status, 200);
  assert.equal(database.getInboundEvent("discord", "100000000000000006"), undefined);

  const malformedBody = "{private-prompt";
  const malformed = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(malformedBody),
    body: malformedBody,
  });
  assert.equal(malformed.status, 400);

  const oversizedBody = "x".repeat(1_025);
  const oversized = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(oversizedBody),
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);

  releaseSubmission();
  await waitFor(() => database.getInboundEvent("discord", "100000000000000001")?.status === "processed");
  assert.deepEqual(database.getInboundEvent("discord", "100000000000000001")?.payload, {});

  await ingress.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("Discord inbox recovers a sanitized interaction claimed before restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-discord-recovery-"));
  const config = testConfig(root);
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U_ALLOWED"];
  const command: ParsedDiscordCommand = {
    sourceEventId: "recover-interaction",
    applicationId: "APP1",
    tenantId: "G1",
    conversationId: "C1",
    threadId: "recover-interaction",
    actorId: "U_ALLOWED",
    prompt: "recover me",
  };
  const first = new RunnerDatabase(config.storage.databasePath);
  first.insertInboundEvent("discord", command.sourceEventId, { command });
  assert.equal(first.claimNextInboundEvent("discord")?.status, "processing");
  first.close();

  const reopened = new RunnerDatabase(config.storage.databasePath);
  const adapter = new DiscordAdapter(config, apiDouble(), reopened, []);
  const submissions: JobSubmission[] = [];
  adapter.attachRunner({
    submit: async (submission) => {
      submissions.push(submission);
      return { job: {} as JobRecord, isNew: true };
    },
  });
  const handler = new DiscordDurableInteractionHandler(reopened, adapter, 5);
  handler.start();
  await waitFor(() => reopened.getInboundEvent("discord", command.sourceEventId)?.status === "processed");
  assert.equal(submissions[0]?.prompt, "recover me");
  await handler.stop();
  reopened.close();
  await rm(root, { recursive: true, force: true });
});

test("allowlisted Discord slash command completes through the generic runner and Discord reporter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-discord-e2e-"));
  const config = testConfig(root);
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U_ALLOWED"];
  config.discord.http.port = 0;
  config.integrations.discord = { allowedTenants: ["G1"], allowedActors: ["U_ALLOWED"] };
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(config.storage.auditLogPath, database);
  const calls: Array<{ kind: "create" | "edit"; content: string }> = [];
  const api: DiscordSessionApi = {
    createMessage: async (_channelId, content) => {
      calls.push({ kind: "create", content });
      return { id: "discord-working-message" };
    },
    editMessage: async (_channelId, _messageId, content) => {
      calls.push({ kind: "edit", content });
    },
    createThreadFromMessage: async (_channelId, messageId) => ({ id: messageId }),
    getThread: async () => undefined,
    replyToInteraction: async () => undefined,
  };
  const adapter = new DiscordAdapter(config, api, database, []);
  const executor: Executor = testExecutor(root, async () => ({
      output: "completed through discord",
      usage: { cost: 0, inputTokens: 1, outputTokens: 2 },
    }), "discord-opencode-session");
  const runner = new AgentRunner(
    config,
    testAuthorizationPolicy(config),
    database,
    executor,
    audit,
    (job) => adapter.reporter(job),
  );
  adapter.attachRunner(runner);
  const handler = new DiscordDurableInteractionHandler(database, adapter, 5);
  const ingress = new DiscordHttpIngress(adapter, handler, publicKey, config.discord.http);
  await runner.start();
  const server = await ingress.start();
  const port = (server.address() as AddressInfo).port;
  const body = JSON.stringify(interaction("100000000000000099"));
  const response = await fetch(`http://127.0.0.1:${port}/discord/interactions`, {
    method: "POST",
    headers: signedHeaders(body),
    body,
  });
  assert.equal(response.status, 200);
  await waitFor(() => database.getJobBySourceEvent("discord", "100000000000000099")?.status === "succeeded");
  await waitFor(() => calls.some((call) => call.kind === "edit" && call.content === "completed through discord"));
  const job = database.getJobBySourceEvent("discord", "100000000000000099");
  assert.equal(job?.deliveryMessageId, "discord-working-message");
  assert.equal(job?.sessionKey, "discord:G1:discord-working-message:discord-working-message");
  assert.deepEqual(calls, [
    { kind: "create", content: "Agent session created. Continue the conversation in this thread." },
    { kind: "create", content: "Working…" },
    { kind: "edit", content: "completed through discord" },
  ]);
  await ingress.stop();
  await runner.stop();
  database.close();
  await rm(root, { recursive: true, force: true });
});

test("Discord HTTP rejection logging is content-free and rate limited", () => {
  const lines: string[] = [];
  const logger = new DiscordHttpSecurityLogger({
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  }, 2, () => 1_000);
  for (let index = 0; index < 10; index += 1) {
    logger.warn("authenticity", "Discord HTTP request rejected during authenticity validation.");
  }
  assert.deepEqual(lines, [
    "Discord HTTP request rejected during authenticity validation.",
    "Discord HTTP request rejected during authenticity validation.",
    "Further Discord HTTP receiver failures suppressed for this minute.",
  ]);
  assert.doesNotMatch(lines.join(" "), /private-prompt|short-lived-token/);
});
