import { createHash } from "node:crypto";
import path from "node:path";
import type { AuditLogger } from "./audit.js";
import type { OpenCodeConfig } from "./config.js";
import type {
  ExecutionCallbacks,
  ExecutionResult,
  JobRecord,
  PreparedExecutionSession,
  Executor,
  SessionPreparationCallbacks,
  SessionRecord,
} from "./types.js";
import type { WorkspaceManager } from "./workspace.js";
import { OpenCodeError } from "./errors.js";
import {
  describePayloadShape,
  parseBoolean,
  parseEvent,
  parseHealth,
  parseMessage,
  parseSession,
  parseSessionList,
  parseStatusMap,
  type JsonObject,
  type OpenCodePart,
} from "./opencode-protocol.js";
import { assertApprovedOpenCodeVersion } from "./opencode-version.js";
import { errorMetadata, isRecord } from "./values.js";

function outputFromParts(parts: OpenCodePart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value).slice(0, 2_000);
}

export class OpenCodeExecutor implements Executor {
  private readonly authorization: string;

  constructor(
    private readonly config: OpenCodeConfig,
    password: string,
    private readonly workspaces: WorkspaceManager,
    private readonly audit: AuditLogger,
    private readonly maxResponseCharacters = 250_000,
  ) {
    this.authorization = `Basic ${Buffer.from(`${config.username}:${password}`, "utf8").toString("base64")}`;
  }

  async health(signal = AbortSignal.timeout(5_000)): Promise<{ healthy: true; version: string }> {
    const response = await this.request("/global/health", { signal });
    const health = await this.validate("health response", response, parseHealth);
    try {
      assertApprovedOpenCodeVersion(health.version, this.config.approvedVersions);
    } catch (error) {
      await this.audit.log("opencode_version_rejected", {
        version: health.version,
        approvedVersions: this.config.approvedVersions,
      });
      throw error;
    }
    return health;
  }

  async prepareSession(
    job: JobRecord,
    session: SessionRecord,
    callbacks: SessionPreparationCallbacks,
    signal: AbortSignal,
  ): Promise<PreparedExecutionSession> {
    const workingDirectory = await this.workspaces.prepare(session.sessionKey, session.workingDirectory);
    await callbacks.onWorkingDirectory(workingDirectory);
    const providerSessionId = await this.ensureSession(session, workingDirectory, job.prompt, signal);
    return { providerId: "opencode", providerSessionId, workingDirectory };
  }

  async executeTurn(
    job: JobRecord,
    session: PreparedExecutionSession,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const { providerSessionId, workingDirectory } = session;
    let abortRequest: Promise<void> | undefined;
    const abortSession = () => {
      abortRequest = this.abort(providerSessionId, workingDirectory).catch(async (error: unknown) => {
        await this.audit.log(
          "opencode_abort_failed",
          { ...errorMetadata(error), sessionId: providerSessionId },
        ).catch((auditError: unknown) => console.error("Unable to record OpenCode abort failure", errorMetadata(auditError)));
      });
    };
    signal.addEventListener("abort", abortSession, { once: true });
    if (signal.aborted) abortSession();
    const eventController = new AbortController();
    const eventFailureController = new AbortController();
    const abortEvents = () => eventController.abort(signal.reason);
    signal.addEventListener("abort", abortEvents, { once: true });
    if (signal.aborted) abortEvents();
    let eventSubscription: { done: Promise<void>; failure(): unknown } | undefined;

    try {
      eventSubscription = await this.subscribe(
        providerSessionId,
        workingDirectory,
        callbacks,
        eventController,
        eventFailureController,
      );
      const parts: JsonObject[] = [{ type: "text", text: job.prompt }];
      for (const attachment of job.attachments) {
        parts.push({ type: "file", mime: attachment.mime, filename: attachment.filename, url: attachment.dataUrl });
      }
      const body: JsonObject = { parts };
      if (this.config.model) body.model = this.config.model;
      const response = await this.request(
        `/session/${encodeURIComponent(providerSessionId)}/message`,
        { method: "POST", body: JSON.stringify(body), signal: AbortSignal.any([signal, eventFailureController.signal]) },
        workingDirectory,
      );
      const message = await this.validate("message response", response, parseMessage);
      const output = outputFromParts(message.parts);
      const usage = message.usage;
      await callbacks.onUsage(usage);
      for (const part of message.parts) {
        if (part.type === "tool") await callbacks.onTool(part);
      }
      return { output, usage };
    } finally {
      eventController.abort();
      signal.removeEventListener("abort", abortEvents);
      signal.removeEventListener("abort", abortSession);
      await eventSubscription?.done.catch(() => undefined);
      await abortRequest;
      const eventFailure = eventSubscription?.failure();
      if (eventFailure) throw eventFailure;
    }
  }

  async abort(providerSessionId: string, workingDirectory: string): Promise<void> {
    const response = await this.request(
      `/session/${encodeURIComponent(providerSessionId)}/abort`,
      { method: "POST", body: "{}", signal: AbortSignal.timeout(5_000) },
      workingDirectory,
    );
    await this.validate("abort response", response, (value) => parseBoolean(value, "abort response"));
  }

  async reconcileSession(session: SessionRecord, signal: AbortSignal): Promise<void> {
    if (session.providerId !== "opencode") throw new OpenCodeError(`Cannot reconcile provider ${session.providerId}`);
    if (!session.providerSessionId || !session.workingDirectory) return;
    const sessionId = session.providerSessionId;
    try {
      const abortResponse = await this.request(
        `/session/${encodeURIComponent(sessionId)}/abort`,
        { method: "POST", body: "{}", signal },
        session.workingDirectory,
      );
      await this.validate("abort response", abortResponse, (value) => parseBoolean(value, "abort response"));
    } catch (error) {
      if (error instanceof OpenCodeError && error.code === "OPENCODE_NOT_FOUND") return;
      throw error;
    }
    while (!signal.aborted) {
      const response = await this.request("/session/status", { signal }, session.workingDirectory);
      const statuses = await this.validate("session status response", response, parseStatusMap);
      const status = statuses[sessionId];
      if (status === undefined || status.type === "idle") return;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const timeout = setTimeout(finish, 100);
        const onAbort = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason ?? new Error("OpenCode reconciliation was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        else timeout.unref();
      });
    }
    throw signal.reason ?? new Error("OpenCode reconciliation was aborted");
  }

  async cleanup(session: SessionRecord): Promise<void> {
    if (session.providerId !== "opencode") throw new OpenCodeError(`Cannot clean up provider ${session.providerId}`);
    if (!session.workingDirectory) return;
    if (session.providerSessionId) {
      try {
        const response = await this.request(
          `/session/${encodeURIComponent(session.providerSessionId)}`,
          { method: "DELETE", signal: AbortSignal.timeout(5_000) },
          session.workingDirectory,
        );
        await this.validate("delete session response", response, (value) => parseBoolean(value, "delete session response"));
      } catch (error) {
        if (!(error instanceof OpenCodeError) || error.code !== "OPENCODE_NOT_FOUND") throw error;
      }
    }
    await this.workspaces.cleanup(session.workingDirectory);
  }

  private async ensureSession(
    session: SessionRecord,
    workingDirectory: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (session.providerId !== "opencode") throw new OpenCodeError(`Cannot prepare provider ${session.providerId}`);
    const existingId = session.providerSessionId;
    if (existingId) {
      try {
        const response = await this.request(`/session/${encodeURIComponent(existingId)}`, { signal }, workingDirectory);
        await this.validate("session response", response, parseSession);
        return existingId;
      } catch (error) {
        if (!(error instanceof OpenCodeError) || error.code !== "OPENCODE_NOT_FOUND") throw error;
      }
    }
    const marker = createHash("sha256")
      .update(`${session.sessionKey}:${session.executionGeneration}`)
      .digest("hex")
      .slice(0, 24);
    const titlePrefix = `[agent-runner:${marker}]`;
    const sessionResponse = await this.request("/session", { signal }, workingDirectory);
    const sessions = await this.validate("session list response", sessionResponse, parseSessionList);
    const matching = sessions
      .filter((value) => {
        if (!value.title.startsWith(titlePrefix)) return false;
        const candidate = path.resolve(value.directory);
        const expected = path.resolve(workingDirectory);
        return process.platform === "win32" ? candidate.toLowerCase() === expected.toLowerCase() : candidate === expected;
      })
      .sort((left, right) => {
        return right.time.created - left.time.created;
      });
    if (matching.length > 0) return String(matching[0]!.id);

    const promptTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 80) || "Coding task";
    const title = `${titlePrefix} ${promptTitle}`;
    const response = await this.request(
      "/session",
      { method: "POST", body: JSON.stringify({ title }), signal },
      workingDirectory,
    );
    return (await this.validate("create session response", response, (value) => parseSession(value, "create session response"))).id;
  }

  private async subscribe(
    providerSessionId: string,
    workingDirectory: string,
    callbacks: ExecutionCallbacks,
    controller: AbortController,
    failureController: AbortController,
  ): Promise<{ done: Promise<void>; failure(): unknown }> {
    const response = await fetch(this.url("/event", workingDirectory), {
      headers: this.headers(),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new OpenCodeError(`Unable to subscribe to OpenCode events (${response.status})`);
    }
    let failure: unknown;
    const task = this.consumeSse(response.body, async (rawEvent) => {
      const eventType = typeof rawEvent.type === "string" ? rawEvent.type : undefined;
      const event = await this.validate("event", rawEvent, parseEvent, eventType ? { eventType } : {});
      if (event.kind === "unknown") {
        await this.audit.log("opencode_unknown_event", { eventType: event.eventType });
        return;
      }
      if (event.kind === "ignored") return;
      if (event.kind === "error") {
        if (event.sessionId && event.sessionId !== providerSessionId) return;
        await this.audit.log("opencode_session_error", {
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        });
        throw new OpenCodeError("OpenCode session reported an error", "OPENCODE_PROVIDER_ERROR");
      }
      if (event.sessionId !== providerSessionId) return;
      if (event.kind === "text") await callbacks.onText(event.delta);
      if (event.kind === "tool") await callbacks.onTool(event.part);
      if (event.kind === "usage") await callbacks.onUsage(event.usage);
      if (event.kind === "permission") {
        await this.audit.log("opencode_permission_rejected", {
          permissionId: event.permissionId,
          sessionId: providerSessionId,
        });
        const permissionResponse = await this.request(
          `/session/${encodeURIComponent(providerSessionId)}/permissions/${encodeURIComponent(event.permissionId)}`,
          { method: "POST", body: JSON.stringify({ response: "reject", remember: false }), signal: controller.signal },
          workingDirectory,
        );
        await this.validate(
          "permission response",
          permissionResponse,
          (value) => parseBoolean(value, "permission response"),
        );
      }
    }, controller.signal).catch((error: unknown) => {
      failure = error;
      failureController.abort(error);
      throw error;
    });
    return { done: task, failure: () => failure };
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
        if (done) {
          if (!signal.aborted) throw new OpenCodeError("OpenCode event stream ended unexpectedly", "OPENCODE_EVENT_STREAM_ENDED");
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        if (buffer.length > this.maxResponseCharacters) {
          throw new OpenCodeError("OpenCode event exceeded the configured response limit", "OPENCODE_RESPONSE_LIMIT");
        }
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
            let parsed: unknown;
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              await this.audit.log("opencode_event_parse_failed", { dataCharacters: data.length, error: errorMessage(error) });
              boundary = buffer.indexOf("\n\n");
              continue;
            }
            if (!isRecord(parsed)) {
              await this.audit.log("opencode_schema_mismatch", {
                schema: "event",
                ...describePayloadShape(parsed),
              });
              throw new OpenCodeError("OpenCode event schema mismatch at $: expected an object", "OPENCODE_SCHEMA_MISMATCH");
            }
            await onEvent(parsed);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      // Releasing a reader does not cancel a still-open SSE response. OpenCode
      // deliberately keeps /event open, so leaving the body uncancelled keeps
      // its TCP socket (and a short-lived CLI process) alive after a turn.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async validate<T>(
    schema: string,
    value: unknown,
    parser: (value: unknown) => T,
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof OpenCodeError && error.code === "OPENCODE_SCHEMA_MISMATCH") {
        await this.audit.log("opencode_schema_mismatch", {
          schema,
          ...metadata,
          ...describePayloadShape(value),
        });
      }
      throw error;
    }
  }

  private async request(endpoint: string, init: RequestInit, workingDirectory?: string): Promise<unknown> {
    const response = await fetch(this.url(endpoint, workingDirectory), {
      ...init,
      headers: this.headers(init.headers),
      redirect: "error",
    });
    if (!response.ok) {
      await this.readResponseText(response, 2_000);
      throw new OpenCodeError(
        `OpenCode request ${endpoint} failed (${response.status})`,
        response.status === 404 ? "OPENCODE_NOT_FOUND" : "OPENCODE_HTTP_ERROR",
      );
    }
    if (response.status === 204) return undefined;
    const text = await this.readResponseText(response, this.maxResponseCharacters);
    return text ? JSON.parse(text) : undefined;
  }

  private async readResponseText(response: Response, maxCharacters: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
        if (result.length > maxCharacters) {
          await reader.cancel();
          throw new OpenCodeError("OpenCode response exceeded the configured limit", "OPENCODE_RESPONSE_LIMIT");
        }
      }
      result += decoder.decode();
      return result;
    } finally {
      reader.releaseLock();
    }
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
