import { App } from "@slack/bolt";
import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { AgentRunner } from "./runner.js";
import type { JobRecord, JobReporter } from "./types.js";
import { SlackAdapter } from "./slack/adapter.js";
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

/** Backwards-compatible Socket Mode composition root. */
export class SlackGateway {
  readonly app: App;
  readonly adapter: SlackAdapter;
  readonly ingress: SlackSocketIngress;

  constructor(config: RunnerConfig, secrets: RunnerSecrets) {
    if (!secrets.slackBotToken || !secrets.slackAppToken) throw new Error("Slack tokens are missing");
    this.app = new App({
      token: secrets.slackBotToken,
      appToken: secrets.slackAppToken,
      socketMode: true,
    });
    this.adapter = new SlackAdapter(
      config,
      { ...secrets, slackBotToken: secrets.slackBotToken },
      this.app.client,
    );
    this.ingress = new SlackSocketIngress(this.app, this.adapter);
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
