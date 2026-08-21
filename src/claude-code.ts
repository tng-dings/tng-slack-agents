import { randomUUID } from "node:crypto";
import {
  deleteSession,
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isSupportedImageMime } from "./attachments.js";
import type { ClaudeCodeConfig } from "./config.js";
import { claudeChildEnvironment } from "./claude-environment.js";
import { ClaudeCodeError } from "./errors.js";
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
import { errorMessage } from "./values.js";
import type { WorkspaceManager } from "./workspace.js";

const PROVIDER_ID = "claude-code";
const STDERR_TAIL_CHARACTERS = 4_000;
type QueryFactory = (parameters: Parameters<typeof query>[0]) => Query;
type ClaudeWorkspaceManager = Pick<WorkspaceManager, "prepare" | "cleanup">;

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= STDERR_TAIL_CHARACTERS
    ? combined
    : combined.slice(combined.length - STDERR_TAIL_CHARACTERS);
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

function permissionOptions(config: ClaudeCodeConfig): Pick<
  Options,
  "permissionMode" | "allowDangerouslySkipPermissions" | "canUseTool"
> {
  if (config.permissionMode !== "bypassPermissions") return { permissionMode: config.permissionMode };
  if (process.getuid?.() === 0) {
    return {
      permissionMode: "default",
      canUseTool: async (_toolName, input) => ({ behavior: "allow", updatedInput: input }),
    };
  }
  return { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true };
}

function assertEffectivePermissionMode(message: SDKMessage, config: ClaudeCodeConfig): void {
  if (message.type !== "system" || message.subtype !== "init") return;
  const expected = config.permissionMode === "bypassPermissions" && process.getuid?.() === 0
    ? "default"
    : config.permissionMode;
  if (message.permissionMode !== expected) {
    throw new ClaudeCodeError(
      `Claude Code started with permission mode ${message.permissionMode}; expected ${expected}`,
      "CLAUDE_CODE_PERMISSION_MODE_MISMATCH",
    );
  }
}

export class ClaudeCodeExecutor implements Executor {
  private readonly freshSessionIds = new Set<string>();

  constructor(
    private readonly config: ClaudeCodeConfig,
    private readonly workspaces: ClaudeWorkspaceManager,
    private readonly queryFactory: QueryFactory = query,
    private readonly sessionIdFactory: () => string = randomUUID,
  ) {}

  async prepareSession(
    _job: JobRecord,
    session: SessionRecord,
    callbacks: SessionPreparationCallbacks,
    _signal: AbortSignal,
  ): Promise<PreparedExecutionSession> {
    if (
      session.providerId !== PROVIDER_ID &&
      (session.providerSessionId !== null || session.executionGeneration > 0)
    ) {
      throw new ClaudeCodeError(`Cannot resume provider ${session.providerId} with Claude Code`, "CLAUDE_CODE_PROVIDER_MISMATCH");
    }
    const workingDirectory = await this.workspaces.prepare(session.sessionKey, session.workingDirectory);
    await callbacks.onWorkingDirectory(workingDirectory);
    const providerSessionId = session.providerSessionId ?? this.sessionIdFactory();
    if (!session.providerSessionId) this.freshSessionIds.add(providerSessionId);
    return {
      providerId: PROVIDER_ID,
      providerSessionId,
      workingDirectory,
    };
  }

  async executeTurn(
    job: JobRecord,
    session: PreparedExecutionSession,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    if (session.providerId !== PROVIDER_ID) {
      throw new ClaudeCodeError(`Cannot execute provider ${session.providerId} with Claude Code`, "CLAUDE_CODE_PROVIDER_MISMATCH");
    }
    const controller = new AbortController();
    let stderrTail = "";
    const freshSession = this.freshSessionIds.delete(session.providerSessionId);
    const options: Options = {
      abortController: controller,
      cwd: session.workingDirectory,
      systemPrompt: { type: "preset", preset: "claude_code" },
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      persistSession: true,
      env: claudeChildEnvironment(process.env),
      stderr: (chunk) => { stderrTail = appendBounded(stderrTail, chunk); },
      ...permissionOptions(this.config),
      ...(freshSession ? { sessionId: session.providerSessionId } : { resume: session.providerSessionId }),
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
        assertEffectivePermissionMode(message, this.config);
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
    if (result.is_error || result.subtype !== "success") {
      const details = result.subtype === "success" ? result.result : result.errors.join("\n");
      throw new ClaudeCodeError(details || `Claude Code result failed: ${result.subtype}`, "CLAUDE_CODE_PROVIDER_ERROR");
    }
    return { output: result.result, usage: usageFromResult(result) };
  }

  async reconcileSession(session: SessionRecord, _signal: AbortSignal): Promise<void> {
    if (session.providerId !== PROVIDER_ID) {
      throw new ClaudeCodeError(`Cannot reconcile provider ${session.providerId} with Claude Code`, "CLAUDE_CODE_PROVIDER_MISMATCH");
    }
    // SDK queries are child processes owned by this runner. After an in-process
    // cancellation or a process restart there is no detached provider process
    // to stop; the runner can safely retire the ambiguous transcript ID.
  }

  async cleanup(session: SessionRecord): Promise<void> {
    if (session.providerId !== PROVIDER_ID) {
      throw new ClaudeCodeError(`Cannot clean up provider ${session.providerId} with Claude Code`, "CLAUDE_CODE_PROVIDER_MISMATCH");
    }
    if (!session.workingDirectory) return;
    if (session.providerSessionId) {
      await deleteSession(session.providerSessionId, { dir: session.workingDirectory }).catch((error: unknown) => {
        if (!/not found/i.test(errorMessage(error))) throw error;
      });
    }
    await this.workspaces.cleanup(session.workingDirectory);
  }
}
