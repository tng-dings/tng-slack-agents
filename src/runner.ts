import { createHash, randomUUID } from "node:crypto";
import type { AuditLogger } from "./audit.js";
import type { RunnerConfig } from "./config.js";
import type { RunnerDatabase } from "./database.js";
import { AuthorizationError, LimitError, RunnerError, TimeoutError } from "./errors.js";
import type {
  Attachment,
  AuthorizationPolicy,
  Executor,
  JobRecord,
  JobReporter,
  JobSubmission,
  ReporterFactory,
  SubmissionResult,
  Usage,
} from "./types.js";

const emptyUsage = (): Usage => ({ cost: 0, inputTokens: 0, outputTokens: 0 });

function contentMetadata(value: string): { characters: number; sha256: string } {
  return { characters: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

function attachmentMetadata(attachments: Attachment[]): { count: number; totalBytes: number; items: { filename: string; mime: string; bytes: number; sha256: string }[] } {
  return {
    count: attachments.length,
    totalBytes: attachments.reduce((sum, a) => sum + Buffer.byteLength(a.dataUrl, "utf8"), 0),
    items: attachments.map((a) => ({
      filename: a.filename,
      mime: a.mime,
      bytes: Buffer.byteLength(a.dataUrl, "utf8"),
      sha256: createHash("sha256").update(a.dataUrl).digest("hex"),
    })),
  };
}

function toolMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: typeof value };
  const event = value as Record<string, unknown>;
  const state = event.state && typeof event.state === "object" && !Array.isArray(event.state)
    ? event.state as Record<string, unknown>
    : {};
  return {
    ...(typeof event.tool === "string" ? { tool: event.tool } : {}),
    ...(typeof event.callID === "string" ? { callId: event.callID } : {}),
    ...(typeof state.status === "string" ? { status: state.status } : {}),
  };
}

function userFacingFailure(reason: unknown, jobId: string): string {
  if (reason instanceof TimeoutError || reason instanceof LimitError) return reason.message;
  return `The agent job failed. Reference: ${jobId}`;
}

function errorMetadata(reason: unknown): { errorType: string; errorCode?: string } {
  if (reason instanceof RunnerError) return { errorType: reason.name, errorCode: reason.code };
  if (reason instanceof Error) return { errorType: reason.name || "Error" };
  return { errorType: typeof reason };
}

export class ConsoleReporter implements JobReporter {
  async start(): Promise<void> {
    console.log("Working...");
  }
  async append(delta: string): Promise<void> {
    process.stdout.write(delta);
  }
  async succeed(output: string): Promise<void> {
    if (!output.endsWith("\n")) process.stdout.write("\n");
  }
  async fail(message: string): Promise<void> {
    console.error(message);
  }
}

export class AgentRunner {
  private readonly active = new Set<Promise<void>>();
  private readonly pendingDeliverySetup = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly authorization: AuthorizationPolicy,
    private readonly database: RunnerDatabase,
    private readonly executor: Executor,
    private readonly audit: AuditLogger,
    private readonly reporterFactory: ReporterFactory,
  ) {}

  async submit(submission: JobSubmission): Promise<SubmissionResult> {
    const decision = this.authorization.authorize(submission);
    if (!decision.authorized) {
      const rejection = new AuthorizationError(decision.reason);
      await this.audit.log(
        "job_rejected",
        { reason: rejection.code, integration: submission.integration, tenantId: submission.tenantId, conversationId: submission.conversationId },
        { userId: submission.actorId },
      );
      throw rejection;
    }
    const existing = this.database.getJobBySourceEvent(submission.integration, submission.sourceEventId);
    if (existing) return { job: existing, isNew: false };
    const prompt = submission.prompt.trim();
    if (!prompt) throw new LimitError("The prompt is empty.", "EMPTY_PROMPT");
    if (prompt.length > this.config.limits.maxPromptCharacters) {
      throw new LimitError("The prompt exceeds the configured character limit.", "PROMPT_LIMIT");
    }
    const attachments = submission.attachments ?? [];
    if (attachments.length > this.config.limits.maxAttachmentsPerJob) {
      throw new LimitError("The request exceeds the configured attachment count limit.", "ATTACHMENT_COUNT_LIMIT");
    }
    for (const attachment of attachments) {
      if (Buffer.byteLength(attachment.dataUrl, "utf8") > this.config.limits.maxAttachmentBytes) {
        throw new LimitError("An attachment exceeds the configured size limit.", "ATTACHMENT_SIZE_LIMIT");
      }
    }
    const normalized = { ...submission, prompt, attachments };
    const rejection = this.rejectionFor(normalized);
    if (rejection) {
      await this.audit.log(
        "job_rejected",
        { reason: rejection.code, integration: submission.integration, tenantId: submission.tenantId, conversationId: submission.conversationId },
        { userId: submission.actorId },
      );
      throw rejection;
    }
    let job: JobRecord;
    try {
      job = this.database.insertJob(randomUUID(), normalized);
    } catch (error) {
      // Another delivery of the same platform event may win between the lookup
      // above and the unique insert. Treat that race as the same deduplicated
      // submission rather than producing a second platform reply.
      const concurrent = this.database.getJobBySourceEvent(submission.integration, submission.sourceEventId);
      if (concurrent) return { job: concurrent, isNew: false };
      throw error;
    }
    let finishDeliverySetup!: () => void;
    const deliverySetup = new Promise<void>((resolve) => {
      finishDeliverySetup = resolve;
    });
    this.pendingDeliverySetup.set(job.id, deliverySetup);
    try {
      await this.audit.log(
        "job_queued",
        { prompt: contentMetadata(prompt), attachments: attachmentMetadata(attachments), integration: job.integration, tenantId: job.tenantId, conversationId: job.conversationId, threadId: job.threadId },
        this.context(job),
      );
      const reporter = await this.resolveReporter(job, "queued");
      if (reporter) {
        try {
          const started = await reporter.start();
          if (started?.replyTs) this.database.updateJobReplyTs(job.id, started.replyTs);
        } catch (error) {
          await this.auditDeliveryFailure(job, "queued", error);
        }
      }
    } finally {
      finishDeliverySetup();
      this.pendingDeliverySetup.delete(job.id);
    }
    queueMicrotask(() => this.pump());
    return { job: this.database.getJob(job.id)!, isNew: true };
  }

  async start(): Promise<void> {
    await this.maintenance();
    const interrupted = this.database.recoverInterruptedJobs(this.config.storage.retainJobContent);
    for (const job of interrupted) {
      await this.audit.log("job_interrupted", { reason: "runner_restart" }, this.context(job));
      const reporter = await this.resolveReporter(job, "interrupted");
      if (reporter) {
        await reporter
          .fail("This job was interrupted by an agent-runner restart. Please send the request again.")
          .catch((error: unknown) => this.auditDeliveryFailure(job, "interrupted", error));
      }
    }
    this.timer = setInterval(() => this.pump(), this.config.queue.pollIntervalMs);
    this.timer.unref();
    this.maintenanceTimer = setInterval(() => {
      void this.maintenance().catch((error: unknown) => console.error("Retention maintenance failed", error));
    }, 86_400_000);
    this.maintenanceTimer.unref();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    await Promise.allSettled([...this.active]);
    await this.audit.flush();
  }

  private rejectionFor(submission: JobSubmission): RunnerError | undefined {
    if (this.database.countJobs(submission.integration, submission.tenantId, submission.actorId, "queued") >= this.config.limits.maxQueuedJobsPerUser) {
      return new LimitError("Your queue is full. Wait for an existing job to finish.", "QUEUE_LIMIT");
    }
    if (this.database.dailyUsage(submission.integration, submission.tenantId, submission.actorId).cost >= this.config.limits.dailyCostCap) {
      return new LimitError("Your daily agent budget has been reached.", "DAILY_BUDGET");
    }
    return undefined;
  }

  private pump(): void {
    if (this.stopping) return;
    while (this.active.size < this.config.limits.maxConcurrentJobsGlobal) {
      const job = this.database.claimNextJob(
        this.config.limits.maxConcurrentJobsPerUser,
        this.config.limits.maxConcurrentJobsGlobal,
      );
      if (!job) return;
      const task = this.process(job)
        .catch((error: unknown) => console.error("Job processing failed unexpectedly", errorMetadata(error)))
        .finally(() => {
          this.active.delete(task);
          queueMicrotask(() => this.pump());
        });
      this.active.add(task);
    }
  }

  private async process(job: JobRecord): Promise<void> {
    await this.pendingDeliverySetup.get(job.id);
    job = this.database.getJob(job.id) ?? job;
    let reporter = await this.resolveReporter(job, "running");
    let retryTerminalDelivery = false;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new TimeoutError(`Job exceeded ${this.config.limits.jobTimeoutSeconds} seconds`)),
      this.config.limits.jobTimeoutSeconds * 1_000,
    );
    let output = "";
    let usage = emptyUsage();
    let succeeded = false;
    let failureForUser = "";
    let toolEventCount = 0;
    const costBeforeJob = this.database.dailyUsage(job.integration, job.tenantId, job.actorId).cost;

    try {
      const session = this.database.getSession(job.sessionKey);
      if (!session) throw new Error(`Missing session ${job.sessionKey}`);
      await this.audit.log("job_started", { prompt: contentMetadata(job.prompt) }, this.context(job));
      const result = await this.executor.execute(
        job,
        session,
        {
          onText: async (delta) => {
            const remaining = this.config.limits.maxOutputCharacters - output.length;
            if (remaining <= 0) {
              const limitError = new LimitError("The agent output exceeded the configured limit.", "OUTPUT_LIMIT");
              controller.abort(limitError);
              throw limitError;
            }
            const accepted = delta.slice(0, remaining);
            output += accepted;
            this.database.appendOutput(job.id, output);
            if (reporter) {
              try {
                await reporter.append(accepted);
              } catch (error) {
                await this.auditDeliveryFailure(job, "streaming", error);
                reporter = undefined;
                retryTerminalDelivery = true;
              }
            }
            if (accepted.length !== delta.length) {
              const limitError = new LimitError("The agent output exceeded the configured limit.", "OUTPUT_LIMIT");
              controller.abort(limitError);
              throw limitError;
            }
          },
          onTool: async (event) => {
            toolEventCount += 1;
            if (toolEventCount > this.config.limits.maxToolEventsPerJob) {
              const limitError = new LimitError("The agent exceeded the configured tool-event limit.", "TOOL_EVENT_LIMIT");
              controller.abort(limitError);
              throw limitError;
            }
            await this.audit.log("tool_event", toolMetadata(event), this.context(job));
          },
          onUsage: (current) => {
            usage = current;
            if (costBeforeJob + current.cost > this.config.limits.dailyCostCap && !controller.signal.aborted) {
              controller.abort(new LimitError("The daily budget was reached while this job was running.", "DAILY_BUDGET"));
            }
          },
        },
        controller.signal,
      );
      const resultOutput = result.output || output;
      if (resultOutput.length > this.config.limits.maxOutputCharacters) {
        output = resultOutput.slice(0, this.config.limits.maxOutputCharacters);
        throw new LimitError("The agent output exceeded the configured limit.", "OUTPUT_LIMIT");
      }
      output = resultOutput;
      usage = result.usage;
      this.database.updateSessionExecution(job.sessionKey, result.openCodeSessionId, result.workingDirectory);
      this.database.completeJob(job.id, "succeeded", output, null, usage, this.config.storage.retainJobContent);
      succeeded = true;
      await this.audit.log(
        "job_succeeded",
        { prompt: contentMetadata(job.prompt), output: contentMetadata(output), usage },
        this.context(job),
      ).catch((error: unknown) => console.error("Unable to record successful job audit", error));
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const timedOut = reason instanceof TimeoutError;
      failureForUser = userFacingFailure(reason, job.id);
      this.database.completeJob(
        job.id,
        timedOut ? "timed_out" : "failed",
        output,
        failureForUser,
        usage,
        this.config.storage.retainJobContent,
      );
      await this.audit.log(
        timedOut ? "job_timed_out" : "job_failed",
        { prompt: contentMetadata(job.prompt), output: contentMetadata(output), usage, ...errorMetadata(reason) },
        this.context(job),
      ).catch((auditError: unknown) => console.error("Unable to record failed job audit", auditError));
    } finally {
      clearTimeout(timeout);
    }

    if (!reporter && retryTerminalDelivery) {
      // A fresh adapter can still replace a stale Working message even when
      // its streaming instance failed. Re-read the job so the adapter sees
      // delivery context (such as a reply timestamp) persisted after submit.
      reporter = await this.resolveReporter(
        this.database.getJob(job.id) ?? job,
        succeeded ? "succeeded" : "failed",
      );
    }

    if (reporter) {
      try {
        if (succeeded) await reporter.succeed(output);
        else await reporter.fail(failureForUser);
      } catch (error) {
        await this.auditDeliveryFailure(job, succeeded ? "succeeded" : "failed", error);
      }
    }
  }

  private async resolveReporter(job: JobRecord, phase: string): Promise<JobReporter | undefined> {
    try {
      return this.reporterFactory(job);
    } catch (error) {
      await this.auditDeliveryFailure(job, phase, error);
      return undefined;
    }
  }

  private async auditDeliveryFailure(job: JobRecord, phase: string, error: unknown): Promise<void> {
    await this.audit.log(
      "delivery_failed",
      {
        phase,
        integration: job.integration,
        error: error instanceof Error ? error.message : String(error),
        ...errorMetadata(error),
      },
      this.context(job),
    ).catch((auditError: unknown) => console.error("Unable to record delivery failure", errorMetadata(auditError)));
  }

  private context(job: JobRecord): { jobId: string; userId: string; sessionKey: string } {
    return { jobId: job.id, userId: job.actorId, sessionKey: job.sessionKey };
  }

  private async maintenance(): Promise<void> {
    const expiredSessions = this.database.purgeExpired(this.config.storage.retentionDays);
    for (const session of expiredSessions) {
      try {
        await this.executor.cleanup?.(session);
        this.database.deleteSession(session.sessionKey);
      } catch (error) {
        await this.audit.log(
          "retention_cleanup_failed",
          { sessionKey: session.sessionKey, ...errorMetadata(error) },
          { sessionKey: session.sessionKey },
        );
      }
    }
    await this.audit.prune(this.config.storage.retentionDays);
  }
}
