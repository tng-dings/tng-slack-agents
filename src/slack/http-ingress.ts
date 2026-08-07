import type { IncomingMessage, RequestListener, Server, ServerOptions, ServerResponse } from "node:http";
import { LogLevel, type App, type HTTPReceiver, type Logger } from "@slack/bolt";
import type { SlackEventHandler } from "./socket-ingress.js";

interface DurableSlackEventHandler extends SlackEventHandler {
  start(): void;
  stop(): Promise<void>;
}

export interface SlackHttpHardeningOptions {
  eventsPath: string;
  healthPath: string;
  maxBodyBytes: number;
  maxHeaderBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxRequestsPerSocket: number;
  maxConnections: number;
}

export const defaultSlackHttpHardening: Readonly<SlackHttpHardeningOptions> = {
  eventsPath: "/slack/events",
  healthPath: "/healthz",
  maxBodyBytes: 256 * 1024,
  maxHeaderBytes: 16 * 1024,
  requestTimeoutMs: 5_000,
  headersTimeoutMs: 5_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 100,
  maxConnections: 100,
};

interface SecurityLogSink {
  warn(message: string): void;
  error(message: string): void;
}

interface LogBucket {
  windowStartedAt: number;
  count: number;
  suppressionLogged: boolean;
}

/** Content-free, bounded logging for attacker-controlled HTTP failures. */
export class SlackHttpSecurityLogger implements Logger {
  private level = LogLevel.WARN;
  private readonly buckets = new Map<string, LogBucket>();

  constructor(
    private readonly sink: SecurityLogSink = console,
    private readonly maxPerMinute = 10,
    private readonly now: () => number = Date.now,
  ) {}

  debug(..._messages: unknown[]): void {}
  info(..._messages: unknown[]): void {}

  warn(...messages: unknown[]): void {
    const first = typeof messages[0] === "string" ? messages[0] : "";
    if (first.startsWith("Malformed request body")) {
      this.emit("warn", "malformed", "Slack HTTP request rejected as malformed.");
    } else if (first.includes("parse and verify") || first.includes("authenticity")) {
      this.emit("warn", "authenticity", "Slack HTTP request rejected during authenticity validation.");
    } else {
      this.emit("warn", "receiver-warning", "Slack HTTP receiver warning.");
    }
  }

  error(..._messages: unknown[]): void {
    this.emit("error", "receiver-error", "Slack HTTP receiver error.");
  }

  setLevel(level: LogLevel): void { this.level = level; }
  getLevel(): LogLevel { return this.level; }
  setName(_name: string): void {}

  private emit(level: "warn" | "error", category: string, message: string): void {
    const now = this.now();
    let bucket = this.buckets.get(category);
    if (!bucket || now - bucket.windowStartedAt >= 60_000) {
      bucket = { windowStartedAt: now, count: 0, suppressionLogged: false };
      this.buckets.set(category, bucket);
    }
    if (bucket.count < this.maxPerMinute) {
      bucket.count += 1;
      this.sink[level](message);
    } else if (!bucket.suppressionLogged) {
      bucket.suppressionLogged = true;
      this.sink[level]("Further Slack HTTP receiver failures suppressed for this minute.");
    }
  }
}

interface BufferedIncomingMessage extends IncomingMessage {
  rawBody: Buffer;
}

function emptyResponse(response: ServerResponse, status: number, extraHeaders: Record<string, string> = {}): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end();
}

function healthResponse(response: ServerResponse): void {
  const body = '{"status":"ok"}';
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

async function bufferWithinLimit(request: IncomingMessage, maxBytes: number): Promise<Buffer | undefined> {
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stopReading = (): void => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        settled = true;
        stopReading();
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      stopReading();
      resolve(Buffer.concat(chunks, total));
    };
    const onAborted = (): void => {
      if (settled) return;
      settled = true;
      stopReading();
      reject(new Error("Request body was aborted"));
    };
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onAborted);
  });
}

/** Runs before Bolt so its raw-body parser only ever sees a bounded buffer. */
export function hardenSlackRequestListener(
  boltListener: RequestListener,
  options: SlackHttpHardeningOptions,
): RequestListener {
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
      if (exactPath && url.pathname === options.healthPath) {
        if (request.method !== "GET") {
          emptyResponse(response, 405, { allow: "GET", connection: "close" });
          return;
        }
        healthResponse(response);
        return;
      }
      if (!exactPath || url.pathname !== options.eventsPath) {
        emptyResponse(response, 404, { connection: "close" });
        return;
      }
      if (request.method !== "POST") {
        emptyResponse(response, 405, { allow: "POST", connection: "close" });
        return;
      }

      const contentLengthHeader = request.headers["content-length"];
      if (Array.isArray(contentLengthHeader)) {
        emptyResponse(response, 400, { connection: "close" });
        return;
      }
      if (contentLengthHeader !== undefined) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          emptyResponse(response, 400, { connection: "close" });
          return;
        }
        if (contentLength > options.maxBodyBytes) {
          request.resume();
          emptyResponse(response, 413, { connection: "close" });
          return;
        }
      }

      try {
        const rawBody = await bufferWithinLimit(request, options.maxBodyBytes);
        if (!rawBody) {
          emptyResponse(response, 413, { connection: "close" });
          return;
        }
        (request as BufferedIncomingMessage).rawBody = rawBody;
        boltListener(request, response);
      } catch {
        if (!response.headersSent) emptyResponse(response, 400, { connection: "close" });
      }
    })();
  };
}

/** Slack Events API lifecycle and listener wiring only. */
export class SlackHttpIngress {
  private started = false;
  private readonly hardening: SlackHttpHardeningOptions;

  constructor(
    readonly app: App,
    readonly receiver: HTTPReceiver,
    private readonly handler: DurableSlackEventHandler,
    private readonly host: string,
    private readonly port: number,
    hardening: Partial<SlackHttpHardeningOptions> = {},
  ) {
    this.hardening = { ...defaultSlackHttpHardening, ...hardening };
    receiver.requestListener = hardenSlackRequestListener(receiver.requestListener, this.hardening);
    this.registerListeners();
  }

  async start(): Promise<Server> {
    this.handler.start();
    try {
      const serverOptions: ServerOptions = {
        connectionsCheckingInterval: Math.min(1_000, this.hardening.requestTimeoutMs),
        headersTimeout: this.hardening.headersTimeoutMs,
        keepAliveTimeout: this.hardening.keepAliveTimeoutMs,
        maxHeaderSize: this.hardening.maxHeaderBytes,
        requestTimeout: this.hardening.requestTimeoutMs,
      };
      const server = await this.receiver.start({ host: this.host, port: this.port }, serverOptions);
      server.maxConnections = this.hardening.maxConnections;
      server.maxRequestsPerSocket = this.hardening.maxRequestsPerSocket;
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
