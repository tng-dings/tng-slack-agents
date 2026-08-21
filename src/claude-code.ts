import { randomUUID } from "node:crypto";
import {
  deleteSession,
  listSessions,
  query,
  type ListSessionsOptions,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSessionInfo,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isSupportedImageMime } from "./attachments.js";
import type { AuditLogger } from "./audit.js";
import type { ClaudeCodeConfig } from "./config.js";
import { claudeChildEnvironment } from "./claude-environment.js";
import { ClaudeCodeError, LimitError } from "./errors.js";
import type {
  ExecutionCallbacks,
  ExecutionResult,
  Executor,
  JobRecord,
  PreparedExecutionSession,
  SessionPreparationCallbacks,
  SessionRecord,
  Usage,
} from "./types.js";
import { errorMessage, errorMetadata } from "./values.js";
import type { WorkspaceManager } from "./workspace.js";

const PROVIDER_ID = "claude-code";
const STDERR_TAIL_CHARACTERS = 4_000;
type QueryFactory = (parameters: Parameters<typeof query>[0]) => Query;
type ClaudeWorkspaceManager = Pick<WorkspaceManager, "prepare" | "cleanup">;
type ClaudeAuditLogger = Pick<AuditLogger, "log">;

/** The durable conversation record the child writes for a workspace. */
interface TranscriptStore {
  list(options: ListSessionsOptions): Promise<SDKSessionInfo[]>;
  delete(sessionId: string, options: { dir: string }): Promise<void>;
}

function dataUrlPayload(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !dataUrl.slice(0, separator).toLowerCase().endsWith(";base64")) {
    throw new ClaudeCodeError("Claude Code attachments must use base64 data URLs", "CLAUDE_CODE_ATTACHMENT_ERROR");
  }
  return dataUrl.slice(separator + 1);
}

function inputMessage(job: JobRecord, sessionId: string): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: job.prompt }];
  for (const attachment of job.attachments) {
    if (!isSupportedImageMime(attachment.mime)) {
      throw new ClaudeCodeError(`Claude Code does not support attachment type ${attachment.mime}`, "CLAUDE_CODE_ATTACHMENT_ERROR");
    }
    content.push({
      type: "image",
      source: { type: "base64", media_type: attachment.mime, data: dataUrlPayload(attachment.dataUrl) },
    });
  }
  return {
    type: "user",
    message: { role: "user", content: content as unknown as SDKUserMessage["message"]["content"] },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

async function* streamingInput(job: JobRecord, sessionId: string): AsyncIterable<SDKUserMessage> {
  yield inputMessage(job, sessionId);
}

function usageFromResult(message: SDKResultMessage): Usage {
  const models = Object.values(message.modelUsage);
  if (models.length > 0) {
    return {
      cost: message.total_cost_usd,
      inputTokens: models.reduce(
        (sum, usage) => sum + usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
        0,
      ),
      outputTokens: models.reduce((sum, usage) => sum + usage.outputTokens, 0),
    };
  }
  return {
    cost: message.total_cost_usd,
    inputTokens: message.usage.input_tokens + message.usage.cache_read_input_tokens + message.usage.cache_creation_input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

async function emitTextDelta(message: SDKMessage, callbacks: ExecutionCallbacks): Promise<void> {
  if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return;
  const event = message.event;
  if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
    await callbacks.onText(event.delta.text);
  } else if (event.type === "content_block_start" && event.content_block.type === "text" && event.content_block.text) {
    await callbacks.onText(event.content_block.text);
  }
}

async function emitToolEvents(message: SDKMessage, callbacks: ExecutionCallbacks): Promise<void> {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") {
        await callbacks.onTool({ type: "tool_use", id: block.id, tool: block.name, input: block.input });
      }
    }
    return;
  }
  if (message.type !== "user" || typeof message.message.content === "string") return;
  for (const block of message.message.content) {
    if (block.type === "tool_result") {
      await callbacks.onTool({
        type: "tool_result",
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error === true,
      });
    }
  }
}

// Claude Code exits rather than skip permissions as root, so under root the
// bypass becomes `default` plus an allow-all handler. Callers assert the child
// reports back the mode returned here, so the two must not drift apart.
function permissionOptions(
  config: ClaudeCodeConfig,
): Pick<Options, "allowDangerouslySkipPermissions" | "canUseTool"> & { permissionMode: PermissionMode } {
  if (config.permissionMode !== "bypassPermissions") return { permissionMode: config.permissionMode };
  if (process.getuid?.() === 0) {
    return {
      permissionMode: "default",
      canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
    };
  }
  return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

function assertEffectivePermissionMode(message: SDKMessage, expected: string): void {
  if (message.type !== "system" || message.subtype !== "init") return;
  if (message.permissionMode !== expected) {
    throw new ClaudeCodeError(
      `Claude Code started with permission mode ${message.permissionMode}; expected ${expected}`,
      "CLAUDE_CODE_PERMISSION_MODE_MISMATCH",
    );
  }
}

export class ClaudeCodeExecutor implements Executor {
  private assertProvider(providerId: string, action: string): void {
    if (providerId === PROVIDER_ID) return;
    throw new ClaudeCodeError(`Cannot ${action} provider ${providerId} with Claude Code`, "CLAUDE_CODE_PROVIDER_MISMATCH");
  }

  constructor(
    private readonly config: ClaudeCodeConfig,
    private readonly workspaces: ClaudeWorkspaceManager,
    private readonly audit: ClaudeAuditLogger,
    private readonly queryFactory: QueryFactory = query,
    private readonly sessionIdFactory: () => string = randomUUID,
    private readonly transcripts: TranscriptStore = { list: listSessions, delete: deleteSession },
  ) {}

  /**
   * The transcript on disk is the durable record, not the recorded ID: the
   * runner retires that ID whenever a turn fails, and a hard kill can leave one
   * the child never wrote. `includeWorktrees: false` is load-bearing — every
   * workspace is a worktree of one repository, so the SDK default would resume
   * a sibling thread's conversation.
   */
  private async resumableSessionId(
    recordedSessionId: string | null,
    workingDirectory: string,
  ): Promise<string | undefined> {
    const sessions = await this.transcripts.list({ dir: workingDirectory, includeWorktrees: false });
    if (recordedSessionId) {
      return sessions.find((entry) => entry.sessionId === recordedSessionId)?.sessionId;
    }
    return sessions.sort((left, right) => right.lastModified - left.lastModified)[0]?.sessionId;
  }

  /** Records which CLI, model and credential served a job. Never worth failing that job over. */
  private async auditSessionStart(message: SDKMessage, job: JobRecord, resumed: boolean): Promise<void> {
    if (message.type !== "system" || message.subtype !== "init") return;
    await this.audit.log(
      "claude_code_session_started",
      { version: message.claude_code_version, model: message.model, apiKeySource: message.apiKeySource, resumed },
      { jobId: job.id, userId: job.actorId, sessionKey: job.sessionKey },
    ).catch((error: unknown) => console.error("Unable to record Claude Code session start", errorMetadata(error)));
  }

  async prepareSession(
    _job: JobRecord,
    session: SessionRecord,
    callbacks: SessionPreparationCallbacks,
    _signal: AbortSignal,
  ): Promise<PreparedExecutionSession> {
    if (session.providerSessionId !== null || session.executionGeneration > 0) {
      this.assertProvider(session.providerId, "resume");
    }
    const workingDirectory = await this.workspaces.prepare(session.sessionKey, session.workingDirectory);
    await callbacks.onWorkingDirectory(workingDirectory);
    const resumable = await this.resumableSessionId(session.providerSessionId, workingDirectory);
    return {
      providerId: PROVIDER_ID,
      providerSessionId: resumable ?? this.sessionIdFactory(),
      workingDirectory,
      isNewProviderSession: resumable === undefined,
    };
  }

  async executeTurn(
    job: JobRecord,
    session: PreparedExecutionSession,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
    budgetUsd?: number,
  ): Promise<ExecutionResult> {
    this.assertProvider(session.providerId, "execute");
    const controller = new AbortController();
    let stderrTail = "";
    const permissions = permissionOptions(this.config);
    const freshSession = session.isNewProviderSession ?? true;
    const options: Options = {
      abortController: controller,
      cwd: session.workingDirectory,
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      // "local" is withheld: the agent can write .claude/settings.local.json
      // into its own workspace, and the next turn would load the hooks it left
      // behind. "project" stays because CLAUDE.md needs it.
      settingSources: ["user", "project"],
      persistSession: true,
      env: claudeChildEnvironment(process.env),
      stderr: (chunk) => { stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARACTERS); },
      ...permissions,
      ...(freshSession ? { sessionId: session.providerSessionId } : { resume: session.providerSessionId }),
      ...(budgetUsd !== undefined ? { maxBudgetUsd: budgetUsd } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.executablePath ? { pathToClaudeCodeExecutable: this.config.executablePath } : {}),
    };
    const sdkQuery = this.queryFactory({ prompt: streamingInput(job, session.providerSessionId), options });
    const abort = () => {
      controller.abort(signal.reason);
      sdkQuery.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    let result: SDKResultMessage | undefined;
    try {
      for await (const message of sdkQuery) {
        if (message.session_id !== session.providerSessionId) {
          throw new ClaudeCodeError("Claude Code returned an unexpected session_id", "CLAUDE_CODE_SESSION_MISMATCH");
        }
        assertEffectivePermissionMode(message, permissions.permissionMode);
        await this.auditSessionStart(message, job, !freshSession);
        await emitTextDelta(message, callbacks);
        await emitToolEvents(message, callbacks);
        if (message.type === "result") {
          result = message;
          await callbacks.onUsage(usageFromResult(message));
          for (const denial of message.permission_denials) {
            await callbacks.onTool({ type: "permission_denial", ...denial });
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const stderr = stderrTail.trim();
      if (error instanceof ClaudeCodeError && (!stderr || error.message.includes(stderr))) throw error;
      throw new ClaudeCodeError(
        stderr && !errorMessage(error).includes(stderr)
          ? `${errorMessage(error)}\n\nClaude Code stderr:\n${stderr}`
          : errorMessage(error),
        error instanceof ClaudeCodeError ? error.code : "CLAUDE_CODE_ERROR",
      );
    } finally {
      signal.removeEventListener("abort", abort);
      sdkQuery.close();
    }

    if (signal.aborted) throw signal.reason ?? new ClaudeCodeError("Claude Code execution was cancelled");
    if (!result) throw new ClaudeCodeError("Claude Code stream ended without a result", "CLAUDE_CODE_STREAM_ENDED");
    // The SDK enforced the cap we handed it and stopped cleanly, so this is a
    // budget refusal rather than a provider fault.
    if (result.subtype === "error_max_budget_usd") {
      throw new LimitError("Your daily agent budget was reached while this job was running.", "DAILY_BUDGET");
    }
    if (result.is_error || result.subtype !== "success") {
      const details = result.subtype === "success" ? result.result : result.errors.join("\n");
      throw new ClaudeCodeError(details || `Claude Code result failed: ${result.subtype}`, "CLAUDE_CODE_PROVIDER_ERROR");
    }
    return { output: result.result, usage: usageFromResult(result) };
  }

  async reconcileSession(session: SessionRecord, _signal: AbortSignal): Promise<void> {
    this.assertProvider(session.providerId, "reconcile");
    // Nothing to stop: SDK queries are child processes owned by this runner, so
    // an interrupted turn leaves no detached provider process behind. The runner
    // then retires the recorded transcript ID, and prepareSession recovers it
    // from the workspace on the next turn.
  }

  /**
   * A thread accumulates one transcript per retirement cycle and the recorded
   * ID is null whenever its last turn failed, so only the workspace can say
   * what retention has to erase.
   */
  async cleanup(session: SessionRecord): Promise<void> {
    this.assertProvider(session.providerId, "clean up");
    const dir = session.workingDirectory;
    if (!dir) return;
    for (const entry of await this.transcripts.list({ dir, includeWorktrees: false })) {
      // A transcript removed between the listing and the delete is already gone.
      await this.transcripts.delete(entry.sessionId, { dir }).catch((error: unknown) => {
        if (!/not found/i.test(errorMessage(error))) throw error;
      });
    }
    await this.workspaces.cleanup(dir);
  }
}
