import { IntegrationAuthorizationPolicy, type OpenCodeRunnerConfig, type RunnerConfig } from "../src/config.js";
import type { RunnerDatabase } from "../src/database.js";
import type { Executor, JobRecord } from "../src/types.js";

export interface TestConfigDocument {
  [key: string]: unknown;
  executor?: unknown;
  slack: Record<string, unknown> & { http?: Record<string, unknown> };
  discord: Record<string, unknown> & { http?: Record<string, unknown> };
  openCode: Record<string, unknown>;
  claudeCode?: Record<string, unknown>;
  storage: Record<string, unknown>;
  limits?: Record<string, unknown>;
  queue?: Record<string, unknown>;
}

/** Minimal on-disk configuration input for parser tests, before defaults are applied. */
export function testConfigDocument(
  root: string,
  overrides: Partial<TestConfigDocument> = {},
): TestConfigDocument {
  const slack = {
    enabled: false,
    allowedWorkspaceIds: [],
    allowedUserIds: [],
    ...overrides.slack,
  };
  const openCode = {
    baseUrl: "http://127.0.0.1:4096",
    workingRepository: root,
    approvedVersions: ["test"],
    ...overrides.openCode,
  };
  const storage = {
    databasePath: "runner.db",
    auditLogPath: "audit.jsonl",
    worktreeRoot: "worktrees",
    ...overrides.storage,
  };
  const discord = { ...overrides.discord };
  return {
    executor: "opencode",
    ...overrides,
    slack,
    discord,
    openCode,
    storage,
  };
}

export function testConfig(root: string): OpenCodeRunnerConfig {
  return {
    executor: "opencode",
    workingRepository: root,
    integrations: {
      slack: { allowedTenants: ["T1"], allowedActors: ["U_ALLOWED"] },
    },
    discord: {
      enabled: false,
      ingress: "gateway",
      commandName: "agent",
      allowedGuildIds: [],
      allowedUserIds: [],
      maxOutputCharacters: 20_000,
      http: {
        host: "127.0.0.1",
        port: 3001,
        interactionsPath: "/discord/interactions",
        healthPath: "/healthz",
        maxBodyBytes: 256 * 1024,
        maxHeaderBytes: 16 * 1024,
        requestTimeoutMs: 2_500,
        headersTimeoutMs: 2_500,
        keepAliveTimeoutMs: 5_000,
        maxRequestsPerSocket: 100,
        maxConnections: 100,
      },
    },
    slack: {
      enabled: false,
      ingress: "socket",
      allowedWorkspaceIds: ["T1"],
      allowedUserIds: ["U_ALLOWED"],
      liveUpdates: false,
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
      approvedVersions: ["test"],
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

export function testJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const integration = overrides.integration ?? "slack";
  return {
    id: "test-job",
    integration,
    sourceEventId: "test-event",
    sessionKey: `${integration}:T1:D1:1.0`,
    tenantId: "T1",
    conversationId: "D1",
    threadId: "1.0",
    deliveryMessageId: null,
    actorId: "U_ALLOWED",
    prompt: "test prompt",
    attachments: [],
    status: "queued",
    output: "",
    error: null,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * Puts a session into the state the runner leaves behind once a provider turn
 * has started, using the same persist-workspace-then-provider-session order.
 */
export function persistSessionExecution(
  database: RunnerDatabase,
  sessionKey: string,
  providerId: string,
  providerSessionId: string,
  workingDirectory: string,
): void {
  database.updateSessionWorkingDirectory(sessionKey, workingDirectory);
  database.updateSessionProviderSession(sessionKey, providerId, providerSessionId);
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

export function testExecutor(
  workingDirectory: string,
  executeTurn: Executor["executeTurn"],
  providerSessionId = "test-provider-session",
): Executor {
  return {
    prepareSession: async (_job, session, callbacks) => {
      const directory = session.workingDirectory ?? workingDirectory;
      await callbacks.onWorkingDirectory(directory);
      return {
        providerId: session.providerId,
        providerSessionId: session.providerSessionId ?? providerSessionId,
        workingDirectory: directory,
      };
    },
    executeTurn,
  };
}
