import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeExecutor } from "../src/claude-code.js";
import type { JobRecord, SessionRecord, Usage } from "../src/types.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

async function fixture(): Promise<{ root: string; repository: string; worktreeRoot: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-runner-claude-code-"));
  const repository = path.join(root, "repository");
  return { root, repository, worktreeRoot: path.join(root, "worktrees") };
}

function job(): JobRecord {
  return {
    id: "job-1",
    integration: "slack",
    sourceEventId: "event-1",
    sessionKey: "slack:T1:D1:thread",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "thread",
    deliveryMessageId: null,
    actorId: "U1",
    prompt: "Inspect the repository",
    attachments: [{
      mime: "image/png",
      filename: "screen.png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    }],
    status: "running",
    output: "",
    error: null,
    cost: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: "2026-08-15T00:00:00.000Z",
    startedAt: "2026-08-15T00:00:00.000Z",
    finishedAt: null,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionKey: "slack:T1:D1:thread",
    integration: "slack",
    tenantId: "T1",
    conversationId: "D1",
    threadId: "thread",
    providerId: "opencode",
    providerSessionId: null,
    workingDirectory: null,
    executionGeneration: 0,
    reconciliationRequired: false,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

function resultMessage(output: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: output,
    total_cost_usd: 0.12,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 4,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
  } as unknown as SDKMessage;
}

test("Claude Code streams input/output, maps tools and usage, and resumes the durable session", async (t) => {
  const environment = {
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    CLAUDE_CONFIG_DIR: "C:\\ProgramData\\AgentRunner\\claude",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "eu-central-1",
    CLAUDE_CODE_USE_VERTEX: "1",
    GOOGLE_CLOUD_PROJECT: "test-project",
    SLACK_BOT_TOKEN: "slack-secret",
    DISCORD_BOT_TOKEN: "discord-secret",
  } as const;
  const previousEnvironment = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const { root, repository, worktreeRoot } = await fixture();
  const calls: Array<Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]> = [];
  const inputs: SDKUserMessage[] = [];
  let closeCount = 0;
  const queryFactory = ((parameters: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]) => {
    calls.push(parameters);
    const stream = async function* (): AsyncIterable<SDKMessage> {
      assert.notEqual(typeof parameters.prompt, "string");
      for await (const input of parameters.prompt as AsyncIterable<SDKUserMessage>) inputs.push(input);
      yield {
        type: "stream_event",
        parent_tool_use_id: null,
        session_id: sessionId,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      } as unknown as SDKMessage;
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        session_id: sessionId,
        message: { content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] },
      } as unknown as SDKMessage;
      yield {
        type: "user",
        parent_tool_use_id: null,
        session_id: sessionId,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] },
      } as unknown as SDKMessage;
      yield resultMessage("Hello");
    };
    return {
      [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](),
      close: () => { closeCount += 1; },
    } as unknown as Query;
  });
  const executor = new ClaudeCodeExecutor(
    { workingRepository: repository, permissionMode: "acceptEdits" },
    { prepare: async () => worktreeRoot, cleanup: async () => undefined },
    queryFactory,
    () => sessionId,
  );
  const preparedDirectories: string[] = [];
  const prepared = await executor.prepareSession(
    job(),
    session(),
    { onWorkingDirectory: (directory) => { preparedDirectories.push(directory); } },
    AbortSignal.timeout(2_000),
  );
  const text: string[] = [];
  const tools: unknown[] = [];
  const usages: Usage[] = [];
  const callbacks = {
    onText: (delta: string) => { text.push(delta); },
    onTool: (event: unknown) => { tools.push(event); },
    onUsage: (usage: Usage) => { usages.push(usage); },
  };
  const first = await executor.executeTurn(job(), prepared, callbacks, AbortSignal.timeout(2_000));
  const resumed = await executor.prepareSession(
    job(),
    session({ providerId: "claude-code", providerSessionId: sessionId, workingDirectory: prepared.workingDirectory }),
    { onWorkingDirectory: () => undefined },
    AbortSignal.timeout(2_000),
  );
  await executor.executeTurn(job(), resumed, callbacks, AbortSignal.timeout(2_000));

  assert.equal(prepared.providerSessionId, sessionId);
  assert.equal(preparedDirectories.length, 1);
  assert.equal(first.output, "Hello");
  assert.deepEqual(first.usage, { cost: 0.12, inputTokens: 16, outputTokens: 3 });
  assert.equal(text.join(""), "HelloHello");
  assert.deepEqual(tools.slice(0, 2), [
    { type: "tool_use", id: "tool-1", tool: "Read", input: { file_path: "README.md" } },
    { type: "tool_result", toolUseId: "tool-1", content: "ok", isError: false },
  ]);
  assert.deepEqual(usages[0], first.usage);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.session_id, sessionId);
  assert(Array.isArray(inputs[0]?.message.content));
  assert.equal(calls[0]?.options?.sessionId, sessionId);
  assert.equal(calls[0]?.options?.resume, undefined);
  assert.equal(calls[1]?.options?.resume, sessionId);
  assert.equal(calls[1]?.options?.sessionId, undefined);
  assert.equal(calls[0]?.options?.includePartialMessages, true);
  assert.deepEqual(calls[0]?.options?.settingSources, ["user", "project", "local"]);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_API_KEY, environment.ANTHROPIC_API_KEY);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, environment.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CONFIG_DIR, environment.CLAUDE_CONFIG_DIR);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_USE_BEDROCK, environment.CLAUDE_CODE_USE_BEDROCK);
  assert.equal(calls[0]?.options?.env?.AWS_REGION, environment.AWS_REGION);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_USE_VERTEX, environment.CLAUDE_CODE_USE_VERTEX);
  assert.equal(calls[0]?.options?.env?.GOOGLE_CLOUD_PROJECT, environment.GOOGLE_CLOUD_PROJECT);
  assert.equal(calls[0]?.options?.env?.SLACK_BOT_TOKEN, undefined);
  assert.equal(calls[0]?.options?.env?.DISCORD_BOT_TOKEN, undefined);
  assert.equal(closeCount, 2);
  await rm(root, { recursive: true, force: true });
});

test("Claude Code cancellation aborts and closes the SDK query", async () => {
  const { root, repository, worktreeRoot } = await fixture();
  let finish: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  let closed = false;
  const queryFactory = (() => ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKMessage>>((resolve) => { finish = resolve; }),
      return: async () => ({ value: undefined, done: true }),
    }),
    close: () => {
      closed = true;
      finish?.({ value: undefined, done: true });
    },
  }) as unknown as Query);
  const executor = new ClaudeCodeExecutor(
    { workingRepository: repository, permissionMode: "acceptEdits" },
    { prepare: async () => worktreeRoot, cleanup: async () => undefined },
    queryFactory,
    () => sessionId,
  );
  const prepared = await executor.prepareSession(
    job(),
    session(),
    { onWorkingDirectory: () => undefined },
    AbortSignal.timeout(2_000),
  );
  const controller = new AbortController();
  const execution = executor.executeTurn(
    job(),
    prepared,
    { onText: () => undefined, onTool: () => undefined, onUsage: () => undefined },
    controller.signal,
  );
  await Promise.resolve();
  const reason = new Error("cancelled by test");
  controller.abort(reason);
  await assert.rejects(execution, (error: unknown) => error === reason);
  assert.equal(closed, true);
  await rm(root, { recursive: true, force: true });
});
