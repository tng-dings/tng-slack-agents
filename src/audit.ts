import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunnerDatabase } from "./database.js";

const tokenPatterns = [
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /xapp-[A-Za-z0-9-]+/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?:api[_-]?key|authorization|password)\s*[=:]\s*[^\s,;]+/gi,
];

export function redactString(value: string, secrets: string[] = []): string {
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of tokenPatterns) result = result.replace(pattern, "[REDACTED]");
  return result;
}

export function redactValue(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|authorization|secret|api[_-]?key/i.test(key) ||
        /^(?:token|access[_-]?token|refresh[_-]?token|slackBotToken|slackAppToken)$/i.test(key)
          ? "[REDACTED]"
          : redactValue(item, secrets),
      ]),
    );
  }
  return value;
}

function boundPayload(payload: unknown, maxCharacters: number): unknown {
  const serialized = JSON.stringify(payload);
  if (serialized.length <= maxCharacters) return payload;
  return {
    truncated: true,
    originalCharacters: serialized.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
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
    private readonly maxEventCharacters = 32_000,
  ) {}

  log(eventType: string, payload: unknown, context: AuditContext = {}): Promise<void> {
    const event = {
      createdAt: new Date().toISOString(),
      eventType,
      ...context,
      payload: boundPayload(redactValue(payload, this.secrets), this.maxEventCharacters),
    };
    return this.enqueue(async () => {
      await mkdir(path.dirname(this.filename), { recursive: true });
      await appendFile(this.filename, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
      this.database.insertAudit(event);
    });
  }

  prune(retentionDays: number): Promise<void> {
    return this.enqueue(async () => {
      let text: string;
      try {
        text = await readFile(this.filename, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const cutoff = Date.now() - retentionDays * 86_400_000;
      const retained = text.split(/\r?\n/).filter((line) => {
        if (!line) return false;
        try {
          const parsed = JSON.parse(line) as { createdAt?: unknown };
          return typeof parsed.createdAt === "string" && Date.parse(parsed.createdAt) >= cutoff;
        } catch {
          return false;
        }
      });
      const temporary = `${this.filename}.prune-${process.pid}`;
      await writeFile(temporary, retained.length ? `${retained.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filename);
    });
  }

  flush(): Promise<void> {
    return this.writeChain;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeChain.catch(() => undefined).then(operation);
    this.writeChain = next;
    return next;
  }
}
