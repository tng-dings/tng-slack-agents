import { createHash } from "node:crypto";
import { redactString } from "../audit.js";
import type { JobRecord, JobReporter } from "../types.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/tng-dings/tng-slack-agents, 0.1.0)";
const DISCORD_MESSAGE_CHARACTERS = 1_900;
const SUPPRESS_EMBEDS = 1 << 2;
const MAX_RATE_LIMIT_RETRIES = 5;

class DiscordApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`Discord API request failed with status ${status}`);
    this.name = "DiscordApiRequestError";
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function routeKey(method: string, pathname: string): string {
  const normalized = pathname
    .replace(/(\/channels\/[^/]+\/messages)\/[^/]+$/, "$1/:message")
    .replace(/^\/interactions\/[^/]+\/[^/]+\/callback$/, "/interactions/:id/:token/callback");
  return `${method}:${normalized}`;
}

function secondsToMilliseconds(value: unknown): number | undefined {
  const seconds = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.max(1, Math.ceil(seconds * 1_000));
}

export interface DiscordMessage {
  readonly id: string;
}

export interface DiscordThread {
  readonly id: string;
}

export interface DiscordApi {
  createMessage(channelId: string, content: string, nonce: string): Promise<DiscordMessage>;
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
}

export interface DiscordSessionApi extends DiscordApi {
  createThreadFromMessage(channelId: string, messageId: string, name: string): Promise<DiscordThread>;
  getThread(threadId: string): Promise<DiscordThread | undefined>;
  replyToInteraction(interactionId: string, interactionToken: string, content: string, ephemeral: boolean): Promise<void>;
}

export class DiscordApiClient implements DiscordSessionApi {
  private requestQueue: Promise<void> = Promise.resolve();
  private globalAvailableAt = 0;
  private readonly routeBuckets = new Map<string, string>();
  private readonly bucketAvailableAt = new Map<string, number>();
  private readonly routeAvailableAt = new Map<string, number>();

  constructor(
    private readonly botToken: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  async createMessage(channelId: string, content: string, nonce: string): Promise<DiscordMessage> {
    const result = await this.request("POST", `/channels/${encodeURIComponent(channelId)}/messages`, {
      content,
      nonce,
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
      flags: SUPPRESS_EMBEDS,
    });
    if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).id !== "string") {
      throw new Error("Discord create-message response did not contain a message ID");
    }
    return { id: (result as Record<string, unknown>).id as string };
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
    await this.request(
      "PATCH",
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      { content, allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS },
    );
  }

  async createThreadFromMessage(channelId: string, messageId: string, name: string): Promise<DiscordThread> {
    const result = await this.request(
      "POST",
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`,
      { name, auto_archive_duration: 1_440 },
    );
    if (!result || typeof result !== "object" || typeof (result as Record<string, unknown>).id !== "string") {
      throw new Error("Discord create-thread response did not contain a thread ID");
    }
    return { id: (result as Record<string, unknown>).id as string };
  }

  async getThread(threadId: string): Promise<DiscordThread | undefined> {
    try {
      const result = await this.request("GET", `/channels/${encodeURIComponent(threadId)}`);
      if (!result || typeof result !== "object" || (result as Record<string, unknown>).id !== threadId) return undefined;
      return { id: threadId };
    } catch (error) {
      if (error instanceof DiscordApiRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  async replyToInteraction(
    interactionId: string,
    interactionToken: string,
    content: string,
    ephemeral: boolean,
  ): Promise<void> {
    await this.request(
      "POST",
      `/interactions/${encodeURIComponent(interactionId)}/${encodeURIComponent(interactionToken)}/callback`,
      {
        type: 4,
        data: {
          content,
          ...(ephemeral ? { flags: 64 } : {}),
          allowed_mentions: { parse: [] },
        },
      },
    );
  }

  request(method: string, pathname: string, body?: unknown): Promise<unknown> {
    const operation = this.requestQueue.then(
      () => this.requestWithRateLimits(method, pathname, body),
      () => this.requestWithRateLimits(method, pathname, body),
    );
    this.requestQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async requestWithRateLimits(method: string, pathname: string, body?: unknown): Promise<unknown> {
    const key = routeKey(method, pathname);
    for (let retry = 0; ; retry += 1) {
      await this.waitUntilAvailable(key);
      const response = await this.fetcher(`${DISCORD_API_BASE_URL}${pathname}`, {
        method,
        headers: {
          authorization: `Bot ${this.botToken}`,
          "content-type": "application/json",
          "user-agent": DISCORD_USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const bucket = response.headers.get("x-ratelimit-bucket");
      if (bucket) this.routeBuckets.set(key, bucket);

      if (response.status === 429) {
        const details = await response.json().catch(() => undefined) as { retry_after?: unknown; global?: unknown } | undefined;
        const retryAfterMs = secondsToMilliseconds(response.headers.get("retry-after"))
          ?? secondsToMilliseconds(details?.retry_after);
        if (retryAfterMs === undefined) {
          throw new Error("Discord API rate limit could not be satisfied");
        }
        const availableAt = Date.now() + retryAfterMs;
        if (response.headers.get("x-ratelimit-global") === "true" || details?.global === true) {
          this.globalAvailableAt = Math.max(this.globalAvailableAt, availableAt);
        } else {
          this.setRouteAvailableAt(key, bucket, availableAt);
        }
        if (retry >= MAX_RATE_LIMIT_RETRIES) {
          throw new Error("Discord API rate limit could not be satisfied");
        }
        continue;
      }

      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      const resetAfterMs = secondsToMilliseconds(response.headers.get("x-ratelimit-reset-after"));
      if (remaining === 0 && resetAfterMs !== undefined) {
        this.setRouteAvailableAt(key, bucket, Date.now() + resetAfterMs);
      }
      if (!response.ok) throw new DiscordApiRequestError(response.status);
      if (response.status === 204) return undefined;
      return await response.json();
    }
  }

  private async waitUntilAvailable(key: string): Promise<void> {
    const bucket = this.routeBuckets.get(key);
    const availableAt = Math.max(
      this.globalAvailableAt,
      bucket ? this.bucketAvailableAt.get(bucket) ?? 0 : this.routeAvailableAt.get(key) ?? 0,
    );
    const waitMs = availableAt - Date.now();
    if (waitMs > 0) await delay(waitMs);
  }

  private setRouteAvailableAt(key: string, bucket: string | null, availableAt: number): void {
    if (bucket) {
      this.bucketAvailableAt.set(bucket, Math.max(this.bucketAvailableAt.get(bucket) ?? 0, availableAt));
    } else {
      this.routeAvailableAt.set(key, Math.max(this.routeAvailableAt.get(key) ?? 0, availableAt));
    }
  }
}

function nonce(jobId: string, part: number): string {
  return createHash("sha256").update(`${jobId}:${part}`).digest("hex").slice(0, 25);
}

function safeSlice(value: string, start: number, end: number): string {
  let boundedEnd = Math.min(end, value.length);
  if (boundedEnd < value.length && boundedEnd > start) {
    const previous = value.charCodeAt(boundedEnd - 1);
    if (previous >= 0xD800 && previous <= 0xDBFF) boundedEnd -= 1;
  }
  return value.slice(start, boundedEnd);
}

export function discordMessageChunks(output: string, secrets: readonly string[], maximum: number): string[] {
  const redacted = redactString(output, [...secrets]);
  const marker = "\n\n_(Output truncated.)_";
  const bounded = redacted.length <= maximum
    ? redacted
    : `${safeSlice(redacted, 0, Math.max(0, maximum - marker.length))}${marker}`.slice(0, maximum);
  const value = bounded || "Completed with no text response.";
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    const chunk = safeSlice(value, offset, offset + DISCORD_MESSAGE_CHARACTERS);
    chunks.push(chunk);
    offset += chunk.length;
  }
  return chunks;
}

/** Bot-backed delivery that is independent of interaction-token lifetime. */
export class DiscordJobReporter implements JobReporter {
  private deliveryMessageId: string | null;

  constructor(
    private readonly api: DiscordApi,
    private readonly job: JobRecord,
    private readonly maxOutputCharacters: number,
    private readonly secrets: readonly string[] = [],
  ) {
    this.deliveryMessageId = job.deliveryMessageId;
  }

  async start(): Promise<{ deliveryMessageId?: string } | void> {
    if (this.deliveryMessageId) return;
    const message = await this.api.createMessage(this.job.conversationId, "Working…", nonce(this.job.id, 0));
    this.deliveryMessageId = message.id;
    return { deliveryMessageId: message.id };
  }

  append(_delta: string): void {}

  async succeed(output: string): Promise<void> {
    const chunks = discordMessageChunks(output, this.secrets, this.maxOutputCharacters);
    await this.replaceOrCreate(chunks[0]!, 0);
    for (let index = 1; index < chunks.length; index += 1) {
      await this.api.createMessage(this.job.conversationId, chunks[index]!, nonce(this.job.id, index));
    }
  }

  async fail(message: string): Promise<void> {
    const [content] = discordMessageChunks(`Agent job failed: ${message}`, this.secrets, DISCORD_MESSAGE_CHARACTERS);
    await this.replaceOrCreate(content!, 0);
  }

  private async replaceOrCreate(content: string, part: number): Promise<void> {
    if (this.deliveryMessageId) {
      await this.api.editMessage(this.job.conversationId, this.deliveryMessageId, content);
      return;
    }
    const created = await this.api.createMessage(this.job.conversationId, content, nonce(this.job.id, part));
    this.deliveryMessageId = created.id;
    // enforce_nonce can return a message created by an earlier request whose
    // response was lost. Always edit the returned ID so it cannot remain stuck
    // with the earlier "Working…" content.
    await this.api.editMessage(this.job.conversationId, created.id, content);
  }
}
