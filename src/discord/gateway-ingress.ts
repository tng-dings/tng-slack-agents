import { GatewayDispatchEvents, GatewayIntentBits, type GatewayDispatchPayload } from "discord-api-types/v10";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { REST } from "@discordjs/rest";
import type { DiscordAdapter } from "./adapter.js";
import type { DiscordSessionApi } from "./delivery.js";
import type { DiscordDurableInteractionHandler } from "./inbox.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Outbound-only Discord transport for slash commands and agent-thread messages. */
export class DiscordGatewayIngress {
  private readonly manager: WebSocketManager;
  private started = false;

  constructor(
    private readonly adapter: DiscordAdapter,
    private readonly handler: DiscordDurableInteractionHandler,
    private readonly api: DiscordSessionApi,
    botToken: string,
  ) {
    this.manager = new WebSocketManager({
      token: botToken,
      intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent,
      rest: new REST({ version: "10" }).setToken(botToken),
    });
    this.manager.on(WebSocketShardEvents.Dispatch, (payload) => {
      void this.dispatch(payload).catch((error: unknown) => {
        console.error("Discord Gateway event processing failed", error instanceof Error ? error.name : typeof error);
      });
    });
    this.manager.on(WebSocketShardEvents.Error, (error) => {
      console.error("Discord Gateway connection error", error.name);
    });
    this.manager.on(WebSocketShardEvents.SocketError, (error) => {
      console.error("Discord Gateway socket error", error.name);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.handler.start();
    try {
      const ready = new Promise<void>((resolve) => {
        this.manager.once(WebSocketShardEvents.Ready, () => resolve());
      });
      await this.manager.connect();
      let readyTimeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            readyTimeout = setTimeout(() => reject(new Error("Discord Gateway did not become ready within 30 seconds")), 30_000);
            readyTimeout.unref();
          }),
        ]);
      } finally {
        if (readyTimeout) clearTimeout(readyTimeout);
      }
    } catch (error) {
      this.started = false;
      await Promise.resolve(this.manager.destroy()).catch(() => undefined);
      await this.handler.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.manager.destroy();
    await this.handler.stop();
  }

  async dispatch(payload: GatewayDispatchPayload): Promise<void> {
    if (payload.t === GatewayDispatchEvents.InteractionCreate) {
      await this.handleInteraction(payload.d);
      return;
    }
    if (payload.t === GatewayDispatchEvents.MessageCreate) {
      await this.handleMessage(payload.d);
    }
  }

  private async handleInteraction(value: unknown): Promise<void> {
    const interaction = record(value);
    const id = typeof interaction.id === "string" ? interaction.id : "";
    const token = typeof interaction.token === "string" ? interaction.token : "";
    if (!id || !token) return;
    const prepared = this.adapter.prepareInteraction(value);
    if (prepared.kind === "rejected") {
      await this.api.replyToInteraction(id, token, prepared.message, true);
      return;
    }
    this.handler.accept(prepared.command);
    await this.api.replyToInteraction(id, token, "Creating an agent thread…", true);
  }

  private async handleMessage(value: unknown): Promise<void> {
    const prepared = this.adapter.prepareThreadMessage(value);
    if (prepared.kind === "ignored") return;
    if (prepared.kind === "rejected") {
      const message = record(value);
      const channelId = typeof message.channel_id === "string" ? message.channel_id : "";
      const sourceId = typeof message.id === "string" ? message.id : "rejected-message";
      if (channelId) await this.api.createMessage(channelId, prepared.message, sourceId.slice(0, 25));
      return;
    }
    this.handler.accept(prepared.command);
  }
}
