import type { RunnerConfig } from "../src/config.js";

export function testConfig(root: string): RunnerConfig {
  return {
    slack: {
      enabled: false,
      allowedWorkspaceIds: ["T1"],
      allowedUserIds: ["U_ALLOWED"],
      liveUpdates: false,
      nativeStreaming: false,
    },
    openCode: {
      baseUrl: "http://127.0.0.1:1",
      username: "opencode",
      workingRepository: root,
    },
    limits: {
      maxConcurrentJobsPerUser: 1,
      maxConcurrentJobsGlobal: 1,
      maxQueuedJobsPerUser: 3,
      jobTimeoutSeconds: 2,
      dailyCostCap: 5,
      maxPromptCharacters: 12_000,
      maxOutputCharacters: 100_000,
      maxAuditEventCharacters: 32_000,
      maxToolEventsPerJob: 500,
      maxAttachmentsPerJob: 4,
      maxAttachmentBytes: 5_000_000,
    },
    storage: {
      databasePath: `${root}/runner.db`,
      auditLogPath: `${root}/audit.jsonl`,
      worktreeRoot: `${root}/worktrees`,
      retentionDays: 30,
      retainJobContent: true,
    },
    queue: { pollIntervalMs: 5 },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
