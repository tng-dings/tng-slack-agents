import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpSecurityLogSink {
  warn(message: string): void;
  error(message: string): void;
}

interface LogBucket {
  windowStartedAt: number;
  count: number;
  suppressionLogged: boolean;
}

/** Rate-limits fixed, content-free messages for attacker-controlled failures. */
export class RateLimitedHttpLogger {
  private readonly buckets = new Map<string, LogBucket>();

  constructor(
    private readonly receiverName: string,
    private readonly sink: HttpSecurityLogSink = console,
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
      this.sink[level](`Further ${this.receiverName} HTTP receiver failures suppressed for this minute.`);
    }
  }
}

export function sendEmptyResponse(
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end();
}

export function sendJsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export async function readBoundedBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer | undefined> {
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
      if (total > maximumBytes) {
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
