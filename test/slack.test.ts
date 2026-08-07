import assert from "node:assert/strict";
import test from "node:test";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  normalizeSlackMessage,
  parseSlackMessage,
  SlackAdapter,
  SlackSocketIngress,
  type SlackEventHandler,
} from "../src/slack.js";
import type { JobSubmission } from "../src/types.js";
import { testConfig } from "./helpers.js";

function clientDouble(calls: Array<{ kind: string; value: unknown }>): WebClient {
  return {
    chat: {
      postMessage: async (value: unknown) => {
        calls.push({ kind: "post", value });
        return { ok: true, ts: "reply-ts" };
      },
    },
    assistant: {
      threads: {
        setSuggestedPrompts: async (value: unknown) => {
          calls.push({ kind: "prompts", value });
          return { ok: true };
        },
      },
    },
  } as unknown as WebClient;
}

test("Slack message normalization applies shared DM, identity, prompt, and thread rules without I/O", () => {
  const parsed = parseSlackMessage({
    channel_type: "im",
    channel: "D1",
    user: "U_ALLOWED",
    ts: "100.1",
    thread_ts: "90.1",
    text: "  investigate this  ",
    files: [{ id: "F1" }],
  }, { team_id: "T1", event_id: "Ev1" });
  assert.equal(parsed.accepted, true);
  if (!parsed.accepted) return;
  assert.deepEqual(parsed.message, {
    sourceEventId: "Ev1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "90.1",
    actorId: "U_ALLOWED",
    text: "investigate this",
    files: [{ id: "F1" }],
  });
  assert.deepEqual(normalizeSlackMessage(parsed.message, []), {
    integration: "slack",
    sourceEventId: "Ev1",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "90.1",
    actorId: "U_ALLOWED",
    prompt: "investigate this",
    attachments: [],
  });

  const fallback = parseSlackMessage({
    channel_type: "im",
    channel: "D2",
    user: "U2",
    team: "T-event",
    ts: "200.1",
    text: " ",
    files: [{}],
  }, {});
  assert.equal(fallback.accepted, true);
  if (!fallback.accepted) return;
  assert.equal(fallback.message.threadId, "200.1");
  assert.equal(fallback.message.tenantId, "T-event");
  assert.equal(fallback.message.sourceEventId, "T-event:D2:200.1");
  assert.equal(normalizeSlackMessage(fallback.message, []), undefined);
  assert.equal(normalizeSlackMessage(fallback.message, [{
    mime: "image/png",
    filename: "screen.png",
    dataUrl: "data:image/png;base64,aW1n",
  }])?.prompt, "Please review the attached screenshot(s).");
});

test("Slack message normalization rejects the same non-user-message shapes for every ingress", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["not_direct_message", { channel_type: "channel", user: "U", text: "hi" }],
    ["missing_actor", { channel_type: "im", text: "hi" }],
    ["bot_message", { channel_type: "im", user: "U", bot_id: "B", text: "hi" }],
    ["message_subtype", { channel_type: "im", user: "U", subtype: "message_changed", text: "hi" }],
    ["no_content", { channel_type: "im", user: "U", text: "   ", files: [] }],
  ];
  for (const [reason, event] of cases) {
    assert.deepEqual(parseSlackMessage(event, {}), { accepted: false, reason });
  }
});

test("Slack adapter authenticates bounded image downloads and submits normalized attachment work", async () => {
  const config = testConfig(".");
  config.limits.maxAttachmentsPerJob = 1;
  config.limits.maxAttachmentBytes = 4;
  const calls: Array<{ kind: string; value: unknown }> = [];
  const client = clientDouble(calls);
  const downloads: Array<{ url: string; authorization: string | null }> = [];
  const adapter = new SlackAdapter(
    config,
    { openCodePassword: "password", slackBotToken: "xoxb-secret", slackAppToken: "xapp-secret" },
    client,
    {
      fetch: async (input, init) => {
        downloads.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(new Uint8Array([1, 2, 3]));
      },
    },
  );
  let submission: JobSubmission | undefined;
  adapter.attachRunner({
    submit: async (value) => {
      submission = value;
      return { job: {} as never, isNew: true };
    },
  });

  await adapter.handleMessage({
    channel_type: "im",
    channel: "D1",
    user: "U_ALLOWED",
    ts: "1.0",
    text: "",
    files: [
      { mimetype: "text/plain", url_private_download: "https://files/text", size: 1 },
      { mimetype: "image/png", url_private_download: "https://files/large", size: 5 },
      { mimetype: "image/png", url_private_download: "https://files/one", size: 3, name: "one.png" },
      { mimetype: "image/jpeg", url_private_download: "https://files/two", size: 3, name: "two.jpg" },
    ],
  }, { team_id: "T1", event_id: "Ev-attachment" });

  assert.deepEqual(downloads, [{ url: "https://files/one", authorization: "Bearer xoxb-secret" }]);
  assert.equal(submission?.prompt, "Please review the attached screenshot(s).");
  assert.deepEqual(submission?.attachments, [{
    mime: "image/png",
    filename: "one.png",
    dataUrl: "data:image/png;base64,AQID",
  }]);
  assert.equal(calls.length, 0);
});

test("Slack adapter keeps denial throttling and app-home suggestions platform-local", async () => {
  const config = testConfig(".");
  const calls: Array<{ kind: string; value: unknown }> = [];
  const client = clientDouble(calls);
  const adapter = new SlackAdapter(
    config,
    { openCodePassword: "password", slackBotToken: "xoxb-secret" },
    client,
    { now: () => 100_000 },
  );
  const unauthorized = {
    channel_type: "im",
    channel: "D1",
    user: "U_DENIED",
    ts: "1.0",
    text: "hello",
  };
  await adapter.handleMessage(unauthorized, { team_id: "T1", event_id: "Ev1" });
  await adapter.handleMessage(unauthorized, { team_id: "T1", event_id: "Ev2" });
  await adapter.handleAppHome(
    { tab: "messages", channel: "D_HOME", user: "U_ALLOWED" },
    { team_id: "T1" },
  );
  await adapter.handleAppHome(
    { tab: "messages", channel: "D_HOME", user: "U_DENIED" },
    { team_id: "T1" },
  );

  assert.equal(calls.filter((call) => call.kind === "post").length, 1);
  const denial = calls.find((call) => call.kind === "post")?.value as { text: string };
  assert.equal(denial.text, "You are not authorized to use this agent.");
  assert.equal(calls.filter((call) => call.kind === "prompts").length, 1);
});

test("Socket ingress owns only lifecycle and forwards both Slack event types to its handler", async () => {
  let messageListener: ((args: Record<string, unknown>) => Promise<void>) | undefined;
  let homeListener: ((args: Record<string, unknown>) => Promise<void>) | undefined;
  const lifecycle: string[] = [];
  const app = {
    message: (listener: typeof messageListener) => { messageListener = listener; },
    event: (_name: string, listener: typeof homeListener) => { homeListener = listener; },
    start: async () => { lifecycle.push("start"); },
    stop: async () => { lifecycle.push("stop"); },
  } as unknown as App;
  const forwarded: string[] = [];
  const handler: SlackEventHandler = {
    handleMessage: async () => { forwarded.push("message"); },
    handleAppHome: async () => { forwarded.push("home"); },
  };
  const ingress = new SlackSocketIngress(app, handler);
  assert(messageListener);
  assert(homeListener);
  await messageListener({ message: {}, body: {}, client: {} });
  await homeListener({ event: {}, body: {}, client: {} });
  await ingress.start();
  await ingress.stop();
  assert.deepEqual(forwarded, ["message", "home"]);
  assert.deepEqual(lifecycle, ["start", "stop"]);
});
