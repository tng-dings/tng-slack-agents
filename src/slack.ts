import { App, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { AgentRunner } from "./runner.js";
import type { JobRecord, JobReporter } from "./types.js";
import { RunnerError } from "./errors.js";
import { redactString } from "./audit.js";

interface SlackStream {
  append(input: { markdown_text: string }): Promise<unknown>;
  stop(input?: { markdown_text?: string }): Promise<unknown>;
}

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

  constructor(
    private readonly config: RunnerConfig,
    secrets: RunnerSecrets,
  ) {
    if (!secrets.slackBotToken || !secrets.slackAppToken) throw new Error("Slack tokens are missing");
    this.allowedWorkspaces = new Set(config.slack.allowedWorkspaceIds);
    this.allowedUsers = new Set(config.slack.allowedUserIds);
    this.outputSecrets = [secrets.openCodePassword, secrets.slackBotToken, secrets.slackAppToken];
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
      if (event.channel_type !== "im" || typeof event.user !== "string" || typeof event.text !== "string") return;
      if (event.bot_id || event.subtype) return;
      if (!this.runner) throw new Error("Slack gateway received a message before the runner was attached");
      const channelId = String(event.channel);
      const eventTs = String(event.ts);
      const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : eventTs;
      const workspaceId = typeof event.team === "string" ? event.team : String((body as { team_id?: string }).team_id ?? "");
      if (!this.allowedWorkspaces.has(workspaceId) || !this.allowedUsers.has(event.user)) {
        await this.postDenial(client, workspaceId, event.user, channelId, threadTs);
        return;
      }
      const eventId = (body as { event_id?: unknown }).event_id;
      const sourceEventId = typeof eventId === "string" && eventId ? eventId : `${workspaceId}:${channelId}:${eventTs}`;
      try {
        await this.runner.submit({
          sourceEventId,
          workspaceId,
          channelId,
          threadTs,
          userId: event.user,
          prompt: event.text,
        });
      } catch (error) {
        const message = error instanceof RunnerError ? error.message : "The agent runner could not queue this request.";
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: message }).catch(() => undefined);
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
}
