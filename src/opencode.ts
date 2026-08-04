import path from "node:path";
import type { AuditLogger } from "./audit.js";
import type { RunnerConfig } from "./config.js";
import type { Executor, ExecutionCallbacks, ExecutionResult, JobRecord, SessionRecord, Usage } from "./types.js";
import type { WorkspaceManager } from "./workspace.js";
import { OpenCodeError } from "./errors.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromInfo(info: unknown): Usage {
  if (!isObject(info)) return { cost: 0, inputTokens: 0, outputTokens: 0 };
  const tokens = isObject(info.tokens) ? info.tokens : {};
  return {
    cost: number(info.cost),
    inputTokens: number(tokens.input),
    outputTokens: number(tokens.output),
  };
}

function outputFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part): part is JsonObject => isObject(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function sessionIdForEvent(event: JsonObject): string | undefined {
  const properties = isObject(event.properties) ? event.properties : {};
  const part = isObject(properties.part) ? properties.part : {};
  const info = isObject(properties.info) ? properties.info : {};
  const permission = isObject(properties.permission) ? properties.permission : properties;
  for (const candidate of [properties.sessionID, part.sessionID, info.sessionID, permission.sessionID]) {
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function errorMessage(value: unknown): string {
  if (isObject(value) && typeof value.message === "string") return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value).slice(0, 2_000);
}

export class OpenCodeExecutor implements Executor {
  private readonly authorization: string;

  constructor(
    private readonly config: RunnerConfig["openCode"],
    password: string,
    private readonly workspaces: WorkspaceManager,
    private readonly audit: AuditLogger,
  ) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${password}`, "utf8").toString("base64")}`;
  }

  async health(signal = AbortSignal.timeout(5_000)): Promise<{ healthy: boolean; version?: string }> {
    return this.request("/global/health", { signal }) as Promise<{ healthy: boolean; version?: string }>;
  }

  async execute(
    job: JobRecord,
    session: SessionRecord,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const workingDirectory = await this.workspaces.prepare(session.sessionKey, session.workingDirectory);
    const openCodeSessionId = await this.ensureSession(session.openCodeSessionId, workingDirectory, job.prompt, signal);
    const abortSession = () => {
      void this.abort(openCodeSessionId, workingDirectory);
    };
    signal.addEventListener("abort", abortSession, { once: true });
    const eventController = new AbortController();
    const abortEvents = () => eventController.abort(signal.reason);
    signal.addEventListener("abort", abortEvents, { once: true });
    const eventSubscription = await this.subscribe(openCodeSessionId, workingDirectory, callbacks, eventController);

    try {
      const body: JsonObject = {
        parts: [{ type: "text", text: job.prompt }],
      };
      if (this.config.model) body.model = this.config.model;
      const response = await this.request(
        `/session/${encodeURIComponent(openCodeSessionId)}/message`,
        { method: "POST", body: JSON.stringify(body), signal },
        workingDirectory,
      );
      if (!isObject(response)) throw new OpenCodeError("OpenCode returned an invalid message response");
      const output = outputFromParts(response.parts);
      const usage = usageFromInfo(response.info);
      await callbacks.onUsage(usage);
      if (Array.isArray(response.parts)) {
        for (const part of response.parts) {
          if (isObject(part) && part.type === "tool") await callbacks.onTool(part);
        }
      }
      return { output, usage, openCodeSessionId, workingDirectory };
    } finally {
      eventController.abort();
      signal.removeEventListener("abort", abortEvents);
      signal.removeEventListener("abort", abortSession);
      await eventSubscription.done.catch((error: unknown) => {
        if (!eventController.signal.aborted) throw error;
      });
    }
  }

  async abort(openCodeSessionId: string, workingDirectory: string): Promise<void> {
    await this.request(
      `/session/${encodeURIComponent(openCodeSessionId)}/abort`,
      { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) },
      workingDirectory,
    ).catch(() => undefined);
  }

  private async ensureSession(
    existingId: string | null,
    workingDirectory: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (existingId) {
      try {
        await this.request(`/session/${encodeURIComponent(existingId)}`, { signal }, workingDirectory);
        return existingId;
      } catch (error) {
        if (!(error instanceof OpenCodeError) || error.code !== "OPENCODE_NOT_FOUND") throw error;
      }
    }
    const title = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Slack coding task";
    const response = await this.request(
      "/session",
      { method: "POST", body: JSON.stringify({ title }), signal },
      workingDirectory,
    );
    if (!isObject(response) || typeof response.id !== "string") {
      throw new OpenCodeError("OpenCode did not return a session ID");
    }
    return response.id;
  }

  private async subscribe(
    openCodeSessionId: string,
    workingDirectory: string,
    callbacks: ExecutionCallbacks,
    controller: AbortController,
  ): Promise<{ done: Promise<void> }> {
    const response = await fetch(this.url("/event", workingDirectory), {
      headers: this.headers(),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeError(`Unable to subscribe to OpenCode events (${response.status})`);
    }
    const task = this.consumeSse(response.body, async (event) => {
      if (sessionIdForEvent(event) !== openCodeSessionId) return;
      const properties = isObject(event.properties) ? event.properties : {};
      if (event.type === "message.part.updated") {
        const part = isObject(properties.part) ? properties.part : {};
        if (part.type === "text" && typeof properties.delta === "string") {
          await callbacks.onText(properties.delta);
        } else if (part.type === "tool") {
          await callbacks.onTool(part);
        }
      } else if (event.type === "message.updated") {
        await callbacks.onUsage(usageFromInfo(properties.info));
      } else if (event.type === "permission.updated") {
        const permission = isObject(properties.permission) ? properties.permission : properties;
        if (typeof permission.id === "string") {
          await this.audit.log("opencode_permission_rejected", permission);
          await this.request(
            `/session/${encodeURIComponent(openCodeSessionId)}/permissions/${encodeURIComponent(permission.id)}`,
            { method: "POST", body: JSON.stringify({ response: "reject", remember: false }), signal: controller.signal },
            workingDirectory,
          );
        }
      }
    }, controller.signal);
    return { done: task };
  }

  private async consumeSse(
    stream: ReadableStream<Uint8Array>,
    onEvent: (event: JsonObject) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            try {
              const parsed: unknown = JSON.parse(data);
              if (isObject(parsed)) await onEvent(parsed);
            } catch (error) {
              await this.audit.log("opencode_event_parse_failed", { data: data.slice(0, 1_000), error: errorMessage(error) });
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async request(endpoint: string, init: RequestInit, workingDirectory?: string): Promise<unknown> {
    const response = await fetch(this.url(endpoint, workingDirectory), {
      ...init,
      headers: this.headers(init.headers),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2_000);
      throw new OpenCodeError(
        `OpenCode request ${endpoint} failed (${response.status}): ${detail}`,
        response.status === 404 ? "OPENCODE_NOT_FOUND" : "OPENCODE_HTTP_ERROR",
      );
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }

  private url(endpoint: string, workingDirectory?: string): string {
    const url = new URL(`${this.config.baseUrl}${endpoint}`);
    if (workingDirectory) url.searchParams.set("directory", path.resolve(workingDirectory));
    return url.toString();
  }

  private headers(additional?: HeadersInit): Headers {
    const headers = new Headers(additional);
    headers.set("authorization", this.authorization);
    headers.set("content-type", "application/json");
    return headers;
  }
}
