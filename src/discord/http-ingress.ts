import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerOptions,
} from "node:http";
import { InteractionResponseFlags, InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import type { DiscordConfig } from "../config.js";
import {
  RateLimitedHttpLogger,
  readBoundedBody,
  sendEmptyResponse,
  sendJsonResponse,
  type HttpSecurityLogSink,
} from "../http.js";
import { asRecord } from "../values.js";
import type { DiscordAdapter } from "./adapter.js";
import type { DiscordDurableInteractionHandler } from "./inbox.js";

const MAX_TIMESTAMP_SKEW_SECONDS = 300;

export type DiscordHttpHardeningOptions = DiscordConfig["http"];

export type DiscordSignatureVerifier = (
  rawBody: Buffer,
  signature: string,
  timestamp: string,
  publicKey: string,
) => Promise<boolean>;

export class DiscordHttpSecurityLogger extends RateLimitedHttpLogger {
  constructor(
    sink: HttpSecurityLogSink = console,
    maxPerMinute = 10,
    now: () => number = Date.now,
  ) {
    super("Discord", sink, maxPerMinute, now);
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function freshTimestamp(value: string | undefined, now: number): value is string {
  if (!value || !/^\d{10}$/.test(value)) return false;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && Math.abs(Math.floor(now / 1_000) - timestamp) <= MAX_TIMESTAMP_SKEW_SECONDS;
}

export interface DiscordRequestHandler {
  accept(command: Parameters<DiscordDurableInteractionHandler["accept"]>[0]): void;
}

export interface DiscordRequestListenerOptions {
  readonly adapter: DiscordAdapter;
  readonly handler: DiscordRequestHandler;
  readonly http: DiscordHttpHardeningOptions;
  readonly publicKey: string;
  readonly verifier?: DiscordSignatureVerifier;
  readonly logger?: DiscordHttpSecurityLogger;
  readonly now?: () => number;
}

/** Authenticates raw Discord requests before parsing or durable acceptance. */
export function createDiscordRequestListener(options: DiscordRequestListenerOptions): RequestListener {
  const verifier = options.verifier ?? verifyKey;
  const logger = options.logger ?? new DiscordHttpSecurityLogger();
  const now = options.now ?? Date.now;
  return (request, response) => {
    void (async () => {
      let url: URL;
      try {
        url = new URL(request.url ?? "", "http://private-listener.invalid");
      } catch {
        sendEmptyResponse(response, 400, { connection: "close" });
        return;
      }
      const exactPath = url.search === "";
      if (exactPath && url.pathname === options.http.healthPath) {
        if (request.method !== "GET") {
          sendEmptyResponse(response, 405, { allow: "GET", connection: "close" });
          return;
        }
        sendJsonResponse(response, 200, { status: "ok" });
        return;
      }
      if (!exactPath || url.pathname !== options.http.interactionsPath) {
        sendEmptyResponse(response, 404, { connection: "close" });
        return;
      }
      if (request.method !== "POST") {
        sendEmptyResponse(response, 405, { allow: "POST", connection: "close" });
        return;
      }
      const contentLength = singleHeader(request, "content-length");
      if (contentLength !== undefined) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared < 0) {
          sendEmptyResponse(response, 400, { connection: "close" });
          return;
        }
        if (declared > options.http.maxBodyBytes) {
          request.resume();
          sendEmptyResponse(response, 413, { connection: "close" });
          return;
        }
      }
      const signature = singleHeader(request, "x-signature-ed25519");
      const timestamp = singleHeader(request, "x-signature-timestamp");
      if (!signature || !/^[0-9a-f]{128}$/i.test(signature) || !freshTimestamp(timestamp, now())) {
        logger.warn("authenticity", "Discord HTTP request rejected during authenticity validation.");
        sendEmptyResponse(response, 401, { connection: "close" });
        return;
      }
      try {
        const rawBody = await readBoundedBody(request, options.http.maxBodyBytes);
        if (!rawBody) {
          sendEmptyResponse(response, 413, { connection: "close" });
          return;
        }
        if (!await verifier(rawBody, signature, timestamp, options.publicKey)) {
          logger.warn("authenticity", "Discord HTTP request rejected during authenticity validation.");
          sendEmptyResponse(response, 401, { connection: "close" });
          return;
        }
        let interaction: unknown;
        try {
          interaction = JSON.parse(rawBody.toString("utf8"));
        } catch {
          logger.warn("malformed", "Discord HTTP request rejected as malformed.");
          sendEmptyResponse(response, 400, { connection: "close" });
          return;
        }
        const value = asRecord(interaction);
        if (value.type === InteractionType.PING) {
          sendJsonResponse(response, 200, { type: InteractionResponseType.PONG });
          return;
        }
        const prepared = options.adapter.prepareInteraction(interaction);
        if (prepared.kind === "rejected") {
          sendJsonResponse(response, 200, {
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: prepared.message,
              flags: InteractionResponseFlags.EPHEMERAL,
              allowed_mentions: { parse: [] },
            },
          });
          return;
        }
        try {
          options.handler.accept(prepared.command);
        } catch {
          logger.error("storage", "Discord interaction could not be committed to durable storage.");
          sendEmptyResponse(response, 503, { connection: "close" });
          return;
        }
        sendJsonResponse(response, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Queued. I’ll post progress and the result in this channel.",
            allowed_mentions: { parse: [] },
          },
        });
      } catch {
        logger.error("receiver", "Discord HTTP receiver error.");
        if (!response.headersSent) sendEmptyResponse(response, 400, { connection: "close" });
      }
    })();
  };
}

export class DiscordHttpIngress {
  private server: Server | undefined;

  constructor(
    private readonly adapter: DiscordAdapter,
    private readonly handler: DiscordDurableInteractionHandler,
    private readonly publicKey: string,
    private readonly http: DiscordHttpHardeningOptions,
  ) {}

  async start(): Promise<Server> {
    this.handler.start();
    try {
      const serverOptions: ServerOptions = {
        connectionsCheckingInterval: Math.min(1_000, this.http.requestTimeoutMs),
        headersTimeout: this.http.headersTimeoutMs,
        keepAliveTimeout: this.http.keepAliveTimeoutMs,
        maxHeaderSize: this.http.maxHeaderBytes,
        requestTimeout: this.http.requestTimeoutMs,
      };
      const server = createServer(serverOptions, createDiscordRequestListener({
        adapter: this.adapter,
        handler: this.handler,
        http: this.http,
        publicKey: this.publicKey,
      }));
      server.maxConnections = this.http.maxConnections;
      server.maxRequestsPerSocket = this.http.maxRequestsPerSocket;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(this.http.port, this.http.host, () => {
          server.off("error", onError);
          resolve();
        });
      });
      this.server = server;
      return server;
    } catch (error) {
      await this.handler.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    }
    await this.handler.stop();
  }
}
