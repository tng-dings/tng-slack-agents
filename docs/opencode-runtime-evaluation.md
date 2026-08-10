# OpenCode runtime evaluation and BBX comparison

## Purpose

This document records the August 2026 review of this project's OpenCode execution boundary against the neighboring `bbx` repository and tracks the resulting implementation phases. It is intended to be a self-contained implementation handoff for future development sessions.

The original review covered session lifecycle, workspace isolation, process supervision, cancellation, permissions, recovery, provider coupling, event normalization, and testing. The phase checklists and implementation notes below record the runtime changes made afterward.

## Executive conclusion

The current OpenCode integration is a sensible MVP design for the project's deliberate native-Windows deployment:

- Slack and Discord remain separated from the coding worker.
- OpenCode is authenticated and loopback-only.
- Integration credentials are excluded from the worker environment.
- The runner provides a durable queue, idempotent ingress, per-session serialization, limits, audit records, and platform-specific delivery.
- The worker applies a restrictive unattended-execution policy.

Phase 1 now persists execution resources before prompt submission, makes provisioning retryable, cancels active jobs during shutdown, and reconciles or quarantines interrupted remote turns before releasing a session. Phase 2 has added provider-neutral persistence and strict protocol/version gates. The service remains fail-closed until an operator validates and records a real OpenCode version, and the Phase 3 workspace-lifecycle work remains recommended before broader production use.

BBX has a materially more mature general-purpose agent runtime, but its OpenCode path uses the generic Agent Client Protocol (ACP) adapter and is not included in BBX's real-provider test matrix. BBX also supports Windows only through WSL2, while this project intentionally supports native Windows services, DPAPI, and Windows virtual service identities. Do not replace the runner wholesale with BBX.

## Current architecture

The execution flow is:

```text
Slack/Discord ingress
  -> durable inbound inbox
  -> normalized durable job
  -> per-session queue/concurrency policy
  -> OpenCodeExecutor
  -> authenticated loopback `opencode serve`
  -> detached Git worktree
  -> redacted and bounded platform delivery
```

Relevant implementation:

- `src/runner.ts` owns durable submission, queueing, limits, execution, audit, and delivery lifecycle.
- `src/opencode.ts` owns the OpenCode HTTP/SSE API integration.
- `src/workspace.ts` creates and removes detached Git worktrees.
- `src/database.ts` persists jobs, sessions, usage, inbound events, and audit events.
- `scripts/Start-OpenCode.ps1` starts the isolated worker and applies its runtime policy.

## What is already well designed

### Security and trust separation

- `openCode.baseUrl` is restricted to literal loopback HTTP endpoints.
- OpenCode requires Basic authentication.
- The gateway and worker use separate DPAPI bundles and Windows virtual identities.
- `Start-OpenCode.ps1` refuses Slack and Discord credentials in the worker bundle.
- Gateway Git subprocesses receive an allowlisted, secret-free environment.
- OpenCode automatic updates and plugins are disabled.
- External-directory access, web tools, subagents, skills, and interactive questions are denied.
- Unknown OpenCode tools require permission, and unexpected permission requests are rejected by the coordinator.

### Queue and integration boundary

- Authorized events are durably recorded before asynchronous work.
- Source-event keys and session keys are integration-namespaced.
- One session executes at most one job at a time.
- Queued work survives restart.
- Running work is marked failed instead of being silently replayed.
- Delivery failure is isolated from successful execution.
- Output, attachment, tool-event, timeout, concurrency, queue, and reported-cost limits are enforced.

### OpenCode request flow

- The executor subscribes to events before sending the message, avoiding an obvious lost-event race.
- The HTTP response is the authoritative final output and usage result; SSE is used for progress, tool metadata, and usage updates.
- Response and event buffers are bounded.
- Abort signals propagate to the OpenCode abort endpoint.
- Existing OpenCode sessions and worktrees are reused for conversation continuity.

## Original priority findings

The findings in this section describe the reviewed baseline and the target design. Their implementation status is recorded in the phase checklists below.

### P0: Execution resources are persisted only after a successful turn

`OpenCodeExecutor.execute()` prepares a worktree and creates or loads an OpenCode session before submitting the prompt. `AgentRunner.process()` persists `openCodeSessionId` and `workingDirectory` only after `execute()` returns successfully.

Current sequence:

```text
create/reuse worktree
  -> create/reuse OpenCode session
  -> run turn
  -> on success only: persist worktree and session IDs
```

Failure consequences during a first turn:

1. The worktree can exist on disk while SQLite still records no working directory.
2. The OpenCode session can exist while SQLite still records no provider session ID.
3. A retry derives the same worktree directory, finds it non-empty, and fails with "target already exists and is not a Git worktree".
4. The OpenCode session and worktree can become orphaned and escape retention cleanup.

Required change:

- Split resource provisioning from turn execution.
- Persist the resolved worktree immediately after creation/recovery.
- Persist the provider session immediately after creation/load and before posting the prompt.
- Make provisioning idempotent and independently recoverable.
- Represent provisioning failure separately from turn failure where useful.

A suitable interface direction is:

```ts
interface PreparedExecutionSession {
  providerId: string;
  providerSessionId: string;
  workingDirectory: string;
}

interface Executor {
  prepareSession(
    session: SessionRecord,
    signal: AbortSignal,
  ): Promise<PreparedExecutionSession>;

  executeTurn(
    job: JobRecord,
    session: PreparedExecutionSession,
    callbacks: ExecutionCallbacks,
    signal: AbortSignal,
  ): Promise<ExecutionResult>;
}
```

The database update must happen between `prepareSession()` and `executeTurn()`.

### P0: Restart recovery does not reconcile remote OpenCode execution

OpenCode runs as a separate long-lived Windows service. When AgentRunner restarts, it marks SQLite jobs that were `running` as failed and informs the platform. It does not abort or inspect the corresponding OpenCode session.

Unproven and unsafe cases:

- OpenCode may continue modifying the worktree after AgentRunner reports the job as interrupted.
- A later job may enter the same OpenCode session while the old turn is still settling.
- The provider conversation may contain a completed or partial turn that the runner recorded as failed.
- A clean HTTP client disconnect may or may not cancel server-side execution; the repository has no live compatibility test proving this behavior.

Required change:

- Persist enough active-execution state to identify the provider session and worktree before a turn starts.
- On startup, move interrupted jobs into a `reconciling` path or otherwise block their session queues.
- Call the OpenCode abort endpoint for every interrupted provider session.
- Verify that the session is idle, or wait for a bounded reconciliation timeout, before releasing the session for later jobs.
- Audit reconciliation attempts and outcomes.
- If OpenCode cannot prove idle state, quarantine the session and require a new provider session rather than reusing ambiguous context.

The invariant should be:

> A session cannot execute a new queued job until the runner has established that no previous remote turn is active.

### P0: Graceful shutdown waits but does not initiate cancellation

`AgentRunner.stop()` stops polling and waits for active jobs. It does not abort their controllers first. A service shutdown can therefore wait until the configured job timeout or until WinSW forcibly terminates the process.

Required change:

- Keep active job controllers in a map keyed by job ID.
- On graceful shutdown, abort them with a distinct shutdown reason.
- Wait for bounded OpenCode cancellation and job settlement.
- Preserve the existing rule that interrupted work is not silently replayed.

### P1: The executor seam still leaks OpenCode concepts

`SessionRecord` and `ExecutionResult` expose `openCodeSessionId`, so the generic `Executor` interface is not provider-neutral.

Recommended direction:

```ts
interface SessionRecord {
  providerId: string;
  providerSessionId: string | null;
  workingDirectory: string | null;
  // existing normalized integration identity fields
}
```

If provider-specific persisted state is later needed, store a versioned and strictly validated executor-state payload. Do not spread provider-specific optional columns through the orchestration core.

Migration requirements:

- Add provider-neutral columns additively.
- Backfill existing rows as `provider_id = 'opencode'`.
- Copy `opencode_session_id` to `provider_session_id`.
- Keep the migration idempotent and retain legacy columns for one compatibility milestone if needed.

### P1: OpenCode protocol compatibility is implicit

The adapter manually parses REST responses and SSE events with permissive object checks. It has no explicit protocol version negotiation or strict schemas, and the deployed OpenCode executable is not pinned by this repository. Disabling OpenCode auto-update reduces surprise but does not define a safe upgrade process.

Required change:

- Define strict schemas for every consumed response and event shape.
- Validate health, session, message, usage, tool, permission, and error payloads at the boundary.
- Record the tested OpenCode version range.
- Fail startup when the deployed version is outside the approved range unless an operator explicitly performs a compatibility validation.
- Add an upgrade runbook and compatibility smoke suite.
- Audit unknown event types and schema mismatches without logging prompt or secret content.

### P1: Workspace lifecycle is minimal

The current manager creates a detached worktree at the repository's current `HEAD`. It has no explicit provisioning state, named branch, setup hook, preservation workflow, or orphan sweep.

Recommended improvements:

- Track workspace lifecycle independently: `provisioning`, `ready`, `retiring`, `destroying`, `destroyed`, and `error`, or a smaller equivalent state machine.
- Use a named per-session branch when work is expected to be reviewed, pushed, or retained.
- Record the source commit and branch used for provisioning.
- Add an optional bounded, non-interactive setup hook.
- Add an explicit preserve/archive/delete workflow.
- Sweep hashed directories under the configured worktree root and reconcile them with SQLite.
- Never delete an unknown directory merely because its name resembles a managed worktree; verify Git metadata and database ownership first.

### P1: Provider events are only weakly normalized

The orchestration interface currently exposes text deltas, usage, and `unknown` tool events. BBX instead normalizes provider traffic into append-only typed events for turns, messages, reasoning, commands, tool calls, file changes, warnings, and errors.

Recommended improvement:

- Define a small provider-neutral event union for the events this product actually needs.
- Preserve stable IDs for turns and tool calls.
- Store bounded structured metadata rather than provider-shaped `unknown` objects.
- Keep platform delivery based on final redacted output; structured events are for audit, diagnostics, and future UX.

## BBX findings

The neighboring `bbx` repository separates a SQLite-backed server from host daemons that provision environments and supervise provider processes. Threads and environments have explicit lifecycle state machines and append-only events.

Its agent runtime supports two adapter shapes:

1. a direct provider protocol, such as `codex app-server`;
2. a bridge process around an SDK or protocol, including a generic ACP bridge.

BBX detects OpenCode as provider `acp-opencode` and launches it as:

```text
opencode acp
```

Useful BBX mechanisms:

- provider-neutral thread and provider-session identities;
- process supervision and fail-fast crash behavior;
- explicit start, resume, steer, stop, and shutdown operations;
- session-load fallback with a visible warning when provider history cannot be restored;
- typed provider-event normalization;
- permission modes and per-machine permission ceilings;
- bounded cancellation before process disposal;
- managed workspace lifecycle, setup scripts, diffs, and cleanup;
- fake-provider restart/recovery suites;
- real-provider concurrency, control, multi-turn, and workspace suites.

Important limitations:

- BBX's real-provider matrix covers Codex, Claude Code, and Pi, not OpenCode.
- OpenCode benefits from generic ACP unit/fake coverage but lacks equivalent live-provider evidence.
- ACP has no native session-fork operation in BBX.
- ACP permission enforcement is cooperative. Client-side file-write checks are not an OS sandbox and cannot constrain arbitrary subprocess behavior by themselves.
- BBX supports Windows only through WSL2. Native PowerShell, drive-letter paths, Windows services, and DPAPI are outside its product support boundary.
- `@bb/agent-runtime` is a workspace-internal package in a large monorepo, not an obvious small dependency for this runner.

## Architecture decision

For the next implementation milestone:

1. Keep the durable Slack/Discord gateway and queue in this repository.
2. Keep the current OpenCode HTTP/SSE executor while fixing lifecycle persistence and recovery.
3. Make the executor/session contract provider-neutral.
4. Evaluate OpenCode ACP behind the same executor seam only after lifecycle correctness is established.
5. Do not import or copy the entire BBX runtime.

If multi-provider orchestration becomes a concrete product requirement, evaluate a separate BBX-like worker service or provider-runtime process behind a narrow authenticated protocol. The ingress service should remain the owner of platform credentials, authorization, idempotency, user limits, and delivery.

## Implementation sequence

### Phase 1: Correctness and crash safety

- [x] Add a failing test for first-turn failure after worktree creation.
- [x] Add a failing test for first-turn failure after OpenCode session creation.
- [x] Split session/workspace preparation from turn execution.
- [x] Persist the working directory before creating or loading the provider session.
- [x] Persist the provider session before posting the prompt.
- [x] Make preparation idempotent after process restart.
- [x] Track active job controllers and cancel them during graceful shutdown.
- [x] Add startup reconciliation for interrupted provider sessions.
- [x] Block per-session queue release until reconciliation settles.
- [x] Add audit events for provisioning and reconciliation.

Acceptance criteria:

- A failed first turn can be retried without manually deleting a worktree or OpenCode session.
- A crash at every boundary between worktree creation, session creation, event subscription, message submission, and completion leaves recoverable database state.
- No new job starts in a session until a previous interrupted remote turn is confirmed stopped or the ambiguous provider session has been replaced.
- Graceful service shutdown cancels active work inside a bounded time.

Phase 1 implementation notes (completed August 2026):

- `OpenCodeExecutor` now separates `prepareSession()` from `executeTurn()`. Preparation reports the verified worktree to `AgentRunner`, which persists it before OpenCode session lookup or creation. The returned OpenCode session ID is then persisted before event subscription or prompt submission.
- Worktree preparation recovers the deterministic path only after verifying that it is a Git worktree owned by the configured source repository. OpenCode preparation uses a generation-derived title marker and the session-list API to recover a session whose create response was lost before SQLite could record its ID.
- The additive, idempotent migration adds `execution_generation` and `reconciliation_required` to `sessions`. Existing OpenCode, working-directory, job, integration, usage, and audit columns are retained. Quarantine clears only the ambiguous OpenCode session ID, increments the generation, and preserves the worktree and all existing data.
- Interrupted and failed turns durably require reconciliation. Queue claiming excludes those sessions until OpenCode abort succeeds and `/session/status` proves idle, or the old provider session is quarantined. The durable flag survives another runner restart.
- Graceful shutdown marks active sessions for reconciliation before aborting their controllers with `RUNNER_SHUTDOWN`, waits up to 10 seconds for settlement, and leaves the durable reconciliation flag in place if confirmation cannot finish.
- Provisioning, abort, reconciliation, quarantine, and bounded-shutdown outcomes are audited through the existing redacting and bounded audit logger.

Deferred assumptions and intentionally limited scope:

- Startup uses a parallel, bounded global reconciliation barrier before queue polling starts. This is stricter than releasing unrelated sessions individually and keeps startup behavior simple; per-session progressive release can be considered later without changing the durable invariant.
- OpenCode reconciliation has a five-second bound. After a successful abort, an absent `/session/status` entry or an explicit `idle` entry is treated as idle; `busy`, `retry`, malformed data, transport failure, or timeout causes quarantine. This follows the current OpenCode status-map behavior and fails closed when idle cannot be established.
- If delayed OpenCode session-list visibility ever creates multiple sessions with the same ownership marker, the newest matching session is recovered and older sessions are preserved. Safe orphan discovery and cleanup remain Phase 3 work; Phase 1 performs no destructive orphan sweep.
- The legacy monolithic `Executor.execute()` branch was retained during Phase 1 and removed in Phase 2. All executors now implement the split preparation/turn contract.
- Workspace lifecycle expansion and ACP remain deferred to their documented later phases.

### Phase 2: Provider-neutral persistence and strict contracts

- [x] Add `provider_id` and `provider_session_id` with an idempotent migration.
- [x] Remove OpenCode naming from generic runner types.
- [x] Add strict response and event schemas.
- [x] Add explicit unknown-event and schema-mismatch audit records.
- [ ] Record and enforce an approved OpenCode version range.
- [x] Document the OpenCode upgrade/rollback procedure.

Acceptance criteria:

- The generic runner does not import OpenCode configuration or expose OpenCode-specific persisted fields.
- A protocol incompatibility fails clearly before user work is accepted.
- Existing databases upgrade without deletion or session-key changes.

Phase 2 implementation notes (August 2026):

- The additive migration introduces `provider_id` and `provider_session_id`, backfills existing rows as OpenCode, and preserves `opencode_session_id`. OpenCode writes temporarily update both identities so a database remains readable by the preceding compatibility milestone. No existing data or session keys are deleted.
- `SessionRecord`, `PreparedExecutionSession`, `Executor`, and `AgentRunner` now use only provider-neutral identities. OpenCode-specific names remain inside the OpenCode adapter and the retained legacy database column.
- Every REST response used by the adapter and every SSE event shape consumed by it is validated at the boundary. Known malformed payloads fail the turn with `OPENCODE_SCHEMA_MISMATCH`; unknown event types are ignored after a bounded, type-only audit record.
- Schema-mismatch audit records contain the schema name, event type when available, top-level payload type, and bounded key names only. They do not serialize payload values, prompts, or provider error content.
- Startup now checks the authenticated health schema and exact OpenCode version before starting the durable runner or either gateway. `doctor` applies the same check. An empty or non-matching `openCode.approvedVersions` list fails closed, and there is no wildcard override.
- The upgrade and rollback procedure is documented in `docs/opencode-upgrade-runbook.md`, including live native-Windows compatibility, restart reconciliation, secret-boundary, audit-redaction, and rollback checks.

Deferred operator validation:

- No OpenCode executable is installed in this development environment, so no real version can honestly be recorded as approved and the version-range checkbox remains open. The implementation deliberately uses an exact-version allowlist, a conservative form of an approved range for a protocol without version negotiation. An operator must validate a candidate with the runbook, add its exact health-response version to `openCode.approvedVersions`, and run `doctor` and `smoke` against the live service before enabling gateways.
- The provider-neutral migration and strict-contract work do not start the ACP experiment or introduce provider-specific state blobs. The legacy OpenCode column is retained only for rollback compatibility and can be considered for removal after a later compatibility milestone.

### Phase 3: Workspace maturity

- [ ] Introduce explicit workspace lifecycle state.
- [ ] Decide detached worktree versus named branch as a product behavior.
- [ ] Add source-revision metadata.
- [ ] Add a bounded non-interactive setup hook if real repositories require it.
- [ ] Add safe orphan discovery and reconciliation.
- [ ] Add preserve/archive/delete behavior and tests.

Acceptance criteria:

- Every managed worktree is owned by a database environment/session record or reported as a recoverable orphan.
- Provisioning errors are visible and retryable.
- Cleanup cannot escape the configured root or delete an unverified directory.

### Phase 4: OpenCode ACP experiment

Implement an `OpenCodeAcpExecutor` as an alternative executor, not a replacement, and run a native-Windows compatibility matrix.

- [ ] Detect and launch `opencode acp` without a shell command string.
- [ ] Validate ACP initialization and capabilities.
- [ ] Test session start, load, and multi-turn continuity.
- [ ] Test model and reasoning selection.
- [ ] Test image attachment input.
- [ ] Test permission requests in unattended deny and approved modes.
- [ ] Test timeout, cancellation, and graceful shutdown.
- [ ] Test runner crash, agent-process crash, and restart reconciliation.
- [ ] Test usage and cost reporting.
- [ ] Test concurrent independent sessions and per-session serialization.
- [ ] Test the same Windows service identity and secret-separation boundary used in production.

Decision rule:

- Prefer ACP if it passes the live matrix, provides reliable cancellation and session loading, and reduces version-specific adapter code.
- Retain HTTP/SSE if ACP is unstable on native Windows, loses required usage/attachment behavior, or weakens the worker security boundary.

## Tests that should be added first

The existing OpenCode executor tests cover image parts and a successful worktree/session/SSE flow. Add focused tests for:

1. worktree created, session creation fails;
2. worktree and session created, message request fails;
3. event subscription succeeds, then message times out;
4. first turn fails, second turn reuses persisted resources;
5. runner crashes while the OpenCode turn remains active;
6. startup abort succeeds and the next queued turn runs;
7. startup abort fails and the session remains quarantined;
8. OpenCode session returns 404 and replacement identity is persisted before execution;
9. malformed or changed OpenCode response/event schema;
10. graceful shutdown cancellation;
11. orphan worktree discovery without destructive cleanup;
12. OpenCode version outside the approved compatibility range.

## New-session starting point

For a new coding session, start with:

> Implement Phase 1 from `docs/opencode-runtime-evaluation.md`. Begin by adding regression tests for a first-turn failure after worktree/session provisioning and for restart reconciliation of an active OpenCode session. Preserve the existing durable queue, Slack/Discord behavior, database migrations, and security boundary.

Before editing, re-run:

```powershell
npm run check
npm test
npm run security:audit
```

After each lifecycle change, verify both the focused regression tests and the full suite.
