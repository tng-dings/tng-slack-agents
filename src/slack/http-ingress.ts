import type { IncomingMessage, RequestListener, Server, ServerOptions } from "node:http";
import { LogLevel, type App, type HTTPReceiver, type Logger } from "@slack/bolt";
import type { RunnerConfig } from "../config.js";
import {
  RateLimitedHttpLogger,
  readBoundedBody,
  sendEmptyResponse,
  sendJsonResponse,
  type HttpSecurityLogSink,
} from "../http.js";
import type { SlackEventHandler } from "./socket-ingress.js";

interface DurableSlackEventHandler extends SlackEventHandler {
  start(): void;
  stop(): Promise<void>;
}

export type SlackHttpHardeningOptions = RunnerConfig["slack"]["http"];

/** Content-free, bounded logging for attacker-controlled HTTP failures. */
export class SlackHttpSecurityLogger implements Logger {
  private level = LogLevel.WARN;
  private readonly logger: RateLimitedHttpLogger;

  constructor(
    sink: HttpSecurityLogSink = console,
    maxPerMinute = 10,
    now: () => number = Date.now,
  ) {
    this.logger = new RateLimitedHttpLogger("Slack", sink, maxPerMinute, now);
  }

  debug(..._messages: unknown[]): void {}
  info(..._messages: unknown[]): void {}

  warn(...messages: unknown[]): void {
    const first = typeof messages[0] === "string" ? messages[0] : "";
    if (first.startsWith("Malformed request body")) {
      this.logger.warn("malformed", "Slack HTTP request rejected as malformed.");
    } else if (first.includes("parse and verify") || first.includes("authenticity")) {
      this.logger.warn("authenticity", "Slack HTTP request rejected during authenticity validation.");
    } else {
      this.logger.warn("receiver-warning", "Slack HTTP receiver warning.");
    }
  }

  error(..._messages: unknown[]): void {
    this.logger.error("receiver-error", "Slack HTTP receiver error.");
  }

  setLevel(level: LogLevel): void { this.level = level; }
  getLevel(): LogLevel { return this.level; }
  setName(_name: string): void {}
}

interface BufferedIncomingMessage extends IncomingMessage {
  rawBody: Buffer;
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
        sendEmptyResponse(response, 400, { connection: "close" });
        return;
      }

      const exactPath = url.search === "";
      if (exactPath && url.pathname === options.healthPath) {
        if (request.method !== "GET") {
          sendEmptyResponse(response, 405, { allow: "GET", connection: "close" });
          return;
        }
        sendJsonResponse(response, 200, { status: "ok" });
        return;
      }
      if (!exactPath || url.pathname !== options.eventsPath) {
        sendEmptyResponse(response, 404, { connection: "close" });
        return;
      }
      if (request.method !== "POST") {
        sendEmptyResponse(response, 405, { allow: "POST", connection: "close" });
        return;
      }

      const contentLengthHeader = request.headers["content-length"];
      if (Array.isArray(contentLengthHeader)) {
        sendEmptyResponse(response, 400, { connection: "close" });
        return;
      }
      if (contentLengthHeader !== undefined) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          sendEmptyResponse(response, 400, { connection: "close" });
          return;
        }
        if (contentLength > options.maxBodyBytes) {
          request.resume();
          sendEmptyResponse(response, 413, { connection: "close" });
          return;
        }
      }

      try {
        const rawBody = await readBoundedBody(request, options.maxBodyBytes);
        if (!rawBody) {
          sendEmptyResponse(response, 413, { connection: "close" });
          return;
        }
        (request as BufferedIncomingMessage).rawBody = rawBody;
        boltListener(request, response);
      } catch {
        if (!response.headersSent) sendEmptyResponse(response, 400, { connection: "close" });
      }
    })();
  };
}

/** Slack Events API lifecycle and listener wiring only. */
export class SlackHttpIngress {
  private started = false;

  constructor(
    readonly app: App,
    readonly receiver: HTTPReceiver,
    private readonly handler: DurableSlackEventHandler,
    private readonly http: SlackHttpHardeningOptions,
  ) {
    receiver.requestListener = hardenSlackRequestListener(receiver.requestListener, http);
    this.registerListeners();
  }

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
      const server = await this.receiver.start({ host: this.http.host, port: this.http.port }, serverOptions);
      server.maxConnections = this.http.maxConnections;
      server.maxRequestsPerSocket = this.http.maxRequestsPerSocket;
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
