import { App, HTTPReceiver } from "@slack/bolt";
import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { RunnerDatabase } from "./database.js";
import type { AgentRunner } from "./runner.js";
import type { JobRecord, JobReporter } from "./types.js";
import { SlackAdapter } from "./slack/adapter.js";
import { SlackHttpIngress } from "./slack/http-ingress.js";
import { SlackDurableEventHandler } from "./slack/inbox.js";
import { SlackSocketIngress } from "./slack/socket-ingress.js";

export { SlackAdapter, type SlackAdapterOptions } from "./slack/adapter.js";
export { SlackJobReporter } from "./slack/delivery.js";
export {
  normalizeSlackAppHome,
  normalizeSlackMessage,
  parseSlackMessage,
  SLACK_ATTACHMENT_PROMPT,
  type NormalizedSlackAppHome,
  type ParsedSlackMessage,
  type SlackMessageIgnoreReason,
  type SlackMessageParseResult,
} from "./slack/normalization.js";
export { SlackSocketIngress, type SlackEventHandler } from "./slack/socket-ingress.js";
export { SlackHttpIngress } from "./slack/http-ingress.js";
export { SlackDurableEventHandler } from "./slack/inbox.js";

/** Selects one Slack ingress while sharing normalization, processing, and delivery. */
export class SlackGateway {
  readonly app: App;
  readonly adapter: SlackAdapter;
  readonly ingress: SlackSocketIngress | SlackHttpIngress;

  constructor(config: RunnerConfig, secrets: RunnerSecrets, database: RunnerDatabase) {
    if (!secrets.slackBotToken) throw new Error("Slack bot token is missing");
    if (config.slack.ingress === "socket" && !secrets.slackAppToken) throw new Error("Slack app token is missing");
    if (config.slack.ingress === "events-api" && !secrets.slackSigningSecret) {
      throw new Error("Slack signing secret is missing");
    }

    let receiver: HTTPReceiver | undefined;
    if (config.slack.ingress === "socket") {
      this.app = new App({
        token: secrets.slackBotToken,
        appToken: secrets.slackAppToken!,
        socketMode: true,
      });
    } else {
      receiver = new HTTPReceiver({
        signingSecret: secrets.slackSigningSecret!,
        endpoints: config.slack.http.eventsPath,
        processBeforeResponse: true,
        signatureVerification: true,
        customRoutes: [{
          path: config.slack.http.healthPath,
          method: "GET",
          handler: (_request, response) => {
            response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            response.end('{"status":"ok"}');
          },
        }],
      });
      this.app = new App({ token: secrets.slackBotToken, receiver });
    }
    this.adapter = new SlackAdapter(
      config,
      { ...secrets, slackBotToken: secrets.slackBotToken },
      this.app.client,
    );
    if (receiver) {
      const handler = new SlackDurableEventHandler(database, this.adapter, config.queue.pollIntervalMs);
      this.ingress = new SlackHttpIngress(
        this.app,
        receiver,
        handler,
        config.slack.http.host,
        config.slack.http.port,
      );
    } else {
      this.ingress = new SlackSocketIngress(this.app, this.adapter);
    }
  }

  attachRunner(runner: AgentRunner): void {
    this.adapter.attachRunner(runner);
  }

  reporter(job: JobRecord): JobReporter {
    return this.adapter.reporter(job);
  }

  async start(): Promise<void> {
    await this.ingress.start();
  }

  async stop(): Promise<void> {
    await this.ingress.stop();
  }
}
