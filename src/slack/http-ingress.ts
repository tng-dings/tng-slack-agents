import type { Server } from "node:http";
import type { App, HTTPReceiver } from "@slack/bolt";
import type { SlackEventHandler } from "./socket-ingress.js";

interface DurableSlackEventHandler extends SlackEventHandler {
  start(): void;
  stop(): Promise<void>;
}

/** Slack Events API lifecycle and listener wiring only. */
export class SlackHttpIngress {
  private started = false;

  constructor(
    readonly app: App,
    readonly receiver: HTTPReceiver,
    private readonly handler: DurableSlackEventHandler,
    private readonly host: string,
    private readonly port: number,
  ) {
    this.registerListeners();
  }

  async start(): Promise<Server> {
    this.handler.start();
    try {
      const server = await this.receiver.start({ host: this.host, port: this.port });
      this.started = true;
      return server;
    } catch (error) {
      await this.handler.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false;
      await this.receiver.stop();
    }
    await this.handler.stop();
  }

  private registerListeners(): void {
    this.app.message(async ({ message, client, body }) => {
      await this.handler.handleMessage(message, body, client);
    });
    this.app.event("app_home_opened", async ({ event, client, body }) => {
      await this.handler.handleAppHome(event, body, client);
    });
  }
}
