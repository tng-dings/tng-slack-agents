import { App, type AllMiddlewareArgs, type SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { AgentRunner } from "./runner.js";
import type { JobRecord, JobReporter } from "./types.js";
import { RunnerError } from "./errors.js";

interface SlackStream {
  append(input: { markdown_text: string }): Promise<unknown>;
  stop(input?: { markdown_text?: string }): Promise<unknown>;
}

function messageText(output: string): string {
  const limit = 39_000;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n\n_(Output truncated in Slack; the full response is in the audit record.)_`;
}

export class SlackJobReporter implements JobReporter {
  private output = "";
  private pending = "";
  private stream: SlackStream | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private nativeFailed = false;
  private chain = Promise.resolve();

  constructor(
    private readonly client: WebClient,
    private readonly job: JobRecord,
    private readonly nativeStreaming: boolean,
  ) {}

  async start(): Promise<void> {
    await this.setStatus("Working…");
  }

  async append(delta: string): Promise<void> {
    this.output += delta;
    this.pending += delta;
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
      await this.updateWorkingMessage(messageText(this.output || "Completed with no text response."));
    }
    await this.setStatus("");
  }

  async fail(message: string): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.chain;
    if (this.stream) await this.stream.stop().catch(() => undefined);
    await this.updateWorkingMessage(`Agent job failed: ${message}`);
    await this.setStatus("");
  }

  private async flush(): Promise<void> {
    const delta = this.pending;
    this.pending = "";
    if (!delta) return;
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
    await this.updateWorkingMessage(messageText(this.output));
  }

  private async updateWorkingMessage(text: string): Promise<void> {
    if (this.job.replyTs) {
      await this.client.chat.update({ channel: this.job.channelId, ts: this.job.replyTs, text });
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

  constructor(
    private readonly config: RunnerConfig,
    secrets: RunnerSecrets,
  ) {
    if (!secrets.slackBotToken || !secrets.slackAppToken) throw new Error("Slack tokens are missing");
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
    return new SlackJobReporter(this.app.client, job, this.config.slack.nativeStreaming);
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
      const sourceEventId = typeof event.client_msg_id === "string" ? event.client_msg_id : `${workspaceId}:${channelId}:${eventTs}`;
      const working = await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "Working…" });
      try {
        await this.runner.submit({
          sourceEventId,
          workspaceId,
          channelId,
          threadTs,
          ...(working.ts ? { replyTs: working.ts } : {}),
          userId: event.user,
          prompt: event.text,
        });
      } catch (error) {
        const message = error instanceof RunnerError ? error.message : "The agent runner could not queue this request.";
        if (working.ts) await client.chat.update({ channel: channelId, ts: working.ts, text: message });
      }
    });

    this.app.event("app_home_opened", async ({ event, client }: AppHomeArgs) => {
      const value = event as unknown as { tab?: string; channel?: string };
      if (value.tab !== "messages" || !value.channel) return;
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
}
