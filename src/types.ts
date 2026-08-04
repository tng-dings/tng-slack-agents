export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "rejected";

export interface JobRecord {
  id: string;
  sourceEventId: string;
  sessionKey: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  replyTs: string | null;
  userId: string;
  prompt: string;
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
  workspaceId: string;
  channelId: string;
  threadTs: string;
  openCodeSessionId: string | null;
  workingDirectory: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobSubmission {
  sourceEventId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  replyTs?: string;
  userId: string;
  prompt: string;
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
}

export interface JobReporter {
  start(): Promise<void>;
  append(delta: string): Promise<unknown> | unknown;
  succeed(output: string): Promise<unknown> | unknown;
  fail(message: string): Promise<void>;
}

export type ReporterFactory = (job: JobRecord) => JobReporter;
