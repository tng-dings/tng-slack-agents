import { randomUUID } from "node:crypto";
import { AuditLogger } from "../audit.js";
import { loadConfig, loadSecrets } from "../config.js";
import { RunnerDatabase } from "../database.js";
import { OpenCodeExecutor } from "../opencode.js";
import { WorkspaceManager } from "../workspace.js";

const defaultPrompt = "Inspect this repository, identify the main technology stack, and reply with a concise summary. Do not modify files.";

async function main(): Promise<void> {
  const config = await loadConfig();
  const secrets = loadSecrets({ ...config, slack: { ...config.slack, enabled: false } });
  const database = new RunnerDatabase(config.storage.databasePath);
  const audit = new AuditLogger(
    config.storage.auditLogPath,
    database,
    [secrets.openCodePassword],
    config.limits.maxAuditEventCharacters,
  );
  const executor = new OpenCodeExecutor(
    config.openCode,
    secrets.openCodePassword,
    new WorkspaceManager(config.openCode.workingRepository, config.storage.worktreeRoot),
    audit,
    config.limits.maxOutputCharacters + 64_000,
  );
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
    const health = await executor.health();
    console.log(`Connected to OpenCode ${health.version ?? "unknown"}.`);
    const result = await executor.execute(
      job,
      session,
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
    database.updateSessionExecution(job.sessionKey, result.openCodeSessionId, result.workingDirectory);
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
