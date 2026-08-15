import { randomUUID } from "node:crypto";
import { AuditLogger } from "../audit.js";
import { ClaudeCodeExecutor } from "../claude-code.js";
import { loadConfig, loadSecrets } from "../config.js";
import { RunnerDatabase } from "../database.js";
import { OpenCodeExecutor } from "../opencode.js";
import { WorkspaceManager } from "../workspace.js";
import type { Executor } from "../types.js";

const defaultPrompt = "Inspect this repository, identify the main technology stack, and reply with a concise summary. Do not modify files.";

async function main(): Promise<void> {
  const config = await loadConfig();
  const secrets = loadSecrets({
    ...config,
    discord: { ...config.discord, enabled: false },
    slack: { ...config.slack, enabled: false },
  });
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(
    config.storage.auditLogPath,
    database,
    [secrets.openCodePassword],
    config.limits.maxAuditEventCharacters,
  );
  const workspaces = new WorkspaceManager(config.workingRepository, config.storage.worktreeRoot);
  const executor: Executor = config.executor === "opencode"
    ? new OpenCodeExecutor(
        config.openCode,
        secrets.openCodePassword,
        workspaces,
        audit,
        config.limits.maxOutputCharacters + 64_000,
      )
    : new ClaudeCodeExecutor(config.claudeCode, workspaces);
  const prompt = process.argv.slice(2).join(" ").trim() || defaultPrompt;
  const sourceEventId = `local-smoke:${randomUUID()}`;
  const job = database.insertJob(randomUUID(), {
    integration: "local",
    sourceEventId,
    tenantId: "local",
    conversationId: "cli",
    threadId: "smoke",
    actorId: "local-user",
    prompt,
  });
  const session = database.getSession(job.sessionKey)!;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Smoke test timed out")), config.limits.jobTimeoutSeconds * 1_000);
  let streamedOutput = "";
  try {
    if (executor instanceof OpenCodeExecutor) {
      const health = await executor.health();
      console.log(`Connected to OpenCode ${health.version ?? "unknown"}.`);
    } else {
      console.log("Using the local Claude Code executor.");
    }
    const prepared = await executor.prepareSession(
      job,
      session,
      { onWorkingDirectory: (workingDirectory) => database.updateSessionWorkingDirectory(job.sessionKey, workingDirectory) },
      controller.signal,
    );
    database.updateSessionProviderSession(job.sessionKey, prepared.providerId, prepared.providerSessionId);
    const result = await executor.executeTurn(
      job,
      prepared,
      {
        onText: (delta) => {
          streamedOutput += delta;
          process.stdout.write(delta);
        },
        onTool: () => audit.log("smoke_tool_event", { observed: true }, { jobId: job.id, sessionKey: job.sessionKey }),
        onUsage: () => undefined,
      },
      controller.signal,
    );
    if (!streamedOutput && result.output) process.stdout.write(result.output);
    if (!result.output.endsWith("\n")) process.stdout.write("\n");
    database.completeJob(job.id, "succeeded", result.output, null, result.usage, config.storage.retainJobContent);
    await audit.log(
      "smoke_succeeded",
      { promptCharacters: prompt.length, outputCharacters: result.output.length, usage: result.usage },
      { jobId: job.id, sessionKey: job.sessionKey },
    );
    console.log(`Cost: ${result.usage.cost}; input tokens: ${result.usage.inputTokens}; output tokens: ${result.usage.outputTokens}`);
  } catch (error) {
    database.completeJob(
      job.id,
      "failed",
      "",
      "Smoke execution failed; see console output.",
      { cost: 0, inputTokens: 0, outputTokens: 0 },
      config.storage.retainJobContent,
    );
    throw error;
  } finally {
    clearTimeout(timeout);
    await audit.flush();
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
