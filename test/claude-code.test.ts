import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  ListSessionsOptions,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeExecutor } from "../src/claude-code.js";
import { LimitError } from "../src/errors.js";
import type { JobRecord, SessionRecord, Usage } from "../src/types.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const auditStub = { log: async () => undefined };

/**
 * Stands in for the transcripts the child would have written into a workspace.
 * Tests push entries to simulate a turn that reached disk; deletions are applied
 * so a caller cannot claim to erase a transcript it never touched.
 */
function transcriptStore() {
  const entries: SDKSessionInfo[] = [];
  const lookups: ListSessionsOptions[] = [];
  const deleted: string[] = [];
  return {
    entries,
    lookups,
    deleted,
    store: {
      list: async (options: ListSessionsOptions) => {
        lookups.push(options);
        return [...entries];
      },
      delete: async (id: string) => {
        deleted.push(id);
        const index = entries.findIndex((entry) => entry.sessionId === id);
        if (index < 0) throw new Error(`no transcript ${id}`);
        entries.splice(index, 1);
      },
    },
  };
}

function transcript(id: string, lastModified: number): SDKSessionInfo {
  return { sessionId: id, summary: "", lastModified };
}

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

test("Claude Code reports an SDK-enforced budget stop as a budget limit", async () => {
  const queryFactory = (() => {
    const stream = async function* (): AsyncIterable<SDKMessage> {
      yield {
        ...(resultMessage("partial") as unknown as Record<string, unknown>),
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["max budget exceeded"],
      } as unknown as SDKMessage;
    };
    return {
      [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](),
      close: () => undefined,
    } as unknown as Query;
  });
  const executor = new ClaudeCodeExecutor(
    { workingRepository: ".", permissionMode: "acceptEdits" },
    { prepare: async () => ".", cleanup: async () => undefined },
    auditStub,
    queryFactory,
    () => sessionId,
    transcriptStore().store,
  );
  const prepared = await executor.prepareSession(
    job(),
    session(),
    { onWorkingDirectory: () => undefined },
    AbortSignal.timeout(2_000),
  );

  await assert.rejects(
    executor.executeTurn(
      job(),
      prepared,
      { onText: () => undefined, onTool: () => undefined, onUsage: () => undefined },
      AbortSignal.timeout(2_000),
      0.25,
    ),
    // The user-facing failure has to name the budget, not a provider fault.
    (error: unknown) => error instanceof LimitError
      && error.code === "DAILY_BUDGET"
      && /budget/i.test(error.message),
  );
});

test("Claude Code streams input/output, maps tools and usage, and resumes the durable session", async (t) => {
  const environment = {
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    CLAUDE_CONFIG_DIR: "C:\\ProgramData\\AgentRunner\\claude",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
    AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
    AWS_REGION: "eu-central-1",
    ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLOUD_ML_REGION: "europe-west1",
    ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
    GOOGLE_CLOUD_PROJECT: "test-project",
    ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
    ANTHROPIC_FOUNDRY_RESOURCE: "foundry-resource",
    VERTEX_REGION_CLAUDE_4_6_SONNET: "europe-west4",
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
        type: "system",
        subtype: "init",
        permissionMode: "acceptEdits",
        claude_code_version: "1.2.3",
        model: "claude-opus-4",
        apiKeySource: "ANTHROPIC_API_KEY",
        session_id: sessionId,
      } as unknown as SDKMessage;
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
  const transcripts = transcriptStore();
  const auditEvents: Array<{ eventType: string; payload: unknown }> = [];
  const executor = new ClaudeCodeExecutor(
    { workingRepository: repository, permissionMode: "acceptEdits" },
    { prepare: async () => worktreeRoot, cleanup: async () => undefined },
    { log: async (eventType: string, payload: unknown) => { auditEvents.push({ eventType, payload }); } },
    queryFactory,
    () => sessionId,
    transcripts.store,
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
  const first = await executor.executeTurn(job(), prepared, callbacks, AbortSignal.timeout(2_000), 4.5);
  transcripts.entries.push(transcript(sessionId, 1));
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
  assert.equal(calls[0]?.options?.maxBudgetUsd, 4.5);
  assert.deepEqual(calls[0]?.options?.settingSources, ["user", "project"]);
  // Every workspace is a worktree of one repository, so sibling threads must
  // never appear in a transcript lookup.
  assert.equal(transcripts.lookups.every((options) => options.includeWorktrees === false), true);
  assert.deepEqual(transcripts.lookups.map((options) => options.dir), [worktreeRoot, worktreeRoot]);
  // The init message is the only record of which CLI and credential served the
  // job, and it distinguishes a created session from a continued one.
  assert.deepEqual(auditEvents.map((event) => event.eventType), [
    "claude_code_session_started",
    "claude_code_session_started",
  ]);
  assert.deepEqual(auditEvents[0]?.payload, {
    version: "1.2.3",
    model: "claude-opus-4",
    apiKeySource: "ANTHROPIC_API_KEY",
    resumed: false,
  });
  assert.equal((auditEvents[1]?.payload as { resumed: boolean }).resumed, true);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_API_KEY, environment.ANTHROPIC_API_KEY);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, environment.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CONFIG_DIR, environment.CLAUDE_CONFIG_DIR);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_USE_BEDROCK, environment.CLAUDE_CODE_USE_BEDROCK);
  assert.equal(calls[0]?.options?.env?.AWS_BEARER_TOKEN_BEDROCK, environment.AWS_BEARER_TOKEN_BEDROCK);
  assert.equal(calls[0]?.options?.env?.AWS_REGION, environment.AWS_REGION);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_BEDROCK_BASE_URL, environment.ANTHROPIC_BEDROCK_BASE_URL);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_USE_VERTEX, environment.CLAUDE_CODE_USE_VERTEX);
  assert.equal(calls[0]?.options?.env?.CLOUD_ML_REGION, environment.CLOUD_ML_REGION);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_VERTEX_PROJECT_ID, environment.ANTHROPIC_VERTEX_PROJECT_ID);
  assert.equal(calls[0]?.options?.env?.GOOGLE_CLOUD_PROJECT, environment.GOOGLE_CLOUD_PROJECT);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_FOUNDRY_API_KEY, environment.ANTHROPIC_FOUNDRY_API_KEY);
  assert.equal(calls[0]?.options?.env?.ANTHROPIC_FOUNDRY_RESOURCE, environment.ANTHROPIC_FOUNDRY_RESOURCE);
  assert.equal(calls[0]?.options?.env?.VERTEX_REGION_CLAUDE_4_6_SONNET, environment.VERTEX_REGION_CLAUDE_4_6_SONNET);
  assert.equal(calls[0]?.options?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined);
  assert.equal(calls[0]?.options?.env?.SLACK_BOT_TOKEN, undefined);
  assert.equal(calls[0]?.options?.env?.DISCORD_BOT_TOKEN, undefined);
  assert.equal(closeCount, 2);
  await rm(root, { recursive: true, force: true });
});

test("Claude Code trusts the workspace transcript over the retired session record", async () => {
  const olderSessionId = "22222222-2222-4222-8222-222222222222";
  const mintedSessionId = "33333333-3333-4333-8333-333333333333";
  const transcripts = transcriptStore();
  const executor = new ClaudeCodeExecutor(
    { workingRepository: ".", permissionMode: "acceptEdits" },
    { prepare: async () => ".", cleanup: async () => undefined },
    auditStub,
    undefined,
    () => mintedSessionId,
    transcripts.store,
  );
  const prepare = (overrides: Partial<SessionRecord>) => executor.prepareSession(
    job(),
    session({ providerId: "claude-code", workingDirectory: ".", ...overrides }),
    { onWorkingDirectory: () => undefined },
    AbortSignal.timeout(2_000),
  );

  // A failed turn makes the runner retire the recorded ID, but the transcript
  // survives, so the thread keeps its history instead of restarting.
  transcripts.entries.push(transcript(olderSessionId, 10), transcript(sessionId, 20));
  assert.equal((await prepare({ providerSessionId: null })).providerSessionId, sessionId);

  // A hard kill can record an ID the child never wrote. Resuming it would fail
  // for good, so an unknown ID starts a new session instead.
  assert.equal((await prepare({ providerSessionId: mintedSessionId })).providerSessionId, mintedSessionId);

  // An empty workspace has nothing to recover.
  transcripts.entries.length = 0;
  assert.equal((await prepare({ providerSessionId: null })).providerSessionId, mintedSessionId);
});

test("Claude Code retention erases every transcript the workspace holds", async () => {
  const transcripts = transcriptStore();
  const cleanedWorkspaces: string[] = [];
  const executor = new ClaudeCodeExecutor(
    { workingRepository: ".", permissionMode: "acceptEdits" },
    { prepare: async () => ".", cleanup: async (directory: string) => { cleanedWorkspaces.push(directory); } },
    auditStub,
    undefined,
    () => sessionId,
    transcripts.store,
  );
  // A thread mints a new transcript every time a failed turn retires the last
  // one, and the record is null whenever that failure was the most recent turn.
  transcripts.entries.push(transcript("aaaaaaaa-1111-4111-8111-111111111111", 10), transcript(sessionId, 20));

  await executor.cleanup(session({ providerId: "claude-code", providerSessionId: null, workingDirectory: "." }));

  assert.deepEqual(transcripts.deleted, ["aaaaaaaa-1111-4111-8111-111111111111", sessionId]);
  assert.deepEqual(transcripts.entries, []);
  assert.deepEqual(cleanedWorkspaces, ["."]);
});

test("Claude Code refuses to rebind a previously used OpenCode thread", async () => {
  let preparedWorkspace = false;
  const executor = new ClaudeCodeExecutor(
    { workingRepository: ".", permissionMode: "acceptEdits" },
    {
      prepare: async () => {
        preparedWorkspace = true;
        return ".";
      },
      cleanup: async () => undefined,
    },
    auditStub,
  );

  await assert.rejects(
    executor.prepareSession(
      job(),
      session({ executionGeneration: 1 }),
      { onWorkingDirectory: () => undefined },
      AbortSignal.timeout(2_000),
    ),
    (error: unknown) => error instanceof Error && error.message.includes("Cannot resume provider opencode"),
  );
  assert.equal(preparedWorkspace, false);
});

test("Claude Code fails when the child downgrades the configured permission mode", async () => {
  const queryFactory = (() => {
    const stream = async function* (): AsyncIterable<SDKMessage> {
      yield {
        type: "system",
        subtype: "init",
        permissionMode: "default",
        session_id: sessionId,
      } as unknown as SDKMessage;
    };
    return {
      [Symbol.asyncIterator]: () => stream()[Symbol.asyncIterator](),
      close: () => undefined,
    } as unknown as Query;
  });
  const executor = new ClaudeCodeExecutor(
    { workingRepository: ".", permissionMode: "acceptEdits" },
    { prepare: async () => ".", cleanup: async () => undefined },
    auditStub,
    queryFactory,
    () => sessionId,
    transcriptStore().store,
  );
  const prepared = await executor.prepareSession(
    job(),
    session(),
    { onWorkingDirectory: () => undefined },
    AbortSignal.timeout(2_000),
  );

  await assert.rejects(
    executor.executeTurn(
      job(),
      prepared,
      { onText: () => undefined, onTool: () => undefined, onUsage: () => undefined },
      AbortSignal.timeout(2_000),
    ),
    /permission mode default; expected acceptEdits/,
  );
});

test("Claude Code cancellation aborts and closes the SDK query", async () => {
  const { root, repository, worktreeRoot } = await fixture();
  let finish: ((value: IteratorResult<SDKMessage>) => void) | undefined;
  let closed = false;
  let capturedOptions: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"] | undefined;
  const queryFactory = ((parameters: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]) => {
    capturedOptions = parameters.options;
    return ({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKMessage>>((resolve) => { finish = resolve; }),
      return: async () => ({ value: undefined, done: true }),
    }),
    close: () => {
      closed = true;
      finish?.({ value: undefined, done: true });
    },
    }) as unknown as Query;
  });
  const executor = new ClaudeCodeExecutor(
    { workingRepository: repository, permissionMode: "bypassPermissions" },
    { prepare: async () => worktreeRoot, cleanup: async () => undefined },
    auditStub,
    queryFactory,
    () => sessionId,
    transcriptStore().store,
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
  if (process.getuid?.() === 0) {
    assert.equal(capturedOptions?.permissionMode, "default");
  } else {
    assert.equal(capturedOptions?.permissionMode, "bypassPermissions");
    assert.equal(capturedOptions?.allowDangerouslySkipPermissions, true);
  }
  await rm(root, { recursive: true, force: true });
});
