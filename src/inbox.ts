import type { RunnerDatabase } from "./database.js";
import type { InboundEventRecord, IntegrationId } from "./types.js";

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

/** Polls and retries one integration's durable inbox. */
export class DurableInboxPump {
  private active: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;

  constructor(
    private readonly database: RunnerDatabase,
    private readonly integration: IntegrationId,
    private readonly integrationName: string,
    private readonly pollIntervalMs: number,
    private readonly dispatch: (event: InboundEventRecord) => Promise<void>,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.database.recoverInboundEvents(this.integration);
    this.timer = setInterval(() => this.pump(), this.pollIntervalMs);
    this.timer.unref();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active?.catch(() => undefined);
  }

  wake(): void {
    setImmediate(() => this.pump());
  }

  private pump(): void {
    if (!this.started || this.stopping || this.active) return;
    const event = this.database.claimNextInboundEvent(this.integration);
    if (!event) return;
    const task = this.process(event).finally(() => {
      if (this.active === task) this.active = undefined;
      this.wake();
    });
    this.active = task;
  }

  private async process(event: InboundEventRecord): Promise<void> {
    try {
      await this.dispatch(event);
      this.database.completeInboundEvent(event.eventKey);
    } catch (error) {
      const label = errorLabel(error);
      const delayMs = Math.min(60_000, 1_000 * (2 ** Math.min(event.attempts, 6)));
      this.database.retryInboundEvent(event.eventKey, label, delayMs);
      console.error(`${this.integrationName} inbox processing failed; the event will be retried`, label);
    }
  }
}
