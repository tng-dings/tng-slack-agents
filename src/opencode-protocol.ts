import { OpenCodeError } from "./errors.js";
import type { Usage } from "./types.js";

export type JsonObject = Record<string, unknown>;

export interface OpenCodeSession {
  id: string;
  projectID: string;
  directory: string;
  title: string;
  version: string;
  time: { created: number; updated: number };
}

export interface OpenCodePart extends JsonObject {
  type: string;
  text?: string;
}

export interface OpenCodeMessage {
  info: JsonObject;
  parts: OpenCodePart[];
  usage: Usage;
}

export type OpenCodeSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number };

export type OpenCodeEvent =
  | { kind: "text"; sessionId: string; delta: string }
  | { kind: "tool"; sessionId: string; part: OpenCodePart }
  | { kind: "usage"; sessionId: string; usage: Usage }
  | { kind: "permission"; sessionId: string; permissionId: string }
  | { kind: "error"; sessionId?: string }
  | { kind: "ignored"; eventType: string }
  | { kind: "unknown"; eventType: string };

function mismatch(schema: string, path: string, expectation: string): never {
  throw new OpenCodeError(
    `OpenCode ${schema} schema mismatch at ${path}: expected ${expectation}`,
    "OPENCODE_SCHEMA_MISMATCH",
  );
}

function object(value: unknown, schema: string, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return mismatch(schema, path, "an object");
  return value as JsonObject;
}

function string(value: unknown, schema: string, path: string): string {
  if (typeof value !== "string" || !value) return mismatch(schema, path, "a non-empty string");
  return value;
}

function text(value: unknown, schema: string, path: string): string {
  if (typeof value !== "string") return mismatch(schema, path, "a string");
  return value;
}

function finite(value: unknown, schema: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return mismatch(schema, path, "a finite number");
  return value;
}

function integer(value: unknown, schema: string, path: string): number {
  const result = finite(value, schema, path);
  if (!Number.isSafeInteger(result)) return mismatch(schema, path, "a safe integer");
  return result;
}

function usage(value: unknown, schema: string, path: string): Usage {
  const info = object(value, schema, path);
  const tokens = object(info.tokens, schema, `${path}.tokens`);
  return {
    cost: finite(info.cost, schema, `${path}.cost`),
    inputTokens: finite(tokens.input, schema, `${path}.tokens.input`),
    outputTokens: finite(tokens.output, schema, `${path}.tokens.output`),
  };
}

function hasProviderError(value: unknown, schema: string, path: string): boolean {
  if (value === undefined) return false;
  const error = object(value, schema, path);
  string(error.name, schema, `${path}.name`);
  return true;
}

export function parseHealth(value: unknown): { healthy: true; version: string } {
  const schema = "health response";
  const result = object(value, schema, "$");
  if (result.healthy !== true) mismatch(schema, "$.healthy", "true");
  return { healthy: true, version: string(result.version, schema, "$.version") };
}

export function parseSession(value: unknown, schema = "session response"): OpenCodeSession {
  const result = object(value, schema, "$");
  const time = object(result.time, schema, "$.time");
  return {
    id: string(result.id, schema, "$.id"),
    projectID: string(result.projectID, schema, "$.projectID"),
    directory: string(result.directory, schema, "$.directory"),
    title: string(result.title, schema, "$.title"),
    version: string(result.version, schema, "$.version"),
    time: {
      created: finite(time.created, schema, "$.time.created"),
      updated: finite(time.updated, schema, "$.time.updated"),
    },
  };
}

export function parseSessionList(value: unknown): OpenCodeSession[] {
  const schema = "session list response";
  if (!Array.isArray(value)) mismatch(schema, "$", "an array");
  return value.map((item, index) => parseSession(item, `${schema}[${index}]`));
}

export function parseBoolean(value: unknown, schema: string): boolean {
  if (typeof value !== "boolean") mismatch(schema, "$", "a boolean");
  return value;
}

function part(value: unknown, schema: string, path: string): OpenCodePart {
  const result = object(value, schema, path);
  const type = string(result.type, schema, `${path}.type`);
  // OpenCode publishes a text part with an empty string when streaming starts,
  // before later message.part.updated events append deltas.
  if (type === "text") text(result.text, schema, `${path}.text`);
  if (type === "tool") {
    string(result.tool, schema, `${path}.tool`);
    string(result.callID, schema, `${path}.callID`);
    const state = object(result.state, schema, `${path}.state`);
    const status = string(state.status, schema, `${path}.state.status`);
    if (!["pending", "running", "completed", "error"].includes(status)) {
      mismatch(schema, `${path}.state.status`, "pending, running, completed, or error");
    }
  }
  return result as OpenCodePart;
}

export function parseMessage(value: unknown): OpenCodeMessage {
  const schema = "message response";
  const result = object(value, schema, "$");
  if (!Array.isArray(result.parts)) mismatch(schema, "$.parts", "an array");
  const info = object(result.info, schema, "$.info");
  if (hasProviderError(info.error, schema, "$.info.error")) {
    throw new OpenCodeError("OpenCode assistant message reported an error", "OPENCODE_PROVIDER_ERROR");
  }
  return {
    info,
    parts: result.parts.map((item, index) => part(item, schema, `$.parts[${index}]`)),
    usage: usage(info, schema, "$.info"),
  };
}

export function parseStatusMap(value: unknown): Record<string, OpenCodeSessionStatus> {
  const schema = "session status response";
  const result = object(value, schema, "$");
  return Object.fromEntries(Object.entries(result).map(([sessionId, raw]) => {
    const status = object(raw, schema, `$.${sessionId}`);
    const type = string(status.type, schema, `$.${sessionId}.type`);
    if (type === "idle" || type === "busy") return [sessionId, { type }];
    if (type === "retry") {
      return [sessionId, {
        type,
        attempt: integer(status.attempt, schema, `$.${sessionId}.attempt`),
        message: string(status.message, schema, `$.${sessionId}.message`),
        next: finite(status.next, schema, `$.${sessionId}.next`),
      }];
    }
    return mismatch(schema, `$.${sessionId}.type`, "idle, busy, or retry");
  }));
}

const ignoredEventTypes = new Set([
  "server.connected",
  "installation.updated",
  "installation.update-available",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.compacted",
  "session.diff",
  "message.removed",
  "message.part.removed",
  "permission.replied",
  "file.edited",
  "file.watcher.updated",
  "todo.updated",
  "command.executed",
  "vcs.branch.updated",
  "lsp.client.diagnostics",
]);

export function parseEvent(value: unknown): OpenCodeEvent {
  const schema = "event";
  const event = object(value, schema, "$");
  const eventType = string(event.type, schema, "$.type");
  if (ignoredEventTypes.has(eventType)) return { kind: "ignored", eventType };
  if (!["message.part.updated", "message.updated", "permission.updated", "session.error"].includes(eventType)) {
    return { kind: "unknown", eventType };
  }
  const properties = object(event.properties, schema, "$.properties");
  if (eventType === "session.error") {
    hasProviderError(properties.error, schema, "$.properties.error");
    return {
      kind: "error",
      ...(properties.sessionID === undefined
        ? {}
        : { sessionId: string(properties.sessionID, schema, "$.properties.sessionID") }),
    };
  }
  if (eventType === "message.part.updated") {
    const parsedPart = part(properties.part, schema, "$.properties.part");
    const sessionId = string(parsedPart.sessionID, schema, "$.properties.part.sessionID");
    if (parsedPart.type === "text") {
      if (properties.delta === undefined) return { kind: "ignored", eventType };
      return { kind: "text", sessionId, delta: text(properties.delta, schema, "$.properties.delta") };
    }
    if (parsedPart.type === "tool") return { kind: "tool", sessionId, part: parsedPart };
    return { kind: "ignored", eventType };
  }
  if (eventType === "message.updated") {
    const info = object(properties.info, schema, "$.properties.info");
    const sessionId = string(info.sessionID, schema, "$.properties.info.sessionID");
    const role = string(info.role, schema, "$.properties.info.role");
    if (role !== "assistant") return { kind: "ignored", eventType };
    if (hasProviderError(info.error, schema, "$.properties.info.error")) return { kind: "error", sessionId };
    return { kind: "usage", sessionId, usage: usage(info, schema, "$.properties.info") };
  }
  const permission = properties.permission === undefined
    ? properties
    : object(properties.permission, schema, "$.properties.permission");
  return {
    kind: "permission",
    sessionId: string(permission.sessionID, schema, "$.properties.sessionID"),
    permissionId: string(permission.id, schema, "$.properties.id"),
  };
}

export function describePayloadShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { valueType: "array", itemCount: value.length };
  if (value && typeof value === "object") {
    return { valueType: "object", keys: Object.keys(value as JsonObject).sort().slice(0, 32) };
  }
  return { valueType: value === null ? "null" : typeof value };
}
