import { RunnerError } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function errorType(value: unknown): string {
  return value instanceof Error ? value.name || "Error" : typeof value;
}

export function errorMetadata(value: unknown): { errorType: string; errorCode?: string } {
  return value instanceof RunnerError
    ? { errorType: errorType(value), errorCode: value.code }
    : { errorType: errorType(value) };
}
