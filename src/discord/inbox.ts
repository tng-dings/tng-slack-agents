import type { RunnerDatabase } from "../database.js";
import { DurableInboxPump } from "../inbox.js";
import type { InboundEventRecord } from "../types.js";
import { asRecord } from "../values.js";
import type { DiscordAdapter } from "./adapter.js";
import type { DiscordAttachmentReference, ParsedDiscordCommand } from "./normalization.js";

interface DiscordInboxPayload {
  command: ParsedDiscordCommand;
}

function persistedCommand(event: InboundEventRecord): ParsedDiscordCommand {
  const payload = asRecord(event.payload);
  const command = asRecord(payload.command);
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
    const value = asRecord(command.attachment);
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

/** Durable handoff between the three-second HTTP acknowledgement and job submission. */
export class DiscordDurableInteractionHandler {
  private readonly inbox: DurableInboxPump;

  constructor(
    private readonly database: RunnerDatabase,
    private readonly adapter: DiscordAdapter,
    pollIntervalMs: number,
  ) {
    this.inbox = new DurableInboxPump(database, "discord", "Discord", pollIntervalMs, (event) => this.process(event));
  }

  accept(command: ParsedDiscordCommand): void {
    this.database.insertInboundEvent("discord", command.sourceEventId, {
      command,
    } satisfies DiscordInboxPayload);
    this.inbox.wake();
  }

  start(): void {
    this.inbox.start();
  }

  async stop(): Promise<void> {
    await this.inbox.stop();
  }

  private async process(event: InboundEventRecord): Promise<void> {
    await this.adapter.processCommand(persistedCommand(event), true);
  }
}
