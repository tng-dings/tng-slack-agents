import type { WebClient } from "@slack/web-api";
import type { RunnerConfig, RunnerSecrets } from "../config.js";
import { RunnerError } from "../errors.js";
import type { AgentRunner } from "../runner.js";
import type { Attachment, JobRecord, JobReporter } from "../types.js";
import { SlackJobReporter } from "./delivery.js";
import { normalizeSlackAppHome, normalizeSlackMessage, parseSlackMessage } from "./normalization.js";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type SlackRunner = Pick<AgentRunner, "submit">;

export interface SlackAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Slack behavior shared by Socket Mode and Events API transports. */
export class SlackAdapter {
  private runner?: SlackRunner;
  private readonly allowedWorkspaces: Set<string>;
  private readonly allowedUsers: Set<string>;
  private readonly denialTimes = new Map<string, number>();
  private readonly outputSecrets: string[];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly config: RunnerConfig,
    private readonly secrets: RunnerSecrets & { slackBotToken: string },
    private readonly client: WebClient,
    options: SlackAdapterOptions = {},
  ) {
    this.allowedWorkspaces = new Set(config.slack.allowedWorkspaceIds);
    this.allowedUsers = new Set(config.slack.allowedUserIds);
    this.outputSecrets = [secrets.openCodePassword, secrets.slackBotToken, secrets.slackAppToken ?? ""];
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  attachRunner(runner: SlackRunner): void {
    this.runner = runner;
  }

  reporter(job: JobRecord): JobReporter {
    return new SlackJobReporter(
      this.client,
      job,
      this.config.slack.nativeStreaming,
      this.config.slack.liveUpdates,
      this.outputSecrets,
    );
  }

  async handleMessage(message: unknown, body: unknown, client: WebClient = this.client): Promise<void> {
    const parsed = parseSlackMessage(message, body);
    if (!parsed.accepted) return;
    const event = parsed.message;
    if (!this.allowedWorkspaces.has(event.tenantId) || !this.allowedUsers.has(event.actorId)) {
      await this.postDenial(client, event.tenantId, event.actorId, event.conversationId, event.threadId);
      return;
    }
    if (!this.runner) throw new Error("Slack adapter received a message before the runner was attached");
    const attachments = await this.downloadAttachments(event.files);
    const submission = normalizeSlackMessage(event, attachments);
    if (!submission) return;
    try {
      await this.runner.submit(submission);
    } catch (error) {
      const text = error instanceof RunnerError ? error.message : "The agent runner could not queue this request.";
      await client.chat.postMessage({ channel: event.conversationId, thread_ts: event.threadId, text })
        .catch(() => undefined);
    }
  }

  async handleAppHome(event: unknown, body: unknown, client: WebClient = this.client): Promise<void> {
    const home = normalizeSlackAppHome(event, body);
    if (!home) return;
    if (!this.allowedUsers.has(home.actorId) || !this.allowedWorkspaces.has(home.tenantId)) return;
    await client.assistant.threads.setSuggestedPrompts({
      channel_id: home.conversationId,
      title: "What should the coding agent work on?",
      prompts: [
        { title: "Review changes", message: "Review the current changes and report any issues." },
        { title: "Run tests", message: "Run the test suite, diagnose failures, and fix them." },
      ],
    }).catch(() => undefined);
  }

  private async postDenial(
    client: WebClient,
    workspaceId: string,
    userId: string,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const key = `${workspaceId}:${userId}`;
    const timestamp = this.now();
    if (timestamp - (this.denialTimes.get(key) ?? 0) < 60_000) return;
    this.denialTimes.set(key, timestamp);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "You are not authorized to use this agent.",
    }).catch(() => undefined);
  }

  private async downloadAttachments(files: readonly unknown[]): Promise<Attachment[]> {
    const maxCount = this.config.limits.maxAttachmentsPerJob;
    const maxBytes = this.config.limits.maxAttachmentBytes;
    const attachments: Attachment[] = [];
    for (const file of files) {
      if (attachments.length >= maxCount) break;
      if (typeof file !== "object" || file === null) continue;
      const value = file as Record<string, unknown>;
      const mime = typeof value.mimetype === "string" ? value.mimetype : "";
      if (!IMAGE_MIME_TYPES.has(mime)) continue;
      const url = typeof value.url_private_download === "string"
        ? value.url_private_download
        : typeof value.url_private === "string" ? value.url_private : "";
      if (!url) continue;
      const size = typeof value.size === "number" ? value.size : 0;
      if (size > maxBytes) continue;
      const filename = typeof value.name === "string" ? value.name : "attachment";
      try {
        const response = await this.fetcher(url, {
          headers: { Authorization: `Bearer ${this.secrets.slackBotToken}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > maxBytes) continue;
        attachments.push({
          mime,
          filename,
          dataUrl: `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`,
        });
      } catch {
        // Skip failed Slack downloads.
      }
    }
    return attachments;
  }
}
