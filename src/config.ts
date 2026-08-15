import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { AuthorizationDecision, AuthorizationPolicy, IntegrationId, JobSubmission } from "./types.js";

export interface IntegrationAuthorization {
  allowedTenants: string[];
  allowedActors: string[];
}

export type SlackIngressTransport = "socket" | "events-api";
export type DiscordIngressTransport = "gateway" | "http";

export interface DiscordConfig {
  enabled: boolean;
  ingress: DiscordIngressTransport;
  applicationId?: string;
  commandName: string;
  allowedGuildIds: string[];
  allowedUserIds: string[];
  maxOutputCharacters: number;
  http: {
    host: string;
    port: number;
    interactionsPath: string;
    healthPath: string;
    maxBodyBytes: number;
    maxHeaderBytes: number;
    requestTimeoutMs: number;
    headersTimeoutMs: number;
    keepAliveTimeoutMs: number;
    maxRequestsPerSocket: number;
    maxConnections: number;
  };
}

export type ExecutorProvider = "opencode" | "claude-code";

export interface OpenCodeConfig {
  baseUrl: string;
  username: string;
  workingRepository: string;
  approvedVersions: string[];
  model?: { providerID: string; modelID: string };
}

export interface ClaudeCodeConfig {
  workingRepository: string;
  model?: string;
  permissionMode: PermissionMode;
  executablePath?: string;
}

interface RunnerConfigBase {
  integrations: Partial<Record<IntegrationId, IntegrationAuthorization>>;
  discord: DiscordConfig;
  slack: {
    enabled: boolean;
    ingress: SlackIngressTransport;
    appId?: string;
    allowedWorkspaceIds: string[];
    allowedUserIds: string[];
    liveUpdates: boolean;
    nativeStreaming: boolean;
    http: {
      host: string;
      port: number;
      eventsPath: string;
      healthPath: string;
      maxBodyBytes: number;
      maxHeaderBytes: number;
      requestTimeoutMs: number;
      headersTimeoutMs: number;
      keepAliveTimeoutMs: number;
      maxRequestsPerSocket: number;
      maxConnections: number;
    };
  };
  limits: {
    maxConcurrentJobsPerUser: number;
    maxConcurrentJobsGlobal: number;
    maxQueuedJobsPerUser: number;
    jobTimeoutSeconds: number;
    dailyCostCap: number;
    maxPromptCharacters: number;
    maxOutputCharacters: number;
    maxAuditEventCharacters: number;
    maxToolEventsPerJob: number;
    maxAttachmentsPerJob: number;
    maxAttachmentBytes: number;
  };
  storage: {
    databasePath: string;
    auditLogPath: string;
    worktreeRoot: string;
    retentionDays: number;
    retainJobContent: boolean;
  };
  queue: { pollIntervalMs: number };
}

export type OpenCodeRunnerConfig = RunnerConfigBase & {
  executor: "opencode";
  workingRepository: string;
  openCode: OpenCodeConfig;
  claudeCode?: never;
};

export type ClaudeCodeRunnerConfig = RunnerConfigBase & {
  executor: "claude-code";
  workingRepository: string;
  claudeCode: ClaudeCodeConfig;
  openCode?: never;
};

export type RunnerConfig = OpenCodeRunnerConfig | ClaudeCodeRunnerConfig;

export interface RunnerSecrets {
  discordBotToken?: string;
  discordPublicKey?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  openCodePassword: string;
}

const defaults = {
  liveUpdates: false,
  nativeStreaming: false,
  maxConcurrentJobsPerUser: 1,
  maxConcurrentJobsGlobal: 1,
  maxQueuedJobsPerUser: 3,
  jobTimeoutSeconds: 1_800,
  dailyCostCap: 5,
  maxPromptCharacters: 12_000,
  maxOutputCharacters: 100_000,
  maxAuditEventCharacters: 32_000,
  maxToolEventsPerJob: 500,
  maxAttachmentsPerJob: 4,
  maxAttachmentBytes: 5_000_000,
  retentionDays: 30,
  pollIntervalMs: 250,
  slackHttpHost: "127.0.0.1",
  slackHttpPort: 3000,
  slackEventsPath: "/slack/events",
  healthPath: "/healthz",
  slackHttpMaxBodyBytes: 256 * 1024,
  slackHttpMaxHeaderBytes: 16 * 1024,
  slackHttpRequestTimeoutMs: 5_000,
  slackHttpHeadersTimeoutMs: 5_000,
  slackHttpKeepAliveTimeoutMs: 5_000,
  slackHttpMaxRequestsPerSocket: 100,
  slackHttpMaxConnections: 100,
  discordCommandName: "agent",
  discordIngress: "gateway",
  discordMaxOutputCharacters: 20_000,
  discordHttpHost: "127.0.0.1",
  discordHttpPort: 3001,
  discordInteractionsPath: "/discord/interactions",
  discordHttpMaxBodyBytes: 256 * 1024,
  discordHttpMaxHeaderBytes: 16 * 1024,
  discordHttpRequestTimeoutMs: 2_500,
  discordHttpHeadersTimeoutMs: 2_500,
  discordHttpKeepAliveTimeoutMs: 5_000,
  discordHttpMaxRequestsPerSocket: 100,
  discordHttpMaxConnections: 100,
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

function positiveInteger(value: unknown, fallback: number, name: string): number {
  const result = positiveNumber(value, fallback, name);
  if (!Number.isSafeInteger(result)) throw new Error(name + " must be a positive integer");
  return result;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number, name: string): number {
  const result = positiveInteger(value, fallback, name);
  if (result > maximum) throw new Error(`${name} must be at most ${maximum}`);
  return result;
}

function tcpPort(value: unknown, fallback: number, name: string): number {
  const result = positiveInteger(value, fallback, name);
  if (result > 65_535) throw new Error(`${name} must be at most 65535`);
  return result;
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function slackIngress(value: unknown): SlackIngressTransport {
  const result = value ?? "socket";
  if (result !== "socket" && result !== "events-api") {
    throw new Error('slack.ingress must be "socket" or "events-api"');
  }
  return result;
}

function discordIngress(value: unknown): DiscordIngressTransport {
  const result = value ?? defaults.discordIngress;
  if (result !== "gateway" && result !== "http") {
    throw new Error('discord.ingress must be "gateway" or "http"');
  }
  return result;
}

function executorProvider(value: unknown): ExecutorProvider {
  const result = value ?? "opencode";
  if (result !== "opencode" && result !== "claude-code") {
    throw new Error('executor must be "opencode" or "claude-code"');
  }
  return result;
}

function claudePermissionMode(value: unknown): PermissionMode {
  const result = value ?? "bypassPermissions";
  if (!(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as unknown[]).includes(result)) {
    throw new Error("claudeCode.permissionMode is not supported by the Claude Agent SDK");
  }
  return result as PermissionMode;
}

function routePath(value: unknown, fallback: string, name: string): string {
  const result = value ?? fallback;
  if (typeof result !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(result)) {
    throw new Error(`${name} must be an absolute URL path without a query or fragment`);
  }
  return result;
}

function privateHttpHost(value: unknown, fallback: string, name: string): string {
  const result = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (result !== "127.0.0.1") {
    throw new Error(`${name} must be the reviewed loopback IPv4 literal 127.0.0.1`);
  }
  return result;
}

function discordCommandName(value: unknown): string {
  const result = value ?? defaults.discordCommandName;
  if (typeof result !== "string" || !/^[a-z0-9_-]{1,32}$/.test(result)) {
    throw new Error("discord.commandName must contain 1-32 lowercase letters, numbers, hyphens, or underscores");
  }
  return result;
}

function loopbackBaseUrl(value: unknown): string {
  const url = new URL(string(value, "openCode.baseUrl"));
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("openCode.baseUrl must use http://127.0.0.1 or http://[::1]");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("openCode.baseUrl must not contain credentials, a path, query parameters, or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

function resolvePath(value: unknown, name: string, baseDirectory: string): string {
  const raw = string(value, name).replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? `%${key}%`);
  return path.resolve(baseDirectory, raw);
}

export async function loadConfig(configPath = process.env.AGENT_RUNNER_CONFIG ?? "config.json"): Promise<RunnerConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const root = object(JSON.parse(await readFile(absoluteConfigPath, "utf8")), "config");
  const slack = object(root.slack, "slack");
  const slackHttp = object(slack.http ?? {}, "slack.http");
  const discord = object(root.discord ?? {}, "discord");
  const discordHttp = object(discord.http ?? {}, "discord.http");
  const executor = executorProvider(root.executor);
  const openCode = executor === "opencode" ? object(root.openCode, "openCode") : undefined;
  const claudeCode = executor === "claude-code" ? object(root.claudeCode, "claudeCode") : undefined;
  const limits = object(root.limits ?? {}, "limits");
  const storage = object(root.storage, "storage");
  const queue = object(root.queue ?? {}, "queue");
  const baseDirectory = path.dirname(absoluteConfigPath);
  const enabled = slack.enabled !== false;
  const ingress = slackIngress(slack.ingress);
  const appId = typeof slack.appId === "string" && slack.appId.trim() ? slack.appId.trim() : undefined;
  const allowedWorkspaceIds = stringArray(slack.allowedWorkspaceIds ?? [], "slack.allowedWorkspaceIds");
  const allowedUserIds = stringArray(slack.allowedUserIds, "slack.allowedUserIds");
  if (enabled && allowedWorkspaceIds.length === 0) throw new Error("slack.allowedWorkspaceIds must not be empty when Slack is enabled");
  if (enabled && allowedUserIds.length === 0) throw new Error("slack.allowedUserIds must not be empty when Slack is enabled");
  if (enabled && ingress === "events-api" && !appId) {
    throw new Error("slack.appId is required when Slack Events API ingress is enabled");
  }
  if (slack.nativeStreaming === true) throw new Error("slack.nativeStreaming is disabled because streamed output cannot be safely redacted");
  const eventsPath = routePath(slackHttp.eventsPath, defaults.slackEventsPath, "slack.http.eventsPath");
  const healthPath = routePath(slackHttp.healthPath, defaults.healthPath, "slack.http.healthPath");
  if (eventsPath === healthPath) throw new Error("slack.http.eventsPath and slack.http.healthPath must differ");
  const requestTimeoutMs = boundedPositiveInteger(
    slackHttp.requestTimeoutMs,
    defaults.slackHttpRequestTimeoutMs,
    defaults.slackHttpRequestTimeoutMs,
    "slack.http.requestTimeoutMs",
  );
  const headersTimeoutMs = boundedPositiveInteger(
    slackHttp.headersTimeoutMs,
    defaults.slackHttpHeadersTimeoutMs,
    defaults.slackHttpHeadersTimeoutMs,
    "slack.http.headersTimeoutMs",
  );
  if (headersTimeoutMs > requestTimeoutMs) {
    throw new Error("slack.http.headersTimeoutMs must be less than or equal to slack.http.requestTimeoutMs");
  }

  const discordEnabled = discord.enabled === true;
  const discordIngressTransport = discordIngress(discord.ingress);
  const discordApplicationId = typeof discord.applicationId === "string" && discord.applicationId.trim()
    ? discord.applicationId.trim()
    : undefined;
  const discordAllowedGuildIds = stringArray(discord.allowedGuildIds ?? [], "discord.allowedGuildIds");
  const discordAllowedUserIds = stringArray(discord.allowedUserIds ?? [], "discord.allowedUserIds");
  if (discordEnabled && !discordApplicationId) {
    throw new Error("discord.applicationId is required when Discord is enabled");
  }
  if (discordEnabled && discordAllowedGuildIds.length === 0) {
    throw new Error("discord.allowedGuildIds must not be empty when Discord is enabled");
  }
  if (discordEnabled && discordAllowedUserIds.length === 0) {
    throw new Error("discord.allowedUserIds must not be empty when Discord is enabled");
  }
  const interactionsPath = routePath(
    discordHttp.interactionsPath,
    defaults.discordInteractionsPath,
    "discord.http.interactionsPath",
  );
  const discordHealthPath = routePath(discordHttp.healthPath, defaults.healthPath, "discord.http.healthPath");
  if (interactionsPath === discordHealthPath) {
    throw new Error("discord.http.interactionsPath and discord.http.healthPath must differ");
  }
  const discordRequestTimeoutMs = boundedPositiveInteger(
    discordHttp.requestTimeoutMs,
    defaults.discordHttpRequestTimeoutMs,
    defaults.discordHttpRequestTimeoutMs,
    "discord.http.requestTimeoutMs",
  );
  const discordHeadersTimeoutMs = boundedPositiveInteger(
    discordHttp.headersTimeoutMs,
    defaults.discordHttpHeadersTimeoutMs,
    defaults.discordHttpHeadersTimeoutMs,
    "discord.http.headersTimeoutMs",
  );
  if (discordHeadersTimeoutMs > discordRequestTimeoutMs) {
    throw new Error("discord.http.headersTimeoutMs must be less than or equal to discord.http.requestTimeoutMs");
  }
  const discordPort = tcpPort(discordHttp.port, defaults.discordHttpPort, "discord.http.port");
  const slackPort = tcpPort(slackHttp.port, defaults.slackHttpPort, "slack.http.port");
  if (discordEnabled && discordIngressTransport === "http" && enabled && ingress === "events-api" && discordPort === slackPort) {
    throw new Error("discord.http.port must differ from slack.http.port when both HTTPS integrations are enabled");
  }

  let model: OpenCodeConfig["model"];
  if (openCode?.model !== undefined) {
    const rawModel = object(openCode.model, "openCode.model");
    model = {
      providerID: string(rawModel.providerID, "openCode.model.providerID"),
      modelID: string(rawModel.modelID, "openCode.model.modelID"),
    };
  }

  const providerConfig = executor === "opencode" ? {
    executor,
    workingRepository: resolvePath(openCode!.workingRepository, "openCode.workingRepository", baseDirectory),
    openCode: {
      baseUrl: loopbackBaseUrl(openCode!.baseUrl),
      username: typeof openCode!.username === "string" ? openCode!.username : "opencode",
      workingRepository: resolvePath(openCode!.workingRepository, "openCode.workingRepository", baseDirectory),
      approvedVersions: stringArray(openCode!.approvedVersions ?? [], "openCode.approvedVersions"),
      ...(model ? { model } : {}),
    },
  } as const : {
    executor,
    workingRepository: resolvePath(claudeCode!.workingRepository, "claudeCode.workingRepository", baseDirectory),
    claudeCode: {
      workingRepository: resolvePath(claudeCode!.workingRepository, "claudeCode.workingRepository", baseDirectory),
      permissionMode: claudePermissionMode(claudeCode!.permissionMode),
      ...(typeof claudeCode!.model === "string" && claudeCode!.model.trim()
        ? { model: claudeCode!.model.trim() }
        : {}),
      ...(claudeCode!.executablePath !== undefined
        ? { executablePath: resolvePath(claudeCode!.executablePath, "claudeCode.executablePath", baseDirectory) }
        : {}),
    },
  } as const;

  return {
    ...providerConfig,
    integrations: {
      slack: { allowedTenants: allowedWorkspaceIds, allowedActors: allowedUserIds },
      ...(discordEnabled ? {
        discord: { allowedTenants: discordAllowedGuildIds, allowedActors: discordAllowedUserIds },
      } : {}),
    },
    discord: {
      enabled: discordEnabled,
      ingress: discordIngressTransport,
      ...(discordApplicationId ? { applicationId: discordApplicationId } : {}),
      commandName: discordCommandName(discord.commandName),
      allowedGuildIds: discordAllowedGuildIds,
      allowedUserIds: discordAllowedUserIds,
      maxOutputCharacters: positiveInteger(
        discord.maxOutputCharacters,
        defaults.discordMaxOutputCharacters,
        "discord.maxOutputCharacters",
      ),
      http: {
        host: privateHttpHost(discordHttp.host, defaults.discordHttpHost, "discord.http.host"),
        port: discordPort,
        interactionsPath,
        healthPath: discordHealthPath,
        maxBodyBytes: boundedPositiveInteger(discordHttp.maxBodyBytes, defaults.discordHttpMaxBodyBytes, defaults.discordHttpMaxBodyBytes, "discord.http.maxBodyBytes"),
        maxHeaderBytes: boundedPositiveInteger(discordHttp.maxHeaderBytes, defaults.discordHttpMaxHeaderBytes, defaults.discordHttpMaxHeaderBytes, "discord.http.maxHeaderBytes"),
        requestTimeoutMs: discordRequestTimeoutMs,
        headersTimeoutMs: discordHeadersTimeoutMs,
        keepAliveTimeoutMs: boundedPositiveInteger(discordHttp.keepAliveTimeoutMs, defaults.discordHttpKeepAliveTimeoutMs, defaults.discordHttpKeepAliveTimeoutMs, "discord.http.keepAliveTimeoutMs"),
        maxRequestsPerSocket: boundedPositiveInteger(discordHttp.maxRequestsPerSocket, defaults.discordHttpMaxRequestsPerSocket, defaults.discordHttpMaxRequestsPerSocket, "discord.http.maxRequestsPerSocket"),
        maxConnections: boundedPositiveInteger(discordHttp.maxConnections, defaults.discordHttpMaxConnections, defaults.discordHttpMaxConnections, "discord.http.maxConnections"),
      },
    },
    slack: {
      enabled,
      ingress,
      ...(appId ? { appId } : {}),
      allowedWorkspaceIds,
      allowedUserIds,
      liveUpdates: slack.liveUpdates === true,
      nativeStreaming: false,
      http: {
        host: privateHttpHost(slackHttp.host, defaults.slackHttpHost, "slack.http.host"),
        port: slackPort,
        eventsPath,
        healthPath,
        maxBodyBytes: boundedPositiveInteger(slackHttp.maxBodyBytes, defaults.slackHttpMaxBodyBytes, defaults.slackHttpMaxBodyBytes, "slack.http.maxBodyBytes"),
        maxHeaderBytes: boundedPositiveInteger(slackHttp.maxHeaderBytes, defaults.slackHttpMaxHeaderBytes, defaults.slackHttpMaxHeaderBytes, "slack.http.maxHeaderBytes"),
        requestTimeoutMs,
        headersTimeoutMs,
        keepAliveTimeoutMs: boundedPositiveInteger(slackHttp.keepAliveTimeoutMs, defaults.slackHttpKeepAliveTimeoutMs, defaults.slackHttpKeepAliveTimeoutMs, "slack.http.keepAliveTimeoutMs"),
        maxRequestsPerSocket: boundedPositiveInteger(slackHttp.maxRequestsPerSocket, defaults.slackHttpMaxRequestsPerSocket, defaults.slackHttpMaxRequestsPerSocket, "slack.http.maxRequestsPerSocket"),
        maxConnections: boundedPositiveInteger(slackHttp.maxConnections, defaults.slackHttpMaxConnections, defaults.slackHttpMaxConnections, "slack.http.maxConnections"),
      },
    },
    limits: {
      maxConcurrentJobsPerUser: positiveInteger(limits.maxConcurrentJobsPerUser, defaults.maxConcurrentJobsPerUser, "limits.maxConcurrentJobsPerUser"),
      maxConcurrentJobsGlobal: positiveInteger(limits.maxConcurrentJobsGlobal, defaults.maxConcurrentJobsGlobal, "limits.maxConcurrentJobsGlobal"),
      maxQueuedJobsPerUser: positiveInteger(limits.maxQueuedJobsPerUser, defaults.maxQueuedJobsPerUser, "limits.maxQueuedJobsPerUser"),
      jobTimeoutSeconds: positiveInteger(limits.jobTimeoutSeconds, defaults.jobTimeoutSeconds, "limits.jobTimeoutSeconds"),
      dailyCostCap: positiveNumber(limits.dailyCostCap, defaults.dailyCostCap, "limits.dailyCostCap"),
      maxPromptCharacters: positiveInteger(limits.maxPromptCharacters, defaults.maxPromptCharacters, "limits.maxPromptCharacters"),
      maxOutputCharacters: positiveInteger(limits.maxOutputCharacters, defaults.maxOutputCharacters, "limits.maxOutputCharacters"),
      maxAuditEventCharacters: positiveInteger(limits.maxAuditEventCharacters, defaults.maxAuditEventCharacters, "limits.maxAuditEventCharacters"),
      maxToolEventsPerJob: positiveInteger(limits.maxToolEventsPerJob, defaults.maxToolEventsPerJob, "limits.maxToolEventsPerJob"),
      maxAttachmentsPerJob: positiveInteger(limits.maxAttachmentsPerJob, defaults.maxAttachmentsPerJob, "limits.maxAttachmentsPerJob"),
      maxAttachmentBytes: positiveNumber(limits.maxAttachmentBytes, defaults.maxAttachmentBytes, "limits.maxAttachmentBytes"),
    },
    storage: {
      databasePath: resolvePath(storage.databasePath, "storage.databasePath", baseDirectory),
      auditLogPath: resolvePath(storage.auditLogPath, "storage.auditLogPath", baseDirectory),
      worktreeRoot: resolvePath(storage.worktreeRoot, "storage.worktreeRoot", baseDirectory),
      retentionDays: positiveInteger(storage.retentionDays, defaults.retentionDays, "storage.retentionDays"),
      retainJobContent: storage.retainJobContent === true,
    },
    queue: {
      pollIntervalMs: positiveInteger(queue.pollIntervalMs, defaults.pollIntervalMs, "queue.pollIntervalMs"),
    },
  };
}

export function loadSecrets(config: RunnerConfig): RunnerSecrets {
  const openCodePassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (config.executor === "opencode" && !openCodePassword) throw new Error("OPENCODE_SERVER_PASSWORD is required");
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordPublicKey = process.env.DISCORD_PUBLIC_KEY;
  if (config.slack.enabled && !slackBotToken) {
    throw new Error("SLACK_BOT_TOKEN is required when Slack is enabled");
  }
  if (config.slack.enabled && config.slack.ingress === "socket" && !slackAppToken) {
    throw new Error("SLACK_APP_TOKEN is required when Slack Socket Mode ingress is enabled");
  }
  if (config.slack.enabled && config.slack.ingress === "events-api" && !slackSigningSecret) {
    throw new Error("SLACK_SIGNING_SECRET is required when Slack Events API ingress is enabled");
  }
  if (config.discord.enabled && !discordBotToken) {
    throw new Error("DISCORD_BOT_TOKEN is required when Discord is enabled");
  }
  if (config.discord.enabled && config.discord.ingress === "http" && !discordPublicKey) {
    throw new Error("DISCORD_PUBLIC_KEY is required when Discord HTTP ingress is enabled");
  }
  if (config.discord.enabled && config.discord.ingress === "http" && discordPublicKey && !/^[0-9a-f]{64}$/i.test(discordPublicKey)) {
    throw new Error("DISCORD_PUBLIC_KEY must be a 64-character hexadecimal Ed25519 public key");
  }
  return {
    openCodePassword: openCodePassword ?? "",
    ...(discordBotToken ? { discordBotToken } : {}),
    ...(discordPublicKey ? { discordPublicKey } : {}),
    ...(slackBotToken ? { slackBotToken } : {}),
    ...(slackAppToken ? { slackAppToken } : {}),
    ...(slackSigningSecret ? { slackSigningSecret } : {}),
  };
}

export class IntegrationAuthorizationPolicy implements AuthorizationPolicy {
  private readonly rules: ReadonlyMap<IntegrationId, IntegrationAuthorization>;

  constructor(rules: Partial<Record<IntegrationId, IntegrationAuthorization>>) {
    this.rules = new Map(Object.entries(rules) as [IntegrationId, IntegrationAuthorization][]);
  }

  authorize(submission: JobSubmission): AuthorizationDecision {
    const rule = this.rules.get(submission.integration);
    if (!rule) {
      return { authorized: false, reason: `No authorization policy for integration "${submission.integration}"` };
    }
    if (!rule.allowedTenants.includes(submission.tenantId)) {
      return { authorized: false };
    }
    if (!rule.allowedActors.includes(submission.actorId)) {
      return { authorized: false };
    }
    return { authorized: true };
  }
}
