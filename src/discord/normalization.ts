import { MessageType } from "discord-api-types/v10";
import type { Attachment, DiscordThreadRecord, JobSubmission } from "../types.js";

const DISCORD_APPLICATION_COMMAND = 2;
const DISCORD_STRING_OPTION = 3;
const DISCORD_ATTACHMENT_OPTION = 11;
const DISCORD_TOP_LEVEL_CHANNEL_TYPES = new Set([0, 5]);

export const DISCORD_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface DiscordAttachmentReference {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly url: string;
}

export interface ParsedDiscordCommand {
  readonly sourceEventId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly actorId: string;
  readonly prompt: string;
  readonly attachment?: DiscordAttachmentReference;
}

export type DiscordCommandIgnoreReason =
  | "not_application_command"
  | "wrong_application"
  | "wrong_command"
  | "not_guild_command"
  | "not_top_level_channel"
  | "missing_identity"
  | "missing_prompt"
  | "invalid_attachment";

export type DiscordCommandParseResult =
  | { readonly accepted: true; readonly command: ParsedDiscordCommand }
  | { readonly accepted: false; readonly reason: DiscordCommandIgnoreReason };

export type DiscordMessageIgnoreReason =
  | "not_thread_message"
  | "wrong_guild"
  | "wrong_owner"
  | "bot_or_webhook"
  | "system_message"
  | "missing_prompt"
  | "invalid_attachment";

export type DiscordMessageParseResult =
  | { readonly accepted: true; readonly command: ParsedDiscordCommand }
  | { readonly accepted: false; readonly reason: DiscordMessageIgnoreReason };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function option(options: unknown, name: string, type: number): Record<string, unknown> | undefined {
  if (!Array.isArray(options)) return undefined;
  return options
    .map(record)
    .find((candidate) => candidate.name === name && candidate.type === type);
}

function attachmentReference(data: Record<string, unknown>): DiscordAttachmentReference | undefined {
  const selected = option(data.options, "attachment", DISCORD_ATTACHMENT_OPTION);
  if (!selected) return undefined;
  if (typeof selected.value !== "string") return undefined;
  const resolved = record(data.resolved);
  const attachments = record(resolved.attachments);
  const attachment = record(attachments[selected.value]);
  if (
    typeof attachment.id !== "string" ||
    attachment.id !== selected.value ||
    typeof attachment.filename !== "string" ||
    typeof attachment.content_type !== "string" ||
    typeof attachment.size !== "number" ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0 ||
    typeof attachment.url !== "string"
  ) return undefined;
  if (!DISCORD_IMAGE_MIME_TYPES.has(attachment.content_type)) return undefined;
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com") return undefined;
  return {
    id: attachment.id,
    filename: attachment.filename.slice(0, 255) || "attachment",
    mime: attachment.content_type,
    size: attachment.size,
    url: url.toString(),
  };
}

/** Parses the single guild-scoped slash command without performing network I/O. */
export function parseDiscordCommand(
  value: unknown,
  expectedApplicationId: string,
  expectedCommandName: string,
): DiscordCommandParseResult {
  const interaction = record(value);
  if (interaction.type !== DISCORD_APPLICATION_COMMAND) {
    return { accepted: false, reason: "not_application_command" };
  }
  if (interaction.application_id !== expectedApplicationId) {
    return { accepted: false, reason: "wrong_application" };
  }
  const data = record(interaction.data);
  if (data.name !== expectedCommandName || data.type !== 1) {
    return { accepted: false, reason: "wrong_command" };
  }
  if (typeof interaction.guild_id !== "string" || !interaction.guild_id) {
    return { accepted: false, reason: "not_guild_command" };
  }
  const member = record(interaction.member);
  const user = record(member.user);
  if (
    typeof interaction.id !== "string" ||
    typeof interaction.channel_id !== "string" ||
    typeof user.id !== "string"
  ) return { accepted: false, reason: "missing_identity" };

  const promptOption = option(data.options, "prompt", DISCORD_STRING_OPTION);
  const prompt = typeof promptOption?.value === "string" ? promptOption.value.trim() : "";
  if (!prompt) return { accepted: false, reason: "missing_prompt" };

  const selectedAttachment = option(data.options, "attachment", DISCORD_ATTACHMENT_OPTION);
  const attachment = attachmentReference(data);
  if (selectedAttachment && !attachment) {
    return { accepted: false, reason: "invalid_attachment" };
  }
  const channel = record(interaction.channel);
  if (typeof channel.type !== "number" || !DISCORD_TOP_LEVEL_CHANNEL_TYPES.has(channel.type)) {
    return { accepted: false, reason: "not_top_level_channel" };
  }
  return {
    accepted: true,
    command: {
      sourceEventId: interaction.id,
      applicationId: expectedApplicationId,
      tenantId: interaction.guild_id,
      conversationId: interaction.channel_id,
      threadId: interaction.id,
      actorId: user.id,
      prompt,
      ...(attachment ? { attachment } : {}),
    },
  };
}

export function normalizeDiscordCommand(
  command: ParsedDiscordCommand,
  attachments: readonly Attachment[],
): JobSubmission {
  return {
    integration: "discord",
    sourceEventId: command.sourceEventId,
    tenantId: command.tenantId,
    conversationId: command.conversationId,
    threadId: command.threadId,
    actorId: command.actorId,
    prompt: command.prompt,
    attachments: [...attachments],
  };
}

/** Reduces a Gateway MESSAGE_CREATE payload from a registered agent thread. */
export function parseDiscordThreadMessage(
  value: unknown,
  thread: DiscordThreadRecord,
  applicationId: string,
): DiscordMessageParseResult {
  const message = record(value);
  const author = record(message.author);
  if (message.channel_id !== thread.threadId) return { accepted: false, reason: "not_thread_message" };
  if (message.guild_id !== thread.guildId) return { accepted: false, reason: "wrong_guild" };
  if (author.bot === true || typeof message.webhook_id === "string") {
    return { accepted: false, reason: "bot_or_webhook" };
  }
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) {
    return { accepted: false, reason: "system_message" };
  }
  if (author.id !== thread.ownerUserId) return { accepted: false, reason: "wrong_owner" };
  if (typeof message.id !== "string" || typeof author.id !== "string") {
    return { accepted: false, reason: "not_thread_message" };
  }

  const rawAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (rawAttachments.length > 1) return { accepted: false, reason: "invalid_attachment" };
  let attachment: DiscordAttachmentReference | undefined;
  if (rawAttachments.length === 1) {
    const value = record(rawAttachments[0]);
    if (
      typeof value.id !== "string" ||
      typeof value.filename !== "string" ||
      typeof value.content_type !== "string" ||
      !DISCORD_IMAGE_MIME_TYPES.has(value.content_type) ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.url !== "string"
    ) return { accepted: false, reason: "invalid_attachment" };
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      return { accepted: false, reason: "invalid_attachment" };
    }
    if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com") {
      return { accepted: false, reason: "invalid_attachment" };
    }
    attachment = {
      id: value.id,
      filename: value.filename.slice(0, 255) || "attachment",
      mime: value.content_type,
      size: value.size,
      url: url.toString(),
    };
  }

  const content = typeof message.content === "string" ? message.content.trim() : "";
  const prompt = content || (attachment ? "Review the attached image." : "");
  if (!prompt) return { accepted: false, reason: "missing_prompt" };
  return {
    accepted: true,
    command: {
      sourceEventId: message.id,
      applicationId,
      tenantId: thread.guildId,
      conversationId: thread.threadId,
      threadId: thread.threadId,
      actorId: author.id,
      prompt,
      ...(attachment ? { attachment } : {}),
    },
  };
}
