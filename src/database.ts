import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Attachment, IntegrationId, JobRecord, JobStatus, JobSubmission, SessionRecord, Usage } from "./types.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function parseAttachments(value: unknown): Attachment[] {
  if (!value || typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is Attachment =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).mime === "string" &&
        typeof (item as Record<string, unknown>).filename === "string" &&
        typeof (item as Record<string, unknown>).dataUrl === "string",
    );
  } catch {
    return [];
  }
}

function mapJob(row: Row): JobRecord {
  const integration = String(row.integration) as IntegrationId;
  const sourceEventKey = String(row.source_event_id);
  return {
    id: String(row.id),
    integration,
    sourceEventId: sourceEventKey.startsWith(`${integration}:`) ? sourceEventKey.slice(integration.length + 1) : sourceEventKey,
    sessionKey: String(row.session_key),
    tenantId: String(row.tenant_id),
    conversationId: String(row.conversation_id),
    threadId: String(row.thread_id),
    replyTs: row.reply_ts === null ? null : String(row.reply_ts),
    actorId: String(row.actor_id),
    prompt: String(row.prompt),
    attachments: parseAttachments(row.attachments),
    status: String(row.status) as JobStatus,
    output: String(row.output ?? ""),
    error: row.error === null ? null : String(row.error),
    cost: Number(row.cost),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
  };
}

function mapSession(row: Row): SessionRecord {
  return {
    sessionKey: String(row.session_key),
    integration: String(row.integration) as IntegrationId,
    tenantId: String(row.tenant_id),
    conversationId: String(row.conversation_id),
    threadId: String(row.thread_id),
    openCodeSessionId: row.opencode_session_id === null ? null : String(row.opencode_session_id),
    workingDirectory: row.working_directory === null ? null : String(row.working_directory),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class RunnerDatabase {
  readonly sqlite: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        integration TEXT NOT NULL DEFAULT 'slack',
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        opencode_session_id TEXT,
        working_directory TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_event_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL REFERENCES sessions(session_key),
        integration TEXT NOT NULL DEFAULT 'slack',
        tenant_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        reply_ts TEXT,
        user_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        attachments TEXT,
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','timed_out','rejected')),
        output TEXT NOT NULL DEFAULT '',
        error TEXT,
        cost REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_user_status_idx ON jobs(user_id, status);
      CREATE INDEX IF NOT EXISTS jobs_session_status_idx ON jobs(session_key, status);

      CREATE TABLE IF NOT EXISTS daily_usage (
        usage_date TEXT NOT NULL,
        user_id TEXT NOT NULL,
        cost REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (usage_date, user_id)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        job_id TEXT,
        user_id TEXT,
        session_key TEXT,
        payload_json TEXT NOT NULL
      );
    `);

    const jobColumns = this.sqlite.prepare("PRAGMA table_info(jobs)").all() as Row[];
    if (!jobColumns.some((col) => String(col.name) === "attachments")) {
      this.sqlite.exec("ALTER TABLE jobs ADD COLUMN attachments TEXT");
    }

    // Existing databases predate integration-aware identities. Keep the legacy
    // columns for an additive upgrade, while making normalized columns and keys
    // authoritative for all new reads and writes.
    if (!jobColumns.some((col) => String(col.name) === "integration")) {
      this.sqlite.exec(`
        ALTER TABLE sessions ADD COLUMN integration TEXT NOT NULL DEFAULT 'slack';
        ALTER TABLE sessions ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions ADD COLUMN conversation_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN integration TEXT NOT NULL DEFAULT 'slack';
        ALTER TABLE jobs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN conversation_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE jobs ADD COLUMN actor_id TEXT NOT NULL DEFAULT '';
      `);
      this.transaction(() => {
        this.sqlite.exec(`
          PRAGMA defer_foreign_keys = ON;
          UPDATE sessions SET
            tenant_id = workspace_id,
            conversation_id = channel_id,
            thread_id = thread_ts,
            session_key = 'slack:' || session_key;
          UPDATE jobs SET
            source_event_id = 'slack:' || source_event_id,
            session_key = 'slack:' || session_key,
            tenant_id = workspace_id,
            conversation_id = channel_id,
            thread_id = thread_ts,
            actor_id = user_id;
        `);
      });
    }
    this.sqlite.exec("CREATE INDEX IF NOT EXISTS jobs_actor_status_idx ON jobs(actor_id, status)");
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  ensureSession(submission: Pick<JobSubmission, "integration" | "tenantId" | "conversationId" | "threadId">): SessionRecord {
    const sessionKey = `${submission.integration}:${submission.tenantId}:${submission.conversationId}:${submission.threadId}`;
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT INTO sessions(
        session_key, integration, tenant_id, conversation_id, thread_id,
        workspace_id, channel_id, thread_ts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at
    `).run(
      sessionKey,
      submission.integration,
      submission.tenantId,
      submission.conversationId,
      submission.threadId,
      submission.tenantId,
      submission.conversationId,
      submission.threadId,
      timestamp,
      timestamp,
    );
    return this.getSession(sessionKey)!;
  }

  getSession(sessionKey: string): SessionRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey) as Row | undefined;
    return row ? mapSession(row) : undefined;
  }

  updateSessionExecution(sessionKey: string, openCodeSessionId: string, workingDirectory: string): void {
    this.sqlite.prepare(`
      UPDATE sessions SET opencode_session_id = ?, working_directory = ?, updated_at = ? WHERE session_key = ?
    `).run(openCodeSessionId, workingDirectory, now(), sessionKey);
  }

  updateJobReplyTs(id: string, replyTs: string): void {
    this.sqlite.prepare("UPDATE jobs SET reply_ts = ? WHERE id = ?").run(replyTs, id);
  }

  insertJob(id: string, submission: JobSubmission, status: JobStatus = "queued", error: string | null = null): JobRecord {
    return this.transaction(() => {
      const session = this.ensureSession(submission);
      const timestamp = now();
      const attachments = submission.attachments ?? [];
      this.sqlite.prepare(`
        INSERT INTO jobs(
          id, source_event_id, session_key, integration, tenant_id, conversation_id, thread_id, actor_id,
          workspace_id, channel_id, thread_ts, reply_ts, user_id, prompt, attachments, status, error, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        `${submission.integration}:${submission.sourceEventId}`,
        session.sessionKey,
        submission.integration,
        submission.tenantId,
        submission.conversationId,
        submission.threadId,
        submission.actorId,
        submission.tenantId,
        submission.conversationId,
        submission.threadId,
        submission.replyTs ?? null,
        submission.actorId,
        submission.prompt,
        attachments.length > 0 ? (JSON.stringify(attachments) as SQLInputValue) : null,
        status,
        error,
        timestamp,
      );
      return this.getJob(id)!;
    });
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  getJobBySourceEvent(integration: IntegrationId, sourceEventId: string): JobRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE source_event_id = ?").get(`${integration}:${sourceEventId}`) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  countJobs(actorId: string, status: JobStatus): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE actor_id = ? AND status = ?").get(actorId, status) as Row;
    return Number(row.count);
  }

  countRunning(): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get() as Row;
    return Number(row.count);
  }

  claimNextJob(maxPerUser: number, maxGlobal: number): JobRecord | undefined {
    return this.transaction(() => {
      if (this.countRunning() >= maxGlobal) return undefined;
      const row = this.sqlite.prepare(`
        SELECT j.* FROM jobs j
        WHERE j.status = 'queued'
          AND (SELECT COUNT(*) FROM jobs r WHERE r.status = 'running' AND r.user_id = j.user_id) < ?
          AND NOT EXISTS (
            SELECT 1 FROM jobs r WHERE r.status = 'running' AND r.session_key = j.session_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM jobs earlier
            WHERE earlier.status = 'queued' AND earlier.session_key = j.session_key
              AND (earlier.created_at < j.created_at OR (earlier.created_at = j.created_at AND earlier.id < j.id))
          )
        ORDER BY j.created_at, j.id
        LIMIT 1
      `).get(maxPerUser) as Row | undefined;
      if (!row) return undefined;
      const startedAt = now();
      const result = this.sqlite.prepare(`
        UPDATE jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'
      `).run(startedAt, String(row.id));
      return result.changes === 1 ? this.getJob(String(row.id)) : undefined;
    });
  }

  appendOutput(id: string, output: string): void {
    this.sqlite.prepare("UPDATE jobs SET output = ? WHERE id = ?").run(output, id);
  }

  completeJob(
    id: string,
    status: Extract<JobStatus, "succeeded" | "failed" | "timed_out">,
    output: string,
    error: string | null,
    usage: Usage,
    retainContent = true,
  ): void {
    this.transaction(() => {
      this.sqlite.prepare(`
        UPDATE jobs SET status = ?, prompt = CASE WHEN ? THEN prompt ELSE '' END,
          attachments = CASE WHEN ? THEN attachments ELSE NULL END,
          output = ?, error = ?,
          cost = ?, input_tokens = ?, output_tokens = ?, finished_at = ?
        WHERE id = ?
      `).run(status, retainContent ? 1 : 0, retainContent ? 1 : 0, retainContent ? output : "", error, usage.cost, usage.inputTokens, usage.outputTokens, now(), id);
      if (usage.cost || usage.inputTokens || usage.outputTokens) {
        const job = this.getJob(id)!;
        this.sqlite.prepare(`
          INSERT INTO daily_usage(usage_date, user_id, cost, input_tokens, output_tokens)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(usage_date, user_id) DO UPDATE SET
            cost = cost + excluded.cost,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens
        `).run(this.usageDate(), job.actorId, usage.cost, usage.inputTokens, usage.outputTokens);
      }
    });
  }

  purgeExpired(retentionDays: number): SessionRecord[] {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return this.transaction(() => {
      this.sqlite.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
      this.sqlite.prepare("DELETE FROM daily_usage WHERE usage_date < ?").run(cutoff.slice(0, 10));
      this.sqlite.prepare("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?").run(cutoff);
      const rows = this.sqlite.prepare(`
        SELECT * FROM sessions WHERE updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.session_key = sessions.session_key)
      `).all(cutoff) as Row[];
      return rows.map(mapSession);
    });
  }

  deleteSession(sessionKey: string): void {
    this.sqlite.prepare(`
      DELETE FROM sessions WHERE session_key = ?
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.session_key = sessions.session_key)
    `).run(sessionKey);
  }

  dailyUsage(userId: string): Usage {
    const row = this.sqlite.prepare(`
      SELECT cost, input_tokens, output_tokens FROM daily_usage WHERE usage_date = ? AND user_id = ?
    `).get(this.usageDate(), userId) as Row | undefined;
    return row
      ? { cost: Number(row.cost), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) }
      : { cost: 0, inputTokens: 0, outputTokens: 0 };
  }

  recoverInterruptedJobs(retainContent = true): JobRecord[] {
    const rows = this.sqlite.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as Row[];
    if (rows.length) {
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'failed', prompt = CASE WHEN ? THEN prompt ELSE '' END,
          attachments = CASE WHEN ? THEN attachments ELSE NULL END,
          output = CASE WHEN ? THEN output ELSE '' END,
          error = 'Runner restarted while this job was executing', finished_at = ?
        WHERE status = 'running'
      `).run(retainContent ? 1 : 0, retainContent ? 1 : 0, retainContent ? 1 : 0, now());
    }
    return rows.map(mapJob);
  }

  insertAudit(event: {
    createdAt: string;
    eventType: string;
    jobId?: string;
    userId?: string;
    sessionKey?: string;
    payload: unknown;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO audit_events(created_at, event_type, job_id, user_id, session_key, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.createdAt,
      event.eventType,
      event.jobId ?? null,
      event.userId ?? null,
      event.sessionKey ?? null,
      JSON.stringify(event.payload) as SQLInputValue,
    );
  }

  private usageDate(): string {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
}
