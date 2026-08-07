import type { WebClient } from "@slack/web-api";
import { redactString } from "../audit.js";
import type { JobRecord, JobReporter } from "../types.js";

interface SlackStream {
  append(input: { markdown_text: string }): Promise<unknown>;
  stop(input?: { markdown_text?: string }): Promise<unknown>;
}

function messageText(output: string, secrets: string[]): string {
  const limit = 39_000;
  const redacted = redactString(output, secrets);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}\n\n_(Output truncated.)_`;
}

/** Slack result delivery, independent of Socket Mode or HTTP ingress. */
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
      channel: this.job.conversationId,
      thread_ts: this.job.threadId,
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
    if (!delta || !this.liveUpdates) return;
    if (this.nativeStreaming && !this.nativeFailed) {
      try {
        this.stream ??= this.client.chatStream({
          channel: this.job.conversationId,
          thread_ts: this.job.threadId,
          recipient_team_id: this.job.tenantId,
          recipient_user_id: this.job.actorId,
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
      await this.client.chat.update({ channel: this.job.conversationId, ts: this.replyTs, text });
    } else {
      await this.client.chat.postMessage({ channel: this.job.conversationId, thread_ts: this.job.threadId, text });
    }
  }

  private async setStatus(status: string): Promise<void> {
    await this.client.assistant.threads
      .setStatus({ channel_id: this.job.conversationId, thread_ts: this.job.threadId, status })
      .catch(() => undefined);
  }
}
