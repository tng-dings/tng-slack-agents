import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunnerDatabase } from "./database.js";

const tokenPatterns = [
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /(?:api[_-]?key|authorization|password)\s*[=:]\s*[^\s,;]+/gi,
];

function redactString(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of tokenPatterns) result = result.replace(pattern, "[REDACTED]");
  return result;
}

function redact(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|authorization|secret|api[_-]?key/i.test(key) ||
        /^(?:token|access[_-]?token|refresh[_-]?token|slackBotToken|slackAppToken)$/i.test(key)
          ? "[REDACTED]"
          : redact(item, secrets),
      ]),
    );
  }
  return value;
}

export interface AuditContext {
  jobId?: string;
  userId?: string;
  sessionKey?: string;
}

export class AuditLogger {
  private writeChain = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly database: RunnerDatabase,
    private readonly secrets: string[] = [],
  ) {}

  log(eventType: string, payload: unknown, context: AuditContext = {}): Promise<void> {
    const event = {
      createdAt: new Date().toISOString(),
      eventType,
      ...context,
      payload: redact(payload, this.secrets),
    };
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await appendFile(this.filename, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.database.insertAudit(event);
    });
    return this.writeChain;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
