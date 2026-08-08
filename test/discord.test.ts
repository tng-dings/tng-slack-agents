import assert from "node:assert/strict";
import test from "node:test";
import { RunnerDatabase } from "../src/database.js";
import {
  DiscordAdapter,
  DiscordApiClient,
  DiscordDurableInteractionHandler,
  DiscordGatewayIngress,
  DiscordJobReporter,
  discordGuildCommand,
  parseDiscordCommand,
  parseDiscordThreadMessage,
  type DiscordApi,
  type DiscordSessionApi,
} from "../src/discord.js";
import type { JobRecord, JobSubmission } from "../src/types.js";
import { testConfig } from "./helpers.js";

function interaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "100000000000000001",
    application_id: "APP1",
    type: 2,
    guild_id: "G1",
    channel_id: "C1",
    channel: { id: "C1", type: 0 },
    member: { user: { id: "U1" } },
    data: {
      id: "200000000000000001",
      name: "agent",
      type: 1,
      options: [{ name: "prompt", type: 3, value: " investigate " }],
    },
    ...overrides,
  };
}

function discordJob(deliveryMessageId: string | null = null): JobRecord {
  return {
    id: "job-discord",
    integration: "discord",
    sourceEventId: "interaction-1",
    sessionKey: "discord:G1:C1:interaction-1",
    tenantId: "G1",
    conversationId: "C1",
    threadId: "interaction-1",
    deliveryMessageId,
    actorId: "U1",
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

test("Discord guild command uses only supported attachment-option fields", () => {
  const config = testConfig(".");
  config.limits.maxPromptCharacters = 9_000;
  const command = discordGuildCommand(config);
  assert.equal(command.options[0].max_length, 6_000);
  assert.deepEqual(command.options[1], {
    name: "attachment",
    description: "Optional screenshot or image",
    type: 11,
    required: false,
  });
  assert.equal("file_types" in command.options[1], false);
});

test("Discord REST client uses a valid User-Agent and retries rate limits", async () => {
  const calls: Array<{ authorization: string | null; userAgent: string | null }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      authorization: headers.get("authorization"),
      userAgent: headers.get("user-agent"),
    });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ retry_after: 0.001, global: false }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "0.001",
          "x-ratelimit-bucket": "messages",
        },
      });
    }
    return new Response(JSON.stringify({ id: "message-after-retry" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new DiscordApiClient("bot-token", fetcher);
  assert.deepEqual(await client.createMessage("channel", "result", "nonce"), {
    id: "message-after-retry",
  });
  assert.equal(calls.length, 2);
  assert(calls.every((call) => call.authorization === "Bot bot-token"));
  const match = /^DiscordBot \((https:\/\/[^,]+), 0\.1\.0\)$/.exec(calls[0]?.userAgent ?? "");
  assert(match);
  assert.doesNotThrow(() => new URL(match[1]!));
});

test("Discord command normalization accepts only top-level channel invocations", () => {
  const channel = parseDiscordCommand(interaction(), "APP1", "agent");
  assert.equal(channel.accepted, true);
  if (!channel.accepted) return;
  assert.equal(channel.command.prompt, "investigate");
  assert.equal(channel.command.conversationId, "C1");
  assert.equal(channel.command.threadId, "100000000000000001");

  const thread = parseDiscordCommand(interaction({ channel: { id: "C1", type: 11 } }), "APP1", "agent");
  assert.deepEqual(thread, { accepted: false, reason: "not_top_level_channel" });

  const secondChannelInvocation = parseDiscordCommand(
    interaction({ id: "100000000000000002" }),
    "APP1",
    "agent",
  );
  assert.equal(secondChannelInvocation.accepted, true);
  if (!secondChannelInvocation.accepted) return;
  assert.notEqual(secondChannelInvocation.command.threadId, channel.command.threadId);
});

test("Discord normalization accepts one Discord-hosted image and rejects untrusted attachment URLs", () => {
  const withAttachment = interaction({
    data: {
      id: "command",
      name: "agent",
      type: 1,
      options: [
        { name: "prompt", type: 3, value: "review" },
        { name: "attachment", type: 11, value: "A1" },
      ],
      resolved: {
        attachments: {
          A1: {
            id: "A1",
            filename: "screen.png",
            content_type: "image/png",
            size: 4,
            url: "https://cdn.discordapp.com/attachments/1/2/screen.png?signature=value",
          },
        },
      },
    },
  });
  const accepted = parseDiscordCommand(withAttachment, "APP1", "agent");
  assert.equal(accepted.accepted, true);
  if (!accepted.accepted) return;
  assert.equal(accepted.command.attachment?.filename, "screen.png");

  const data = withAttachment.data as Record<string, unknown>;
  const resolved = data.resolved as { attachments: { A1: Record<string, unknown> } };
  const untrusted = interaction({
    data: {
      ...data,
      resolved: { attachments: { A1: { ...resolved.attachments.A1, url: "https://example.com/private.png" } } },
    },
  });
  assert.deepEqual(parseDiscordCommand(untrusted, "APP1", "agent"), {
    accepted: false,
    reason: "invalid_attachment",
  });
});

test("Discord adapter authorizes before submission and downloads a bounded image", async () => {
  const config = testConfig(".");
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U1"];
  const api: DiscordSessionApi = {
    createMessage: async () => ({ id: "message" }),
    editMessage: async () => undefined,
    createThreadFromMessage: async (_channelId, messageId) => ({ id: messageId }),
    getThread: async () => undefined,
    replyToInteraction: async () => undefined,
  };
  const database = new RunnerDatabase(":memory:");
  const adapter = new DiscordAdapter(config, api, database, [], {
    fetch: async () => new Response(Buffer.from([1, 2, 3, 4]), {
      status: 200,
      headers: { "content-length": "4", "content-type": "image/png" },
    }),
  });
  const prepared = adapter.prepareInteraction(interaction({
    data: {
      id: "command",
      name: "agent",
      type: 1,
      options: [
        { name: "prompt", type: 3, value: "review" },
        { name: "attachment", type: 11, value: "A1" },
      ],
      resolved: { attachments: { A1: {
        id: "A1",
        filename: "screen.png",
        content_type: "image/png",
        size: 4,
        url: "https://cdn.discordapp.com/attachments/1/2/screen.png",
      } } },
    },
  }));
  assert.equal(prepared.kind, "accepted");
  if (prepared.kind !== "accepted") return;
  const submissions: JobSubmission[] = [];
  adapter.attachRunner({
    submit: async (submission) => {
      submissions.push(submission);
      return { job: {} as JobRecord, isNew: true };
    },
  });
  await adapter.processCommand(prepared.command, true);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.attachments?.[0]?.dataUrl, "data:image/png;base64,AQIDBA==");

  const denied = adapter.prepareInteraction(interaction({ member: { user: { id: "U_DENIED" } } }));
  assert.deepEqual(denied, { kind: "rejected", message: "You are not authorized to use this agent." });

  config.limits.maxPromptCharacters = 4;
  const oversized = adapter.prepareInteraction(interaction());
  assert.deepEqual(oversized, {
    kind: "rejected",
    message: "The prompt exceeds the configured character limit.",
  });
  database.close();
});

test("Discord reporter persists a bot message ID and emits redacted bounded chunks", async () => {
  const calls: Array<{ kind: "create" | "edit"; content: string; messageId?: string; nonce?: string }> = [];
  const api: DiscordApi = {
    createMessage: async (_channelId, content, nonce) => {
      calls.push({ kind: "create", content, nonce });
      return { id: `message-${calls.length}` };
    },
    editMessage: async (_channelId, messageId, content) => {
      calls.push({ kind: "edit", content, messageId });
    },
  };
  const queued = new DiscordJobReporter(api, discordJob(), 2_500, ["discord-secret"]);
  assert.deepEqual(await queued.start(), { deliveryMessageId: "message-1" });
  assert.equal(calls[0]?.content, "Working…");

  calls.length = 0;
  const running = new DiscordJobReporter(api, discordJob("message-1"), 2_500, ["discord-secret"]);
  await running.succeed(`discord-secret:${"x".repeat(4_000)}`);
  assert.equal(calls[0]?.kind, "edit");
  assert.equal(calls[0]?.messageId, "message-1");
  assert(calls.length >= 2);
  assert(calls.every((call) => call.content.length <= 1_900));
  assert.doesNotMatch(calls.map((call) => call.content).join(""), /discord-secret/);
  assert.match(calls.map((call) => call.content).join(""), /Output truncated/);

  calls.length = 0;
  const recovered = new DiscordJobReporter(api, discordJob(), 2_500);
  await recovered.succeed("final after an ambiguous create-message response");
  assert.deepEqual(calls.map((call) => call.kind), ["create", "edit"]);
  assert.equal(calls[1]?.messageId, "message-1");
  assert.equal(calls[1]?.content, "final after an ambiguous create-message response");
});

test("top-level command creates one owned thread and follow-ups reuse its session", async () => {
  const config = testConfig(".");
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U1"];
  const database = new RunnerDatabase(":memory:");
  const api: DiscordSessionApi = {
    createMessage: async () => ({ id: "THREAD1" }),
    editMessage: async () => undefined,
    createThreadFromMessage: async (_channelId, messageId) => ({ id: messageId }),
    getThread: async () => undefined,
    replyToInteraction: async () => undefined,
  };
  const adapter = new DiscordAdapter(config, api, database, []);
  const submissions: JobSubmission[] = [];
  adapter.attachRunner({
    submit: async (submission) => {
      submissions.push(submission);
      return { job: {} as JobRecord, isNew: true };
    },
  });
  const prepared = adapter.prepareInteraction(interaction());
  assert.equal(prepared.kind, "accepted");
  if (prepared.kind !== "accepted") return;
  await adapter.processCommand(prepared.command, true);
  assert.equal(submissions[0]?.conversationId, "THREAD1");
  assert.equal(submissions[0]?.threadId, "THREAD1");
  assert.equal(database.getDiscordThread("THREAD1")?.ownerUserId, "U1");

  const followUp = parseDiscordThreadMessage({
    id: "MESSAGE2",
    type: 0,
    guild_id: "G1",
    channel_id: "THREAD1",
    author: { id: "U1", bot: false },
    content: "also inspect the lockfile",
    attachments: [],
  }, database.getDiscordThread("THREAD1")!, "APP1");
  assert.equal(followUp.accepted, true);
  if (followUp.accepted) await adapter.processCommand(followUp.command, true);
  assert.equal(submissions[1]?.conversationId, "THREAD1");
  assert.equal(submissions[1]?.threadId, "THREAD1");
  database.close();
});

test("Gateway dispatch persists commands without tokens and accepts only the thread owner", async () => {
  const config = testConfig(".");
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = ["U1"];
  const database = new RunnerDatabase(":memory:");
  const replies: string[] = [];
  const api: DiscordSessionApi = {
    createMessage: async () => ({ id: "message" }),
    editMessage: async () => undefined,
    createThreadFromMessage: async (_channelId, messageId) => ({ id: messageId }),
    getThread: async () => undefined,
    replyToInteraction: async (_id, _token, content) => { replies.push(content); },
  };
  const adapter = new DiscordAdapter(config, api, database, []);
  const handler = new DiscordDurableInteractionHandler(database, adapter, 5);
  const ingress = new DiscordGatewayIngress(adapter, handler, api, "bot-token");
  await ingress.dispatch({
    op: 0,
    s: 1,
    t: "INTERACTION_CREATE",
    d: { ...interaction(), token: "short-lived-token" },
  } as never);
  const persisted = database.getInboundEvent("discord", "100000000000000001");
  assert(persisted);
  assert.doesNotMatch(JSON.stringify(persisted.payload), /short-lived-token/);
  assert.deepEqual(replies, ["Creating an agent thread…"]);

  database.registerDiscordThread({
    threadId: "THREAD1",
    guildId: "G1",
    parentChannelId: "C1",
    ownerUserId: "U1",
  });
  await ingress.dispatch({
    op: 0,
    s: 2,
    t: "MESSAGE_CREATE",
    d: {
      id: "MESSAGE2",
      type: 0,
      guild_id: "G1",
      channel_id: "THREAD1",
      author: { id: "U1", bot: false },
      content: "continue",
      attachments: [],
    },
  } as never);
  assert(database.getInboundEvent("discord", "MESSAGE2"));
  await ingress.dispatch({
    op: 0,
    s: 3,
    t: "MESSAGE_CREATE",
    d: {
      id: "MESSAGE3",
      type: 0,
      guild_id: "G1",
      channel_id: "THREAD1",
      author: { id: "U2", bot: false },
      content: "inject work",
      attachments: [],
    },
  } as never);
  assert.equal(database.getInboundEvent("discord", "MESSAGE3"), undefined);

  await ingress.dispatch({
    op: 0,
    s: 4,
    t: "MESSAGE_CREATE",
    d: {
      id: "MESSAGE4",
      type: 6,
      guild_id: "G1",
      channel_id: "THREAD1",
      author: { id: "U1", bot: false },
      content: "pinned a message",
      attachments: [],
    },
  } as never);
  assert.equal(database.getInboundEvent("discord", "MESSAGE4"), undefined);
  database.close();
});

test("Discord replay re-authorizes before creating a thread or downloading an attachment", async () => {
  const config = testConfig(".");
  config.discord.enabled = true;
  config.discord.applicationId = "APP1";
  config.discord.allowedGuildIds = ["G1"];
  config.discord.allowedUserIds = [];
  const database = new RunnerDatabase(":memory:");
  let apiCalls = 0;
  let fetchCalls = 0;
  let submissions = 0;
  const api: DiscordSessionApi = {
    createMessage: async () => { apiCalls += 1; return { id: "message" }; },
    editMessage: async () => { apiCalls += 1; },
    createThreadFromMessage: async () => { apiCalls += 1; return { id: "thread" }; },
    getThread: async () => { apiCalls += 1; return undefined; },
    replyToInteraction: async () => { apiCalls += 1; },
  };
  const adapter = new DiscordAdapter(config, api, database, [], {
    fetch: async () => { fetchCalls += 1; return new Response(); },
  });
  adapter.attachRunner({
    submit: async () => { submissions += 1; return { job: {} as JobRecord, isNew: true }; },
  });
  await adapter.processCommand({
    sourceEventId: "stale-interaction",
    applicationId: "APP1",
    tenantId: "G1",
    conversationId: "C1",
    threadId: "stale-interaction",
    actorId: "U1",
    prompt: "stale work",
    attachment: {
      id: "A1",
      filename: "screen.png",
      mime: "image/png",
      size: 1,
      url: "https://cdn.discordapp.com/attachments/1/2/screen.png",
    },
  }, true);
  assert.equal(apiCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(submissions, 0);
  database.close();
});
