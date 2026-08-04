import { readFile } from "node:fs/promises";
import path from "node:path";

export interface RunnerConfig {
  slack: {
    enabled: boolean;
    allowedUserIds: string[];
    nativeStreaming: boolean;
  };
  openCode: {
    baseUrl: string;
    username: string;
    workingRepository: string;
    model?: { providerID: string; modelID: string };
  };
  limits: {
    maxConcurrentJobsPerUser: number;
    maxConcurrentJobsGlobal: number;
    maxQueuedJobsPerUser: number;
    jobTimeoutSeconds: number;
    dailyCostCap: number;
  };
  storage: {
    databasePath: string;
    auditLogPath: string;
    worktreeRoot: string;
  };
  queue: { pollIntervalMs: number };
}

export interface RunnerSecrets {
  slackBotToken?: string;
  slackAppToken?: string;
  openCodePassword: string;
}

const defaults = {
  nativeStreaming: true,
  maxConcurrentJobsPerUser: 1,
  maxConcurrentJobsGlobal: 1,
  maxQueuedJobsPerUser: 3,
  jobTimeoutSeconds: 1_800,
  dailyCostCap: 5,
  pollIntervalMs: 250,
} as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function positiveNumber(value: unknown, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return result;
}

function resolvePath(value: unknown, name: string, baseDirectory: string): string {
  const raw = string(value, name).replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? `%${key}%`);
  return path.resolve(baseDirectory, raw);
}

export async function loadConfig(configPath = process.env.AGENT_RUNNER_CONFIG ?? "config.json"): Promise<RunnerConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const root = object(JSON.parse(await readFile(absoluteConfigPath, "utf8")), "config");
  const slack = object(root.slack, "slack");
  const openCode = object(root.openCode, "openCode");
  const limits = object(root.limits ?? {}, "limits");
  const storage = object(root.storage, "storage");
  const queue = object(root.queue ?? {}, "queue");
  const baseDirectory = path.dirname(absoluteConfigPath);
  const enabled = slack.enabled !== false;
  const allowedUserIds = slack.allowedUserIds;
  if (!Array.isArray(allowedUserIds) || allowedUserIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("slack.allowedUserIds must be an array of Slack user IDs");
  }
  if (enabled && allowedUserIds.length === 0) throw new Error("slack.allowedUserIds must not be empty when Slack is enabled");

  let model: RunnerConfig["openCode"]["model"];
  if (openCode.model !== undefined) {
    const rawModel = object(openCode.model, "openCode.model");
    model = {
      providerID: string(rawModel.providerID, "openCode.model.providerID"),
      modelID: string(rawModel.modelID, "openCode.model.modelID"),
    };
  }

  return {
    slack: {
      enabled,
      allowedUserIds: [...allowedUserIds] as string[],
      nativeStreaming: slack.nativeStreaming !== false,
    },
    openCode: {
      baseUrl: new URL(string(openCode.baseUrl, "openCode.baseUrl")).toString().replace(/\/$/, ""),
      username: typeof openCode.username === "string" ? openCode.username : "opencode",
      workingRepository: resolvePath(openCode.workingRepository, "openCode.workingRepository", baseDirectory),
      ...(model ? { model } : {}),
    },
    limits: {
      maxConcurrentJobsPerUser: positiveNumber(limits.maxConcurrentJobsPerUser, defaults.maxConcurrentJobsPerUser, "limits.maxConcurrentJobsPerUser"),
      maxConcurrentJobsGlobal: positiveNumber(limits.maxConcurrentJobsGlobal, defaults.maxConcurrentJobsGlobal, "limits.maxConcurrentJobsGlobal"),
      maxQueuedJobsPerUser: positiveNumber(limits.maxQueuedJobsPerUser, defaults.maxQueuedJobsPerUser, "limits.maxQueuedJobsPerUser"),
      jobTimeoutSeconds: positiveNumber(limits.jobTimeoutSeconds, defaults.jobTimeoutSeconds, "limits.jobTimeoutSeconds"),
      dailyCostCap: positiveNumber(limits.dailyCostCap, defaults.dailyCostCap, "limits.dailyCostCap"),
    },
    storage: {
      databasePath: resolvePath(storage.databasePath, "storage.databasePath", baseDirectory),
      auditLogPath: resolvePath(storage.auditLogPath, "storage.auditLogPath", baseDirectory),
      worktreeRoot: resolvePath(storage.worktreeRoot, "storage.worktreeRoot", baseDirectory),
    },
    queue: {
      pollIntervalMs: positiveNumber(queue.pollIntervalMs, defaults.pollIntervalMs, "queue.pollIntervalMs"),
    },
  };
}

export function loadSecrets(config: RunnerConfig): RunnerSecrets {
  const openCodePassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (!openCodePassword) throw new Error("OPENCODE_SERVER_PASSWORD is required");
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  if (config.slack.enabled && (!slackBotToken || !slackAppToken)) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required when Slack is enabled");
  }
  return {
    openCodePassword,
    ...(slackBotToken ? { slackBotToken } : {}),
    ...(slackAppToken ? { slackAppToken } : {}),
  };
}
