import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerOptions,
  type ServerResponse,
} from "node:http";
import { InteractionResponseFlags, InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import type { DiscordConfig } from "../config.js";
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

interface SecurityLogSink {
  warn(message: string): void;
  error(message: string): void;
}

interface LogBucket {
  windowStartedAt: number;
  count: number;
  suppressionLogged: boolean;
}

export class DiscordHttpSecurityLogger {
  private readonly buckets = new Map<string, LogBucket>();

  constructor(
    private readonly sink: SecurityLogSink = console,
    private readonly maxPerMinute = 10,
    private readonly now: () => number = Date.now,
  ) {}

  warn(category: string, message: string): void {
    this.emit("warn", category, message);
  }

  error(category: string, message: string): void {
    this.emit("error", category, message);
  }

  private emit(level: "warn" | "error", category: string, message: string): void {
    const timestamp = this.now();
    let bucket = this.buckets.get(category);
    if (!bucket || timestamp - bucket.windowStartedAt >= 60_000) {
      bucket = { windowStartedAt: timestamp, count: 0, suppressionLogged: false };
      this.buckets.set(category, bucket);
    }
    if (bucket.count < this.maxPerMinute) {
      bucket.count += 1;
      this.sink[level](message);
    } else if (!bucket.suppressionLogged) {
      bucket.suppressionLogged = true;
      this.sink[level]("Further Discord HTTP receiver failures suppressed for this minute.");
    }
  }
}

function emptyResponse(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end();
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function bufferWithinLimit(request: IncomingMessage, maximum: number): Promise<Buffer | undefined> {
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onAborted);
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maximum) {
        settled = true;
        cleanup();
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Request body was aborted"));
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onAborted);
  });
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
        emptyResponse(response, 400, { connection: "close" });
        return;
      }
      const exactPath = url.search === "";
      if (exactPath && url.pathname === options.http.healthPath) {
        if (request.method !== "GET") {
          emptyResponse(response, 405, { allow: "GET", connection: "close" });
          return;
        }
        jsonResponse(response, 200, { status: "ok" });
        return;
      }
      if (!exactPath || url.pathname !== options.http.interactionsPath) {
        emptyResponse(response, 404, { connection: "close" });
        return;
      }
      if (request.method !== "POST") {
        emptyResponse(response, 405, { allow: "POST", connection: "close" });
        return;
      }
      const contentLength = singleHeader(request, "content-length");
      if (contentLength !== undefined) {
        const declared = Number(contentLength);
        if (!Number.isSafeInteger(declared) || declared < 0) {
          emptyResponse(response, 400, { connection: "close" });
          return;
        }
        if (declared > options.http.maxBodyBytes) {
          request.resume();
          emptyResponse(response, 413, { connection: "close" });
          return;
        }
      }
      const signature = singleHeader(request, "x-signature-ed25519");
      const timestamp = singleHeader(request, "x-signature-timestamp");
      if (!signature || !/^[0-9a-f]{128}$/i.test(signature) || !freshTimestamp(timestamp, now())) {
        logger.warn("authenticity", "Discord HTTP request rejected during authenticity validation.");
        emptyResponse(response, 401, { connection: "close" });
        return;
      }
      try {
        const rawBody = await bufferWithinLimit(request, options.http.maxBodyBytes);
        if (!rawBody) {
          emptyResponse(response, 413, { connection: "close" });
          return;
        }
        if (!await verifier(rawBody, signature, timestamp, options.publicKey)) {
          logger.warn("authenticity", "Discord HTTP request rejected during authenticity validation.");
          emptyResponse(response, 401, { connection: "close" });
          return;
        }
        let interaction: unknown;
        try {
          interaction = JSON.parse(rawBody.toString("utf8"));
        } catch {
          logger.warn("malformed", "Discord HTTP request rejected as malformed.");
          emptyResponse(response, 400, { connection: "close" });
          return;
        }
        const value = interaction as Record<string, unknown>;
        if (value.type === InteractionType.PING) {
          jsonResponse(response, 200, { type: InteractionResponseType.PONG });
          return;
        }
        const prepared = options.adapter.prepareInteraction(interaction);
        if (prepared.kind === "rejected") {
          jsonResponse(response, 200, {
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
          emptyResponse(response, 503, { connection: "close" });
          return;
        }
        jsonResponse(response, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Queued. I’ll post progress and the result in this channel.",
            allowed_mentions: { parse: [] },
          },
        });
      } catch {
        logger.error("receiver", "Discord HTTP receiver error.");
        if (!response.headersSent) emptyResponse(response, 400, { connection: "close" });
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
