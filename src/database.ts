import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { JobRecord, JobStatus, JobSubmission, SessionRecord, Usage } from "./types.js";

type Row = Record<string, unknown>;

function now(): string {
  return new Date().toISOString();
}

function mapJob(row: Row): JobRecord {
  return {
    id: String(row.id),
    sourceEventId: String(row.source_event_id),
    sessionKey: String(row.session_key),
    workspaceId: String(row.workspace_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    replyTs: row.reply_ts === null ? null : String(row.reply_ts),
    userId: String(row.user_id),
    prompt: String(row.prompt),
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
    workspaceId: String(row.workspace_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
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
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        reply_ts TEXT,
        user_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
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

  ensureSession(submission: Pick<JobSubmission, "workspaceId" | "channelId" | "threadTs">): SessionRecord {
    const sessionKey = `${submission.workspaceId}:${submission.channelId}:${submission.threadTs}`;
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT INTO sessions(session_key, workspace_id, channel_id, thread_ts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET updated_at = excluded.updated_at
    `).run(sessionKey, submission.workspaceId, submission.channelId, submission.threadTs, timestamp, timestamp);
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

  insertJob(id: string, submission: JobSubmission, status: JobStatus = "queued", error: string | null = null): JobRecord {
    const session = this.ensureSession(submission);
    const timestamp = now();
    this.sqlite.prepare(`
      INSERT INTO jobs(
        id, source_event_id, session_key, workspace_id, channel_id, thread_ts, reply_ts,
        user_id, prompt, status, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      submission.sourceEventId,
      session.sessionKey,
      submission.workspaceId,
      submission.channelId,
      submission.threadTs,
      submission.replyTs ?? null,
      submission.userId,
      submission.prompt,
      status,
      error,
      timestamp,
    );
    return this.getJob(id)!;
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  getJobBySourceEvent(sourceEventId: string): JobRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE source_event_id = ?").get(sourceEventId) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  countJobs(userId: string, status: JobStatus): number {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM jobs WHERE user_id = ? AND status = ?").get(userId, status) as Row;
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

  completeJob(id: string, status: Extract<JobStatus, "succeeded" | "failed" | "timed_out">, output: string, error: string | null, usage: Usage): void {
    this.transaction(() => {
      this.sqlite.prepare(`
        UPDATE jobs SET status = ?, output = ?, error = ?, cost = ?, input_tokens = ?, output_tokens = ?, finished_at = ?
        WHERE id = ?
      `).run(status, output, error, usage.cost, usage.inputTokens, usage.outputTokens, now(), id);
      if (usage.cost || usage.inputTokens || usage.outputTokens) {
        const job = this.getJob(id)!;
        this.sqlite.prepare(`
          INSERT INTO daily_usage(usage_date, user_id, cost, input_tokens, output_tokens)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(usage_date, user_id) DO UPDATE SET
            cost = cost + excluded.cost,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens
        `).run(this.usageDate(), job.userId, usage.cost, usage.inputTokens, usage.outputTokens);
      }
    });
  }

  dailyUsage(userId: string): Usage {
    const row = this.sqlite.prepare(`
      SELECT cost, input_tokens, output_tokens FROM daily_usage WHERE usage_date = ? AND user_id = ?
    `).get(this.usageDate(), userId) as Row | undefined;
    return row
      ? { cost: Number(row.cost), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) }
      : { cost: 0, inputTokens: 0, outputTokens: 0 };
  }

  recoverInterruptedJobs(): JobRecord[] {
    const rows = this.sqlite.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as Row[];
    if (rows.length) {
      this.sqlite.prepare(`
        UPDATE jobs SET status = 'failed', error = 'Runner restarted while this job was executing', finished_at = ?
        WHERE status = 'running'
      `).run(now());
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
