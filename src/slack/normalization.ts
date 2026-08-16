import type { Attachment, JobSubmission } from "../types.js";
import { asRecord } from "../values.js";

export const SLACK_ATTACHMENT_PROMPT = "Please review the attached screenshot(s).";

export type SlackMessageIgnoreReason =
  | "not_direct_message"
  | "missing_actor"
  | "bot_message"
  | "message_subtype"
  | "no_content";

export interface ParsedSlackMessage {
  readonly sourceEventId: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly actorId: string;
  readonly text: string;
  readonly files: readonly unknown[];
}

export type SlackMessageParseResult =
  | { readonly accepted: true; readonly message: ParsedSlackMessage }
  | { readonly accepted: false; readonly reason: SlackMessageIgnoreReason };

export interface NormalizedSlackAppHome {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly actorId: string;
}

/**
 * Applies the Slack message acceptance and identity rules without performing
 * network I/O. Both Socket Mode and Events API ingress hand their event/body
 * pair through this function before the adapter does any work.
 */
export function parseSlackMessage(eventValue: unknown, bodyValue: unknown): SlackMessageParseResult {
  const event = asRecord(eventValue);
  const body = asRecord(bodyValue);
  if (event.channel_type !== "im") return { accepted: false, reason: "not_direct_message" };
  if (typeof event.user !== "string") return { accepted: false, reason: "missing_actor" };
  if (event.bot_id) return { accepted: false, reason: "bot_message" };
  if (event.subtype) return { accepted: false, reason: "message_subtype" };

  const conversationId = String(event.channel);
  const eventTs = String(event.ts);
  const threadId = typeof event.thread_ts === "string" ? event.thread_ts : eventTs;
  const tenantId = typeof event.team === "string" ? event.team : String(body.team_id ?? "");
  const text = typeof event.text === "string" ? event.text.trim() : "";
  const files = Array.isArray(event.files) ? event.files : [];
  if (!text && files.length === 0) return { accepted: false, reason: "no_content" };

  const eventId = body.event_id;
  const sourceEventId = typeof eventId === "string" && eventId
    ? eventId
    : `${tenantId}:${conversationId}:${eventTs}`;
  return {
    accepted: true,
    message: {
      sourceEventId,
      tenantId,
      conversationId,
      threadId,
      actorId: event.user,
      text,
      files,
    },
  };
}

/** Completes normalization after the Slack adapter has retrieved valid files. */
export function normalizeSlackMessage(
  message: ParsedSlackMessage,
  attachments: readonly Attachment[],
): JobSubmission | undefined {
  const prompt = message.text || (attachments.length > 0 ? SLACK_ATTACHMENT_PROMPT : "");
  if (!prompt) return undefined;
  return {
    integration: "slack",
    sourceEventId: message.sourceEventId,
    tenantId: message.tenantId,
    conversationId: message.conversationId,
    threadId: message.threadId,
    actorId: message.actorId,
    prompt,
    attachments: [...attachments],
  };
}

/** Normalizes the app-home context shared by every Slack ingress mode. */
export function normalizeSlackAppHome(eventValue: unknown, bodyValue: unknown): NormalizedSlackAppHome | undefined {
  const event = asRecord(eventValue);
  if (event.tab !== "messages" || !event.channel || !event.user) return undefined;
  const body = asRecord(bodyValue);
  return {
    tenantId: String(body.team_id ?? ""),
    conversationId: String(event.channel),
    actorId: String(event.user),
  };
}
