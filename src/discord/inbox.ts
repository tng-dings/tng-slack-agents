import type { RunnerDatabase } from "../database.js";
import type { InboundEventRecord } from "../types.js";
import type { DiscordAdapter } from "./adapter.js";
import type { DiscordAttachmentReference, ParsedDiscordCommand } from "./normalization.js";

interface DiscordInboxPayload {
  command: ParsedDiscordCommand;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function persistedCommand(event: InboundEventRecord): ParsedDiscordCommand {
  const payload = record(event.payload);
  const command = record(payload.command);
  for (const field of [
    "sourceEventId",
    "applicationId",
    "tenantId",
    "conversationId",
    "threadId",
    "actorId",
    "prompt",
  ] as const) {
    if (typeof command[field] !== "string") {
      throw new Error(`Invalid persisted Discord command field: ${field}`);
    }
  }
  let attachment: DiscordAttachmentReference | undefined;
  if (command.attachment !== undefined) {
    const value = record(command.attachment);
    if (
      typeof value.id !== "string" ||
      typeof value.filename !== "string" ||
      typeof value.mime !== "string" ||
      typeof value.size !== "number" ||
      typeof value.url !== "string"
    ) throw new Error("Invalid persisted Discord attachment");
    attachment = value as unknown as DiscordAttachmentReference;
  }
  return {
    sourceEventId: command.sourceEventId as string,
    applicationId: command.applicationId as string,
    tenantId: command.tenantId as string,
    conversationId: command.conversationId as string,
    threadId: command.threadId as string,
    actorId: command.actorId as string,
    prompt: command.prompt as string,
    ...(attachment ? { attachment } : {}),
  };
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

/** Durable handoff between the three-second HTTP acknowledgement and job submission. */
export class DiscordDurableInteractionHandler {
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly database: RunnerDatabase,
    private readonly adapter: DiscordAdapter,
    private readonly pollIntervalMs: number,
  ) {}

  accept(command: ParsedDiscordCommand): void {
    this.database.insertInboundEvent("discord", command.sourceEventId, {
      command,
    } satisfies DiscordInboxPayload);
    setImmediate(() => this.pump());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.database.recoverInboundEvents("discord");
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
    const event = this.database.claimNextInboundEvent("discord");
    if (!event) return;
    const task = this.process(event).finally(() => {
      if (this.active === task) this.active = undefined;
      setImmediate(() => this.pump());
    });
    this.active = task;
  }

  private async process(event: InboundEventRecord): Promise<void> {
    try {
      await this.adapter.processCommand(persistedCommand(event), true);
      this.database.completeInboundEvent(event.eventKey);
    } catch (error) {
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(event.attempts, 6)));
      this.database.retryInboundEvent(event.eventKey, errorLabel(error), delayMs);
      console.error("Discord inbox processing failed; the event will be retried", errorLabel(error));
    }
  }
}
