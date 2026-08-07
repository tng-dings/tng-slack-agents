import { IntegrationAuthorizationPolicy, type RunnerConfig } from "../src/config.js";

export function testConfig(root: string): RunnerConfig {
  return {
    integrations: {
      slack: { allowedTenants: ["T1"], allowedActors: ["U_ALLOWED"] },
    },
    slack: {
      enabled: false,
      ingress: "socket",
      allowedWorkspaceIds: ["T1"],
      allowedUserIds: ["U_ALLOWED"],
      liveUpdates: false,
      nativeStreaming: false,
      http: {
        host: "127.0.0.1",
        port: 3000,
        eventsPath: "/slack/events",
        healthPath: "/healthz",
        maxBodyBytes: 256 * 1024,
        maxHeaderBytes: 16 * 1024,
        requestTimeoutMs: 5_000,
        headersTimeoutMs: 5_000,
        keepAliveTimeoutMs: 5_000,
        maxRequestsPerSocket: 100,
        maxConnections: 100,
      },
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

export function testAuthorizationPolicy(config: RunnerConfig): IntegrationAuthorizationPolicy {
  return new IntegrationAuthorizationPolicy(config.integrations);
}
