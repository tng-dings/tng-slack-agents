import type { WebClient } from "@slack/web-api";
import type { RunnerDatabase } from "../database.js";
import { DurableInboxPump } from "../inbox.js";
import type { InboundEventRecord } from "../types.js";
import type { SlackEventHandler } from "./socket-ingress.js";
import { SlackAdapter } from "./adapter.js";
import type { ParsedSlackMessage } from "./normalization.js";

interface SlackInboxPayload {
  message: ParsedSlackMessage;
}

function slackPayload(event: InboundEventRecord): SlackInboxPayload {
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || !("message" in payload)) {
    throw new Error("Invalid persisted Slack inbox envelope");
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") throw new Error("Invalid persisted Slack message");
  const value = message as Record<string, unknown>;
  for (const field of ["sourceEventId", "tenantId", "conversationId", "threadId", "actorId", "text"] as const) {
    if (typeof value[field] !== "string") throw new Error(`Invalid persisted Slack message field: ${field}`);
  }
  if (!Array.isArray(value.files)) throw new Error("Invalid persisted Slack message files");
  return { message: message as unknown as ParsedSlackMessage };
}

/**
 * Commits authorized Slack events before HTTP acknowledgement, then performs
 * network I/O and runner submission outside the request lifecycle.
 */
export class SlackDurableEventHandler implements SlackEventHandler {
  private readonly inbox: DurableInboxPump;

  constructor(
    private readonly database: RunnerDatabase,
    private readonly adapter: SlackAdapter,
    pollIntervalMs: number,
  ) {
    this.inbox = new DurableInboxPump(database, "slack", "Slack", pollIntervalMs, (event) => this.process(event));
  }

  async handleMessage(message: unknown, body: unknown, _client: WebClient): Promise<void> {
    const prepared = this.adapter.prepareMessage(message, body);
    if (prepared.kind === "ignored") return;
    if (prepared.kind === "denied") {
      setImmediate(() => void this.adapter.denyMessage(prepared.message));
      return;
    }
    this.database.insertInboundEvent("slack", prepared.message.sourceEventId, {
      message: prepared.message,
    } satisfies SlackInboxPayload);
    this.inbox.wake();
  }

  async handleAppHome(event: unknown, body: unknown, _client: WebClient): Promise<void> {
    setImmediate(() => void this.adapter.handleAppHome(event, body));
  }

  start(): void {
    this.inbox.start();
  }

  async stop(): Promise<void> {
    await this.inbox.stop();
  }

  private async process(event: InboundEventRecord): Promise<void> {
    const payload = slackPayload(event);
    await this.adapter.processMessage(payload.message, undefined, true);
  }
}
