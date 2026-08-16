import type { RunnerConfig } from "../config.js";
import type { RunnerDatabase } from "../database.js";
import { RunnerError } from "../errors.js";
import type { AgentRunner } from "../runner.js";
import type { Attachment, JobRecord, JobReporter } from "../types.js";
import { asRecord } from "../values.js";
import type { DiscordSessionApi } from "./delivery.js";
import { DiscordJobReporter } from "./delivery.js";
import {
  normalizeDiscordCommand,
  parseDiscordCommand,
  parseDiscordThreadMessage,
  type ParsedDiscordCommand,
} from "./normalization.js";

type DiscordRunner = Pick<AgentRunner, "submit">;

export type DiscordInteractionPreparation =
  | { readonly kind: "accepted"; readonly command: ParsedDiscordCommand }
  | { readonly kind: "rejected"; readonly message: string };

export interface DiscordAdapterOptions {
  readonly fetch?: typeof fetch;
}

async function readBounded(response: Response, maximum: number): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export class DiscordAdapter {
  private runner?: DiscordRunner;
  private readonly allowedGuilds: Set<string>;
  private readonly allowedUsers: Set<string>;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly config: RunnerConfig,
    private readonly api: DiscordSessionApi,
    private readonly database: RunnerDatabase,
    private readonly outputSecrets: readonly string[],
    options: DiscordAdapterOptions = {},
  ) {
    this.allowedGuilds = new Set(config.discord.allowedGuildIds);
    this.allowedUsers = new Set(config.discord.allowedUserIds);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  attachRunner(runner: DiscordRunner): void {
    this.runner = runner;
  }

  reporter(job: JobRecord): JobReporter {
    return new DiscordJobReporter(
      this.api,
      job,
      this.config.discord.maxOutputCharacters,
      this.outputSecrets,
    );
  }

  prepareInteraction(value: unknown): DiscordInteractionPreparation {
    const applicationId = this.config.discord.applicationId;
    if (!applicationId) return { kind: "rejected", message: "Discord integration is not configured." };
    const parsed = parseDiscordCommand(value, applicationId, this.config.discord.commandName);
    if (!parsed.accepted) {
      const message = parsed.reason === "not_guild_command"
        ? "This command is available only in an approved server."
        : parsed.reason === "not_top_level_channel"
          ? "Start a new agent session with this command in a normal server channel."
        : parsed.reason === "missing_prompt"
          ? "A prompt is required."
          : parsed.reason === "invalid_attachment"
            ? "The attachment must be a valid Discord-hosted image."
            : "This interaction is not supported.";
      return { kind: "rejected", message };
    }
    const { command } = parsed;
    if (!this.allowedGuilds.has(command.tenantId) || !this.allowedUsers.has(command.actorId)) {
      return { kind: "rejected", message: "You are not authorized to use this agent." };
    }
    if (command.prompt.length > this.config.limits.maxPromptCharacters) {
      return { kind: "rejected", message: "The prompt exceeds the configured character limit." };
    }
    if (command.attachment && command.attachment.size > this.config.limits.maxAttachmentBytes) {
      return { kind: "rejected", message: "The attachment exceeds the configured size limit." };
    }
    return { kind: "accepted", command };
  }

  prepareThreadMessage(value: unknown): DiscordInteractionPreparation | { readonly kind: "ignored" } {
    const message = asRecord(value);
    const channelId = typeof message.channel_id === "string" ? message.channel_id : "";
    const thread = channelId ? this.database.getDiscordThread(channelId) : undefined;
    if (!thread) return { kind: "ignored" };
    if (!this.allowedGuilds.has(thread.guildId) || !this.allowedUsers.has(thread.ownerUserId)) {
      return { kind: "ignored" };
    }
    const applicationId = this.config.discord.applicationId;
    if (!applicationId) return { kind: "ignored" };
    const parsed = parseDiscordThreadMessage(value, thread, applicationId);
    if (!parsed.accepted) return { kind: "ignored" };
    if (parsed.command.prompt.length > this.config.limits.maxPromptCharacters) {
      return { kind: "rejected", message: "The message exceeds the configured prompt limit." };
    }
    if (parsed.command.attachment && parsed.command.attachment.size > this.config.limits.maxAttachmentBytes) {
      return { kind: "rejected", message: "The attachment exceeds the configured size limit." };
    }
    return { kind: "accepted", command: parsed.command };
  }

  async processCommand(command: ParsedDiscordCommand, retryUnexpected = false): Promise<void> {
    if (!this.runner) throw new Error("Discord adapter received an interaction before the runner was attached");
    // Durable inbox entries can outlive an allowlist or application-ID change.
    // Re-authorize before creating a thread or downloading an attachment so a
    // revoked principal cannot cause platform or network side effects on replay.
    if (
      command.applicationId !== this.config.discord.applicationId ||
      !this.allowedGuilds.has(command.tenantId) ||
      !this.allowedUsers.has(command.actorId)
    ) return;
    const routed = command.conversationId === command.threadId
      ? command
      : await this.createSessionThread(command);
    const attachments = routed.attachment
      ? await this.downloadAttachment(routed, retryUnexpected)
      : [];
    try {
      await this.runner.submit(normalizeDiscordCommand(routed, attachments));
    } catch (error) {
      if (!(error instanceof RunnerError)) {
        if (retryUnexpected) throw error;
        return;
      }
      await this.api.createMessage(routed.conversationId, error.message, routed.sourceEventId.slice(0, 25));
    }
  }

  private async createSessionThread(command: ParsedDiscordCommand): Promise<ParsedDiscordCommand> {
    const starter = await this.api.createMessage(
      command.conversationId,
      "Agent session created. Continue the conversation in this thread.",
      command.sourceEventId.slice(0, 25),
    );
    let thread = this.database.getDiscordThread(starter.id);
    if (!thread) {
      const existing = await this.api.getThread(starter.id);
      const created = existing ?? await this.api.createThreadFromMessage(
        command.conversationId,
        starter.id,
        `agent-${command.sourceEventId.slice(-8)}`,
      );
      thread = this.database.registerDiscordThread({
        threadId: created.id,
        guildId: command.tenantId,
        parentChannelId: command.conversationId,
        ownerUserId: command.actorId,
      });
    }
    return {
      ...command,
      conversationId: thread.threadId,
      threadId: thread.threadId,
    };
  }

  private async downloadAttachment(
    command: ParsedDiscordCommand,
    retryFailures: boolean,
  ): Promise<Attachment[]> {
    const attachment = command.attachment;
    if (!attachment) return [];
    try {
      const response = await this.fetcher(attachment.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Discord attachment download failed with status ${response.status}`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared < 0 || declared > this.config.limits.maxAttachmentBytes) {
          throw new Error("Discord attachment declared an invalid size");
        }
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType && contentType !== attachment.mime) {
        throw new Error("Discord attachment content type did not match its interaction metadata");
      }
      const buffer = await readBounded(response, this.config.limits.maxAttachmentBytes);
      if (!buffer) throw new Error("Discord attachment exceeded the configured size limit");
      return [{
        mime: attachment.mime,
        filename: attachment.filename,
        dataUrl: `data:${attachment.mime};base64,${buffer.toString("base64")}`,
      }];
    } catch (error) {
      if (retryFailures) throw error;
      return [];
    }
  }
}
