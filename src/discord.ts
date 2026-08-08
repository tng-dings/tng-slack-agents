import type { RunnerConfig, RunnerSecrets } from "./config.js";
import type { RunnerDatabase } from "./database.js";
import type { AgentRunner } from "./runner.js";
import type { JobRecord, JobReporter } from "./types.js";
import { DiscordAdapter } from "./discord/adapter.js";
import { DiscordApiClient } from "./discord/delivery.js";
import { DiscordHttpIngress } from "./discord/http-ingress.js";
import { DiscordGatewayIngress } from "./discord/gateway-ingress.js";
import { DiscordDurableInteractionHandler } from "./discord/inbox.js";

export { DiscordAdapter, type DiscordAdapterOptions, type DiscordInteractionPreparation } from "./discord/adapter.js";
export {
  DiscordApiClient,
  DiscordJobReporter,
  discordMessageChunks,
  type DiscordApi,
  type DiscordSessionApi,
  type DiscordMessage,
} from "./discord/delivery.js";
export {
  createDiscordRequestListener,
  DiscordHttpIngress,
  DiscordHttpSecurityLogger,
  type DiscordHttpHardeningOptions,
  type DiscordRequestListenerOptions,
  type DiscordSignatureVerifier,
} from "./discord/http-ingress.js";
export { DiscordDurableInteractionHandler } from "./discord/inbox.js";
export { DiscordGatewayIngress } from "./discord/gateway-ingress.js";
export {
  DISCORD_IMAGE_MIME_TYPES,
  normalizeDiscordCommand,
  parseDiscordCommand,
  parseDiscordThreadMessage,
  type DiscordAttachmentReference,
  type DiscordCommandIgnoreReason,
  type DiscordCommandParseResult,
  type DiscordMessageIgnoreReason,
  type DiscordMessageParseResult,
  type ParsedDiscordCommand,
} from "./discord/normalization.js";
export { discordGuildCommand, type DiscordGuildCommandDefinition } from "./discord/registration.js";

/** Composes Discord ingress, normalization, durable handoff, and bot delivery. */
export class DiscordGateway {
  readonly api: DiscordApiClient;
  readonly adapter: DiscordAdapter;
  readonly ingress: DiscordHttpIngress | DiscordGatewayIngress;

  constructor(config: RunnerConfig, secrets: RunnerSecrets, database: RunnerDatabase) {
    if (!config.discord.applicationId) throw new Error("Discord application ID is missing");
    if (!secrets.discordBotToken) throw new Error("Discord bot token is missing");
    this.api = new DiscordApiClient(secrets.discordBotToken);
    const outputSecrets = [
      secrets.openCodePassword,
      secrets.discordBotToken,
      secrets.slackBotToken ?? "",
      secrets.slackAppToken ?? "",
      secrets.slackSigningSecret ?? "",
    ];
    this.adapter = new DiscordAdapter(config, this.api, database, outputSecrets);
    const handler = new DiscordDurableInteractionHandler(database, this.adapter, config.queue.pollIntervalMs);
    if (config.discord.ingress === "gateway") {
      this.ingress = new DiscordGatewayIngress(this.adapter, handler, this.api, secrets.discordBotToken);
    } else {
      if (!secrets.discordPublicKey) throw new Error("Discord public key is missing");
      this.ingress = new DiscordHttpIngress(this.adapter, handler, secrets.discordPublicKey, config.discord.http);
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
