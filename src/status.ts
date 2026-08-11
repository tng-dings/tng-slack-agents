import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { JobStatus } from "./types.js";

const jobStatuses: JobStatus[] = ["queued", "running", "succeeded", "failed", "timed_out", "rejected"];
const maxSessionReferences = 20;

export interface RunnerStatusSnapshot {
  state: "idle" | "queued" | "active" | "blocked";
  ready: boolean;
  jobs: Record<JobStatus, number>;
  reconciliation: {
    blockedSessionCount: number;
    sessionReferences: string[];
    referencesTruncated: boolean;
  };
}

function sessionReference(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

export function readRunnerStatus(databasePath: string): RunnerStatusSnapshot {
  const sqlite = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const jobs = Object.fromEntries(jobStatuses.map((status) => [status, 0])) as Record<JobStatus, number>;
    const jobRows = sqlite.prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status").all() as Array<{
      status: string;
      count: number;
    }>;
    for (const row of jobRows) {
      if (jobStatuses.includes(row.status as JobStatus)) jobs[row.status as JobStatus] = Number(row.count);
    }
    const blockedSessionCount = Number((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM sessions WHERE reconciliation_required = 1
    `).get() as { count: number }).count);
    const blockedRows = sqlite.prepare(`
      SELECT session_key FROM sessions WHERE reconciliation_required = 1 ORDER BY session_key LIMIT ?
    `).all(maxSessionReferences) as Array<{ session_key: string }>;
    const sessionReferences = blockedRows.map((row) => sessionReference(String(row.session_key)));
    const state = blockedSessionCount > 0
      ? "blocked"
      : jobs.running > 0
        ? "active"
        : jobs.queued > 0
          ? "queued"
          : "idle";
    return {
      state,
      ready: state !== "blocked",
      jobs,
      reconciliation: {
        blockedSessionCount,
        sessionReferences,
        referencesTruncated: blockedSessionCount > sessionReferences.length,
      },
    };
  } finally {
    sqlite.close();
  }
}
