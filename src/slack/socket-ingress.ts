import { type AllMiddlewareArgs, App, type SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

type AppHomeArgs = SlackEventMiddlewareArgs<"app_home_opened"> & AllMiddlewareArgs;

export interface SlackEventHandler {
  handleMessage(message: unknown, body: unknown, client: WebClient): Promise<void>;
  handleAppHome(event: unknown, body: unknown, client: WebClient): Promise<void>;
}

/** Socket Mode lifecycle and listener wiring only. */
export class SlackSocketIngress {
  constructor(
    readonly app: App,
    private readonly handler: SlackEventHandler,
  ) {
    this.registerListeners();
  }

  async start(): Promise<void> {
    await this.app.start();
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private registerListeners(): void {
    this.app.message(async ({ message, client, body }) => {
      await this.handler.handleMessage(message, body, client);
    });
    this.app.event("app_home_opened", async ({ event, client, body }: AppHomeArgs) => {
      await this.handler.handleAppHome(event, body, client);
    });
  }
}
