import type { WebClient } from "@slack/web-api";
import { redactString } from "../audit.js";
import type { JobRecord, JobReporter } from "../types.js";

function messageText(output: string, secrets: string[]): string {
  const limit = 39_000;
  const redacted = redactString(output, secrets);
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit)}\n\n_(Output truncated.)_`;
}

/** Slack result delivery, independent of Socket Mode or HTTP ingress. */
export class SlackJobReporter implements JobReporter {
  private output = "";
  private pending = "";
  private flushTimer: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();
  private replyTs: string | null;

  constructor(
    private readonly client: WebClient,
    private readonly job: JobRecord,
    private readonly liveUpdates = true,
    private readonly secrets: string[] = [],
  ) {
    this.replyTs = job.deliveryMessageId;
  }

  async start(): Promise<{ deliveryMessageId?: string } | void> {
    await this.setStatus("Working…");
    if (this.replyTs) return;
    const posted = await this.client.chat.postMessage({
      channel: this.job.conversationId,
      thread_ts: this.job.threadId,
      text: "Working…",
    });
    if (posted.ts) {
      this.replyTs = posted.ts;
      return { deliveryMessageId: posted.ts };
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
    await this.updateWorkingMessage(messageText(this.output || "Completed with no text response.", this.secrets));
    await this.setStatus("");
  }

  async fail(message: string): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.chain;
    await this.updateWorkingMessage(messageText(`Agent job failed: ${message}`, this.secrets));
    await this.setStatus("");
  }

  private async flush(): Promise<void> {
    const delta = this.pending;
    this.pending = "";
    if (!delta || !this.liveUpdates) return;
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
