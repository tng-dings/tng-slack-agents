import type { RunnerConfig } from "../src/config.js";

export function testConfig(root: string): RunnerConfig {
  return {
    slack: {
      enabled: false,
      allowedUserIds: ["U_ALLOWED"],
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
    },
    storage: {
      databasePath: `${root}/runner.db`,
      auditLogPath: `${root}/audit.jsonl`,
      worktreeRoot: `${root}/worktrees`,
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
