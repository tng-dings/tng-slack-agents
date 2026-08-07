import type { WebClient } from "@slack/web-api";
import type { RunnerDatabase } from "../database.js";
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

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

/**
 * Commits authorized Slack events before HTTP acknowledgement, then performs
 * network I/O and runner submission outside the request lifecycle.
 */
export class SlackDurableEventHandler implements SlackEventHandler {
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly database: RunnerDatabase,
    private readonly adapter: SlackAdapter,
    private readonly pollIntervalMs: number,
  ) {}

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
    setImmediate(() => this.pump());
  }

  async handleAppHome(event: unknown, body: unknown, _client: WebClient): Promise<void> {
    setImmediate(() => void this.adapter.handleAppHome(event, body));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.database.recoverInboundEvents("slack");
    this.timer = setInterval(() => this.pump(), this.pollIntervalMs);
    this.timer.unref();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }

  private pump(): void {
    if (!this.started || this.stopping || this.active) return;
    const event = this.database.claimNextInboundEvent("slack");
    if (!event) return;
    const task = this.process(event).finally(() => {
      if (this.active === task) this.active = undefined;
      setImmediate(() => this.pump());
    });
    this.active = task;
  }

  private async process(event: InboundEventRecord): Promise<void> {
    try {
      const payload = slackPayload(event);
      await this.adapter.processMessage(payload.message, undefined, true);
      this.database.completeInboundEvent(event.eventKey);
    } catch (error) {
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(event.attempts, 6)));
      this.database.retryInboundEvent(event.eventKey, errorLabel(error), delayMs);
      console.error("Slack inbox processing failed; the event will be retried", errorLabel(error));
    }
  }
}
