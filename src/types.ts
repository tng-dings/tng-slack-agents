export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "rejected";

export interface Attachment {
  mime: string;
  filename: string;
  dataUrl: string;
}

export type IntegrationId = "slack" | "discord" | "local";

export type InboundEventStatus = "pending" | "processing" | "processed";

export interface InboundEventRecord {
  eventKey: string;
  integration: IntegrationId;
  sourceEventId: string;
  payload: unknown;
  status: InboundEventStatus;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  receivedAt: string;
  updatedAt: string;
  processedAt: string | null;
}

export interface JobRecord {
  id: string;
  integration: IntegrationId;
  sourceEventId: string;
  sessionKey: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
  deliveryMessageId: string | null;
  actorId: string;
  prompt: string;
  attachments: Attachment[];
  status: JobStatus;
  output: string;
  error: string | null;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SessionRecord {
  sessionKey: string;
  integration: IntegrationId;
  tenantId: string;
  conversationId: string;
  threadId: string;
  openCodeSessionId: string | null;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscordThreadRecord {
  threadId: string;
  guildId: string;
  parentChannelId: string;
  ownerUserId: string;
  createdAt: string;
}

export interface JobSubmission {
  integration: IntegrationId;
  sourceEventId: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
  deliveryMessageId?: string;
  actorId: string;
  prompt: string;
  attachments?: Attachment[];
}

export interface Usage {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ExecutionCallbacks {
  onText(delta: string): Promise<void> | void;
  onTool(event: unknown): Promise<void> | void;
  onUsage(usage: Usage): Promise<void> | void;
}

export interface ExecutionResult {
  output: string;
  usage: Usage;
  openCodeSessionId: string;
  workingDirectory: string;
}

export interface Executor {
  execute(
    job: JobRecord,
    session: SessionRecord,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult>;
  abort?(openCodeSessionId: string, workingDirectory: string): Promise<void>;
  cleanup?(session: SessionRecord): Promise<void>;
}

export interface JobReporter {
  start(): Promise<{ deliveryMessageId?: string } | void>;
  append(delta: string): Promise<unknown> | unknown;
  succeed(output: string): Promise<unknown> | unknown;
  fail(message: string): Promise<void>;
}

export interface SubmissionResult {
  job: JobRecord;
  isNew: boolean;
}

export type ReporterFactory = (job: JobRecord) => JobReporter;

export interface AuthorizationDecision {
  readonly authorized: boolean;
  readonly reason?: string;
}

export interface AuthorizationPolicy {
  authorize(submission: JobSubmission): AuthorizationDecision;
}
