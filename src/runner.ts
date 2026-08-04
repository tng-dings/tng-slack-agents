import { randomUUID } from "node:crypto";
import type { AuditLogger } from "./audit.js";
import type { RunnerConfig } from "./config.js";
import type { RunnerDatabase } from "./database.js";
import { AuthorizationError, LimitError, RunnerError, TimeoutError } from "./errors.js";
import type {
  Executor,
  JobRecord,
  JobReporter,
  JobSubmission,
  ReporterFactory,
  Usage,
} from "./types.js";

const emptyUsage = (): Usage => ({ cost: 0, inputTokens: 0, outputTokens: 0 });

export class ConsoleReporter implements JobReporter {
  async start(): Promise<void> {
    console.log("Working…");
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
  private readonly allowedUsers: Set<string>;
  private readonly active = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly database: RunnerDatabase,
    private readonly executor: Executor,
    private readonly audit: AuditLogger,
    private readonly reporterFactory: ReporterFactory = () => new ConsoleReporter(),
  ) {
    this.allowedUsers = new Set(config.slack.allowedUserIds);
  }

  async submit(submission: JobSubmission): Promise<JobRecord> {
    const existing = this.database.getJobBySourceEvent(submission.sourceEventId);
    if (existing) return existing;
    const prompt = submission.prompt.trim();
    if (!prompt) throw new LimitError("The prompt is empty.", "EMPTY_PROMPT");
    const normalized = { ...submission, prompt };
    const rejection = this.rejectionFor(normalized);
    if (rejection) {
      const rejected = this.database.insertJob(randomUUID(), normalized, "rejected", rejection.message);
      await this.audit.log("job_rejected", { prompt, reason: rejection.code }, this.context(rejected));
      throw rejection;
    }
    const job = this.database.insertJob(randomUUID(), normalized);
    await this.audit.log(
      "job_queued",
      { prompt, workspaceId: job.workspaceId, channelId: job.channelId, threadTs: job.threadTs },
      this.context(job),
    );
    queueMicrotask(() => this.pump());
    return job;
  }

  async start(): Promise<void> {
    const interrupted = this.database.recoverInterruptedJobs();
    for (const job of interrupted) {
      await this.audit.log("job_interrupted", { reason: "runner_restart" }, this.context(job));
      await this.reporterFactory(job).fail("This job was interrupted by an agent-runner restart. Please send the request again.").catch(() => undefined);
    }
    this.timer = setInterval(() => this.pump(), this.config.queue.pollIntervalMs);
    this.timer.unref();
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.active]);
    await this.audit.flush();
  }

  private rejectionFor(submission: JobSubmission): RunnerError | undefined {
    if (!this.allowedUsers.has(submission.userId)) return new AuthorizationError();
    if (this.database.countJobs(submission.userId, "queued") >= this.config.limits.maxQueuedJobsPerUser) {
      return new LimitError("Your queue is full. Wait for an existing job to finish.", "QUEUE_LIMIT");
    }
    if (this.database.dailyUsage(submission.userId).cost >= this.config.limits.dailyCostCap) {
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
      const task = this.process(job).finally(() => {
        this.active.delete(task);
        queueMicrotask(() => this.pump());
      });
      this.active.add(task);
    }
  }

  private async process(job: JobRecord): Promise<void> {
    const reporter = this.reporterFactory(job);
    const session = this.database.getSession(job.sessionKey);
    if (!session) throw new Error(`Missing session ${job.sessionKey}`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new TimeoutError(`Job exceeded ${this.config.limits.jobTimeoutSeconds} seconds`)),
      this.config.limits.jobTimeoutSeconds * 1_000,
    );
    let output = "";
    let usage = emptyUsage();
    const costBeforeJob = this.database.dailyUsage(job.userId).cost;

    try {
      await reporter.start();
      await this.audit.log("job_started", { prompt: job.prompt }, this.context(job));
      const result = await this.executor.execute(
        job,
        session,
        {
          onText: async (delta) => {
            output += delta;
            this.database.appendOutput(job.id, output);
            await reporter.append(delta);
          },
          onTool: async (event) => {
            await this.audit.log("tool_event", event, this.context(job));
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
      output = result.output || output;
      usage = result.usage;
      this.database.updateSessionExecution(job.sessionKey, result.openCodeSessionId, result.workingDirectory);
      this.database.completeJob(job.id, "succeeded", output, null, usage);
      await this.audit.log("job_succeeded", { prompt: job.prompt, output, usage }, this.context(job));
      await reporter.succeed(output);
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      const timedOut = reason instanceof TimeoutError;
      const message = reason instanceof Error ? reason.message : String(reason);
      this.database.completeJob(job.id, timedOut ? "timed_out" : "failed", output, message, usage);
      await this.audit.log(
        timedOut ? "job_timed_out" : "job_failed",
        { prompt: job.prompt, output, usage, error: message },
        this.context(job),
      );
      await reporter.fail(message).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
    }
  }

  private context(job: JobRecord): { jobId: string; userId: string; sessionKey: string } {
    return { jobId: job.id, userId: job.userId, sessionKey: job.sessionKey };
  }
}
