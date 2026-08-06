import { App, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { AgentRunner } from "./runner.js";
import type { Attachment, JobRecord, JobReporter } from "./types.js";
import { RunnerError } from "./errors.js";
import { redactString } from "./audit.js";

interface SlackStream {
  append(input: { markdown_text: string }): Promise<unknown>;
  stop(input?: { markdown_text?: string }): Promise<unknown>;
}

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function messageText(output: string, secrets: string[]): string {
  const limit = 39_000;
  const redacted = redactString(output, secrets);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}\n\n_(Output truncated.)_`;
}

export class SlackJobReporter implements JobReporter {
  private output = "";
  private pending = "";
  private stream: SlackStream | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private nativeFailed = false;
  private chain = Promise.resolve();
  private replyTs: string | null;

  constructor(
    private readonly client: WebClient,
    private readonly job: JobRecord,
    private readonly nativeStreaming: boolean,
    private readonly liveUpdates = true,
    private readonly secrets: string[] = [],
  ) {
    this.replyTs = job.replyTs;
  }

  async start(): Promise<{ replyTs?: string } | void> {
    await this.setStatus("Working…");
    if (this.replyTs) return;
    const posted = await this.client.chat.postMessage({
      channel: this.job.channelId,
      thread_ts: this.job.threadTs,
      text: "Working…",
    });
    if (posted.ts) {
      this.replyTs = posted.ts;
      return { replyTs: posted.ts };
    }
  }

  async append(delta: string): Promise<void> {
    this.output += delta;
    this.pending += delta;
    if (!this.liveUpdates) return;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.chain = this.chain.then(() => this.flush());
      }, 750);
    }
  }

  async succeed(output: string): Promise<void> {
    this.output = output || this.output;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.chain;
    await this.flush();
    if (this.stream) {
      await this.stream.stop();
      await this.updateWorkingMessage("Completed.");
    } else {
      await this.updateWorkingMessage(messageText(this.output || "Completed with no text response.", this.secrets));
    }
    await this.setStatus("");
  }

  async fail(message: string): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.chain;
    if (this.stream) await this.stream.stop().catch(() => undefined);
    await this.updateWorkingMessage(messageText(`Agent job failed: ${message}`, this.secrets));
    await this.setStatus("");
  }

  private async flush(): Promise<void> {
    const delta = this.pending;
    this.pending = "";
    if (!delta) return;
    if (!this.liveUpdates) return;
    if (this.nativeStreaming && !this.nativeFailed) {
      try {
        this.stream ??= this.client.chatStream({
          channel: this.job.channelId,
          thread_ts: this.job.threadTs,
          recipient_team_id: this.job.workspaceId,
          recipient_user_id: this.job.userId,
        });
        await this.stream.append({ markdown_text: delta });
        return;
      } catch {
        this.nativeFailed = true;
        this.stream = undefined;
      }
    }
    await this.updateWorkingMessage(messageText(this.output, this.secrets));
  }

  private async updateWorkingMessage(text: string): Promise<void> {
    if (this.replyTs) {
      await this.client.chat.update({ channel: this.job.channelId, ts: this.replyTs, text });
    } else {
      await this.client.chat.postMessage({ channel: this.job.channelId, thread_ts: this.job.threadTs, text });
    }
  }

  private async setStatus(status: string): Promise<void> {
    await this.client.assistant.threads
      .setStatus({ channel_id: this.job.channelId, thread_ts: this.job.threadTs, status })
      .catch(() => undefined);
  }
}

type AppHomeArgs = SlackEventMiddlewareArgs<"app_home_opened"> & AllMiddlewareArgs;

export class SlackGateway {
  readonly app: App;
  private runner?: AgentRunner;
  private readonly allowedWorkspaces: Set<string>;
  private readonly allowedUsers: Set<string>;
  private readonly denialTimes = new Map<string, number>();
  private readonly outputSecrets: string[];
  private readonly botToken: string;

  constructor(
    private readonly config: RunnerConfig,
    secrets: RunnerSecrets,
  ) {
    if (!secrets.slackBotToken || !secrets.slackAppToken) throw new Error("Slack tokens are missing");
    this.allowedWorkspaces = new Set(config.slack.allowedWorkspaceIds);
    this.allowedUsers = new Set(config.slack.allowedUserIds);
    this.outputSecrets = [secrets.openCodePassword, secrets.slackBotToken, secrets.slackAppToken];
    this.botToken = secrets.slackBotToken;
    this.app = new App({
      token: secrets.slackBotToken,
      appToken: secrets.slackAppToken,
      socketMode: true,
    });
    this.registerListeners();
  }

  attachRunner(runner: AgentRunner): void {
    this.runner = runner;
  }

  reporter(job: JobRecord): JobReporter {
    return new SlackJobReporter(
      this.app.client,
      job,
      this.config.slack.nativeStreaming,
      this.config.slack.liveUpdates,
      this.outputSecrets,
    );
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private registerListeners(): void {
    this.app.message(async ({ message, client, body }) => {
      const event = message as unknown as Record<string, unknown>;
      if (event.channel_type !== "im" || typeof event.user !== "string") return;
      if (event.bot_id || event.subtype) return;
      if (!this.runner) throw new Error("Slack gateway received a message before the runner was attached");
      const channelId = String(event.channel);
      const eventTs = String(event.ts);
      const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : eventTs;
      const workspaceId = typeof event.team === "string" ? event.team : String((body as { team_id?: string }).team_id ?? "");
      const text = typeof event.text === "string" ? event.text : "";
      const rawFiles = Array.isArray(event.files) ? event.files : [];
      if (!text.trim() && rawFiles.length === 0) return;
      if (!this.allowedWorkspaces.has(workspaceId) || !this.allowedUsers.has(event.user)) {
        await this.postDenial(client, workspaceId, event.user, channelId, threadTs);
        return;
      }
      const attachments = await this.downloadAttachments(rawFiles);
      const prompt = text.trim() || (attachments.length > 0 ? "Please review the attached screenshot(s)." : "");
      if (!prompt) return;
      const eventId = (body as { event_id?: unknown }).event_id;
      const sourceEventId = typeof eventId === "string" && eventId ? eventId : `${workspaceId}:${channelId}:${eventTs}`;
      try {
        await this.runner.submit({
          sourceEventId,
          workspaceId,
          channelId,
          threadTs,
          userId: event.user,
          prompt,
          attachments,
        });
      } catch (error) {
        const errorMessage = error instanceof RunnerError ? error.message : "The agent runner could not queue this request.";
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: errorMessage }).catch(() => undefined);
      }
    });

    this.app.event("app_home_opened", async ({ event, client, body }: AppHomeArgs) => {
      const value = event as unknown as { tab?: string; channel?: string; user?: string };
      if (value.tab !== "messages" || !value.channel) return;
      const workspaceId = String((body as { team_id?: string }).team_id ?? "");
      if (!value.user || !this.allowedUsers.has(value.user) || !this.allowedWorkspaces.has(workspaceId)) return;
      await client.assistant.threads
        .setSuggestedPrompts({
          channel_id: value.channel,
          title: "What should the coding agent work on?",
          prompts: [
            { title: "Review changes", message: "Review the current changes and report any issues." },
            { title: "Run tests", message: "Run the test suite, diagnose failures, and fix them." },
          ],
        })
        .catch(() => undefined);
    });
  }

  private async postDenial(
    client: WebClient,
    workspaceId: string,
    userId: string,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const key = `${workspaceId}:${userId}`;
    const timestamp = Date.now();
    if (timestamp - (this.denialTimes.get(key) ?? 0) < 60_000) return;
    this.denialTimes.set(key, timestamp);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "You are not authorized to use this agent.",
    }).catch(() => undefined);
  }

  private async downloadAttachments(files: unknown[]): Promise<Attachment[]> {
    const maxCount = this.config.limits.maxAttachmentsPerJob;
    const maxBytes = this.config.limits.maxAttachmentBytes;
    const attachments: Attachment[] = [];
    for (const file of files) {
      if (attachments.length >= maxCount) break;
      if (typeof file !== "object" || file === null) continue;
      const f = file as Record<string, unknown>;
      const mime = typeof f.mimetype === "string" ? f.mimetype : "";
      if (!IMAGE_MIME_TYPES.has(mime)) continue;
      const url =
        typeof f.url_private_download === "string" ? f.url_private_download :
        typeof f.url_private === "string" ? f.url_private : "";
      if (!url) continue;
      const size = typeof f.size === "number" ? f.size : 0;
      if (size > maxBytes) continue;
      const filename = typeof f.name === "string" ? f.name : "attachment";
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) continue;
        const buffer = await response.arrayBuffer();
        const bytes = buffer.byteLength;
        if (bytes > maxBytes) continue;
        const base64 = Buffer.from(buffer).toString("base64");
        attachments.push({ mime, filename, dataUrl: `data:${mime};base64,${base64}` });
      } catch {
        // skip failed downloads
      }
    }
    return attachments;
  }
}
