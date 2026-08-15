# Integration, HTTPS ingress, and cloud roadmap

This backlog evolves the current Slack Socket Mode MVP into a transport-independent orchestration service. The first delivery target is Slack with a configurable Socket Mode or Events API HTTPS ingress. Discord and a distributed AWS architecture follow only after that boundary is proven.

The work is intentionally phased. Do not combine the initial HTTPS milestone with a generic plugin system, Discord support, or a serverless rewrite.

## Agreed direction

Treat these as independent axes:

1. **Platform integration:** Slack, Discord, or a future platform.
2. **Ingress transport:** Slack Socket Mode, Slack Events API over HTTPS, Discord Gateway, or Discord interactions over HTTPS.
3. **Runtime:** local Windows service, a single cloud host/task, or eventually distributed cloud services.

“Webhook” is not an integration type. For Slack, inbound user messages arrive through the **Events API**; Slack incoming webhooks are outbound-only and are not a replacement for the bot-token Web API. Socket Mode remains a supported deployment option rather than being treated as test-only.

The intended first configuration shape is conceptually:

```json
{
  "integrations": {
    "slack": {
      "enabled": true,
      "ingress": "socket"
    }
  }
}
```

or `"ingress": "events-api"`. Exact names may follow existing configuration conventions, but platform and transport must remain separate concepts.

## Current baseline

Milestone 1 is complete. The service now has an integration-aware orchestration boundary while preserving the existing Slack Socket Mode behavior:

The OpenCode execution boundary and its comparison with BBX are documented in [`docs/opencode-runtime-evaluation.md`](../docs/opencode-runtime-evaluation.md). Phase 1 lifecycle/crash safety and the repository-side Phase 2 provider-neutral/strict-contract work are complete. Live version approval and the later workspace-lifecycle work remain open as recorded below.

- [`src/slack.ts`](../src/slack.ts) selects either the Socket Mode or Events API ingress while sharing Slack behavior from [`src/slack/normalization.ts`](../src/slack/normalization.ts), [`src/slack/adapter.ts`](../src/slack/adapter.ts), and [`src/slack/delivery.ts`](../src/slack/delivery.ts).
- [`src/runner.ts`](../src/runner.ts) owns durable submission, limits, queueing, execution, and delivery lifecycle. Authorization and reporter selection are injected; the runner does not read Slack configuration or choose a Slack reporter.
- [`src/types.ts`](../src/types.ts) defines normalized integration, tenant, conversation, thread, actor, and source-event identities alongside the existing executor and reporter seams.
- [`src/database.ts`](../src/database.ts) persists normalized identities and integration-namespaced source-event/session keys. Its additive, idempotent migration backfills existing rows as Slack records and retains legacy Slack columns for compatibility during this milestone. A durable inbound-event inbox now separates HTTP acceptance from attachment retrieval and job submission.
- [`src/integrations.ts`](../src/integrations.ts) routes delivery using the integration persisted on each job. Missing integrations fail closed and are audited; console delivery must be explicitly registered for local or smoke usage.
- [`src/index.ts`](../src/index.ts) composes the integration-aware policy and reporter registry and starts exactly one configured Slack ingress: `socket` or `events-api`. The Events API path uses Bolt's signature-verifying `HTTPReceiver` and commits authorized events before releasing the HTTP acknowledgement.
- [`src/opencode.ts`](../src/opencode.ts) still requires a loopback OpenCode server and local worktree path. Replacing that runtime boundary is not required for Slack HTTPS ingress.

The durable queue and executor remain the foundation. The remaining HTTPS work is production-edge hardening and deployment evidence rather than another orchestration path.

## OpenCode runtime handoff

Completed in the August 2026 runtime-hardening milestone:

- [x] Persist the verified worktree and provider session before prompt submission, with idempotent recovery after failures and restarts.
- [x] Cancel claimed jobs during bounded graceful shutdown, reconcile only turns that reached the provider, and keep affected queues blocked until the old provider session is stopped and retired.
- [x] Add provider-neutral `provider_id` and `provider_session_id` persistence while retaining and dual-writing the legacy OpenCode column for rollback compatibility.
- [x] Remove OpenCode-specific identities and the legacy monolithic executor path from the generic runner contract.
- [x] Strictly validate every consumed OpenCode REST response and SSE event, with bounded value-free audits for schema mismatches and unknown event types.
- [x] Fail startup and `doctor` unless the authenticated health response reports an exact configured version, and document upgrade/rollback in [`docs/opencode-upgrade-runbook.md`](../docs/opencode-upgrade-runbook.md).

Next operator-assisted validation (do not enable Slack or Discord gateways until these are complete):

- [ ] Configure a model provider for the Windows identity that will run OpenCode. Interactive development can use `opencode` followed by `/connect`; the service identity must ultimately receive its separately scoped provider credential through the worker secret bundle.
- [ ] Create the ignored `config.json` from `config.example.json` and point `openCode.workingRepository` at a disposable Git repository. No `config.json` existed when this handoff was written.
- [ ] Validate the installed native-Windows candidate with the full matrix in the upgrade runbook. Current candidate: Scoop `main/opencode` version `1.18.15`, shim `C:\Users\Simon\scoop\shims\opencode.exe`, x64 archive SHA-256 `A80785874978CCBB93B7BFE4345F5AED41696F5AE76C109CD6DBBB934DBE795D`, installed executable SHA-256 `FD254474DEF7EE35F07416CF4674C361F07E7BCD9C7FFB284AF21BB011066EE3`.
- [ ] Only after that matrix passes, add `"1.18.15"` to `openCode.approvedVersions`, start the authenticated loopback server, and run `npm run doctor` followed by `npm run smoke`.
- [ ] Record the live results and check the remaining Phase 2 version-approval box in the runtime evaluation. A schema mismatch, unknown event, cancellation/reconciliation failure, or redaction leak blocks approval.
- [ ] Before installing Windows services, write the resolved versioned `opencode.exe` path to `%ProgramData%\OpenCodeWorker\opencode-path.txt`, provision the separated DPAPI bundles, and rerun the security validation described in the README/security review.

Repository follow-up after live approval:

- [x] Use a deterministic named branch for each session, reattach it after clean worktree retention, and preserve dirty worktrees and all local branches.
- [ ] Continue the remaining Phase 3 workspace maturity work only when needed: explicit lifecycle state, source revision metadata, bounded setup, safe orphan discovery, and preserve/archive/delete behavior.
- [ ] Implement authenticated [Slack agent commands](slack-agent-commands.md) for explicit workspace inspection and cleanup.
- [ ] Retain `opencode_session_id` for at least one compatibility milestone; remove it only through a later reviewed additive migration after rollback compatibility is no longer required.
- [ ] Begin the Phase 4 ACP experiment only after lifecycle correctness and the native HTTP/SSE compatibility baseline are proven. Keep it behind the provider-neutral executor seam rather than replacing the durable gateway/queue.

## Target boundary

```text
Slack Socket Mode -----\
                        -> Slack event normalization --\
Slack Events API ------/                               \
                                                         -> AgentRunner -> Executor
Discord interactions -> Discord event normalization ----/       |
                                                                v
                                                   integration-routed delivery
```

### Ingress transport

Receives and authenticates platform requests or connections, then hands a platform event to its platform adapter. Examples are `SlackSocketIngress`, `SlackHttpIngress`, and later `DiscordInteractionsIngress`.

### Platform adapter

Owns platform event parsing, platform-specific authorization inputs, attachment retrieval, normalization, denial behavior, and result delivery. Both Slack transports must share the same event normalization and Slack delivery implementation.

### Orchestration core

Owns generic queue limits, idempotency, session serialization, execution, audit, and delivery lifecycle. It must not read `config.slack` or assume that every destination is a Slack thread.

### Normalized identity

Jobs and sessions need, at minimum, equivalents of:

```ts
type IntegrationId = "slack" | "discord";

interface NormalizedSubmission {
  integration: IntegrationId;
  sourceEventId: string;
  tenantId: string;
  conversationId: string;
  threadId: string;
  actorId: string;
  prompt: string;
  attachments?: Attachment[];
  replyContext?: unknown;
}
```

Names can change during implementation, but the persisted integration discriminator and normalized identity cannot be omitted. Any persisted reply context must be constructed and validated by a trusted platform adapter; never accept an arbitrary callback URL from an inbound payload.

Keys must be integration-namespaced:

- source event: `slack:<event_id>`
- Slack session: `slack:<workspace>:<channel>:<thread>`
- Discord source event: `discord:<interaction_id>`
- Discord session: `discord:<application-or-guild>:<channel>:<thread-or-interaction>`

## Invariants to preserve

- Authorization happens before job execution and before an unauthorized request is persisted as a job.
- Platform request authenticity is established before parsing or enqueueing trusted work.
- Source-event deduplication prevents retries from creating duplicate jobs or replies.
- One conversation session executes at most one job at a time.
- Queued work survives coordinator restarts; active work is not silently replayed.
- Delivery failure is audited and cannot change a successful execution into a failed execution.
- Prompt, attachment, output, tool-event, queue, concurrency, timeout, and cost limits remain enforced.
- Slack and future Discord credentials do not enter the OpenCode worker environment.
- Completed output is redacted and bounded before platform delivery.
- Existing Socket Mode behavior remains available throughout the HTTPS work.

## Milestone 1 — Establish the integration seam

This milestone should preserve user-visible behavior. Complete its contracts before agents begin work that depends on them.

### M1-A: Normalize and persist platform identity

**Primary files:** `src/types.ts`, `src/database.ts`, database-focused tests.

- [x] Add a persisted integration discriminator to jobs and sessions.
- [x] Replace Slack-only identity assumptions with normalized tenant, conversation, thread, and actor concepts at the orchestration boundary.
- [x] Namespace source-event and session keys by integration.
- [x] Add an additive SQLite migration/backfill for existing Slack rows; do not require operators to delete their database.
- [x] Keep migration startup idempotent and test upgrading an existing-schema fixture.
- [x] Ensure duplicate source events remain atomic after namespacing.

**Acceptance criteria**

- Existing Slack jobs and sessions are read as Slack records after migration.
- Two integrations can use the same external event ID without colliding.
- Two integrations with equivalent tenant/channel/thread strings do not share a session.
- Existing per-session serialization tests still pass using normalized identities.

### M1-B: Remove Slack policy from the runner

**Primary files:** `src/runner.ts`, `src/config.ts`, runner/config tests.

- [x] Define an integration-aware authorization policy at the submission boundary.
- [x] Keep defense in depth: the platform adapter may reject early, but the orchestration submission boundary must still enforce the configured policy.
- [x] Stop `AgentRunner` from reading `config.slack.allowedWorkspaceIds` and `allowedUserIds` directly.
- [x] Apply queue, daily budget, and concurrency limits against normalized actor identity. Include integration/tenant in keys where cross-platform collisions would be incorrect.
- [x] Reshape configuration without silently weakening current Slack allowlist validation.

**Acceptance criteria**

- The generic runner has no Slack-specific configuration access.
- Unauthorized normalized submissions cannot create jobs.
- Identically named users from different integrations are not accidentally treated as one principal.

### M1-C: Separate Slack transport, normalization, and delivery

**Primary files:** `src/slack.ts` and, only if separation materially improves ownership, a small number of `src/slack/` modules.

- [x] Extract Slack event normalization so Socket Mode and HTTPS use exactly the same DM, subtype, prompt, thread, workspace, and attachment rules.
- [x] Keep Slack attachment limits and authenticated downloads in the Slack adapter.
- [x] Keep `SlackJobReporter` as the Slack delivery implementation.
- [x] Preserve app-home suggested prompts for both Slack ingress modes where Slack supports them.
- [x] Keep unauthorized denial throttling platform-local.
- [x] Do not introduce a dynamic plugin loader or registration framework.

**Acceptance criteria**

- Socket Mode acceptance behavior is unchanged.
- Event normalization can be tested without opening a WebSocket or calling Slack.
- Slack delivery can be created independently of the ingress transport.

### M1-D: Route delivery by persisted integration

**Primary files:** `src/index.ts`, integration registry/composition code, reporter-routing tests.

- [x] Replace the single optional Slack reporter selection with integration-aware routing based on the persisted job.
- [x] Fail closed and audit a clear delivery error if no adapter exists for a persisted integration.
- [x] Ensure restart recovery selects the original integration's reporter.
- [x] Keep console reporting available for explicit local/smoke usage rather than as an accidental fallback for unknown integrations.

**Acceptance criteria**

- A Slack job always uses Slack delivery after restart.
- Unknown integrations never leak output to stdout as a silent fallback.

## Milestone 2 — Slack Events API over HTTPS

Depends on Milestone 1. Only one Slack ingress transport should be enabled in a process at a time; intentionally running both would receive duplicate Slack events and is not an MVP requirement.

### M2 security and framework decision

Use Slack Bolt's built-in `HTTPReceiver`, backed by Node's native HTTP server, for the Slack Events API endpoint. Do not add Express, Fastify, or NestJS for this milestone. Bolt is already a direct dependency and owns the Slack-specific raw-body verification and acknowledgement lifecycle. Reconsider Fastify only if the process later becomes a shared HTTP gateway for multiple platforms and operational APIs.

Bolt's receiver is the application-authentication layer, not the entire public-edge security boundary. With signature verification enabled, it buffers the original body, validates `X-Slack-Signature` using the app signing secret, enforces request timestamp freshness, performs a timing-resistant signature comparison, and handles Slack URL verification. This is sufficient to authenticate Slack requests when used as documented, but it does not provide complete denial-of-service, request-size, TLS, or application-authorization controls.

The production request path must be:

```text
Internet
  -> managed TLS endpoint / reverse proxy
  -> edge request limits and rate controls
  -> private Slack Bolt HTTPReceiver
  -> workspace/user/event authorization
  -> durable event deduplication and orchestration
```

References:

- [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack)
- [Slack Events API acknowledgement and retry behavior](https://docs.slack.dev/apis/events-api/)

### M2-A: HTTPS receiver and authenticity

**Primary files:** Slack ingress/composition code, configuration/secrets, HTTP ingress tests.

- [x] Add the Slack Events API receiver using Slack Bolt's supported HTTP receiver unless a concrete limitation requires a custom server.
- [x] Verify Slack signatures against the unmodified raw request body and `SLACK_SIGNING_SECRET`.
- [x] Enforce Slack's request timestamp freshness/replay protection through the receiver or explicit validation.
- [x] Keep Bolt signature verification explicitly enabled in production; never disable it merely because a load balancer or reverse proxy is present.
- [x] Validate the expected Slack app ID, workspace, user, event type, DM context, and bot/subtype rules after request authentication. A valid Slack signature proves origin, not user authorization.
- [x] Support Slack URL-verification challenges.
- [x] Expose a dedicated health endpoint that does not reveal configuration or secret state.
- [x] Configure host/port/path explicitly for reverse-proxy or load-balancer deployment.
- [x] Do not log request bodies, signatures, tokens, prompts, or attachment contents.

**Acceptance criteria**

- Valid signed events are accepted.
- Invalid signatures and stale requests are rejected without enqueueing work.
- URL verification succeeds.
- Health checks work without Slack credentials in the request.

### M2-B: Fast acknowledgement, retries, and deduplication

**Primary files:** Slack HTTPS ingress, submission lifecycle if needed, tests.

- [x] Ensure Slack receives an acknowledgement inside its deadline without waiting for OpenCode, attachment downloads, result delivery, or a Slack `Working…` API call.
- [x] Verify the selected Bolt receiver's acknowledgement behavior with an intentionally delayed downstream processor test; do not assume it. The request listener itself is intentionally limited to validation and the inbox commit.
- [x] Preserve durable `event_id` deduplication and namespace it as Slack.
- [x] Test duplicate and retry headers, including a retry arriving while the original event is still processing.
- [x] Commit authorized events to a durable inbound-event inbox before acknowledgement. Recover interrupted inbox work after restart and rely on namespaced job insertion for idempotent handoff.

**Acceptance criteria**

- A deliberately slow downstream event processor still receives a timely HTTP acknowledgement after the inbox commit.
- Multiple deliveries of one Slack event create one job and at most one `Working…` reply.
- The documented durability guarantee matches the implementation.

### M2-C: Configuration, manifest, and operator documentation

**Primary files:** `config.example.json`, `slack/manifest.json`, `README.md`, `docs/`.

- [x] Make `SLACK_APP_TOKEN` mandatory only for Socket Mode.
- [x] Make `SLACK_SIGNING_SECRET` mandatory only for Events API mode.
- [x] Update the Slack manifest for HTTPS deployment or provide separate clearly named manifests if one manifest cannot safely represent both modes.
- [x] Document Request URL setup, TLS/reverse-proxy expectations, health checking, and local testing.
- [x] Update the security model: HTTPS adds a public trust boundary that Socket Mode intentionally avoids.
- [x] Add signature failure, replay, rate limiting, request-size, and denial-of-service considerations to the security review.
- [x] Preserve the existing Socket Mode administrator/testing path.

**Milestone 2 exit criteria**

- `socket` and `events-api` each pass the same normalized Slack message acceptance suite.
- HTTPS signature, timestamp, challenge, retry, and fast-ack tests pass without live Slack credentials.
- Socket Mode still passes its existing tests and manual run path.
- Documentation makes clear that Slack incoming webhooks are not used for inbound events.

### M2-D: Public endpoint hardening

**Primary files:** deployment configuration, HTTP ingress tests, security and operator documentation.

- [x] Terminate TLS at a managed load balancer or hardened reverse proxy; do not directly expose the Node receiver to the internet.
- [x] Make the Bolt service reachable only from that trusted edge component.
- [x] Publicly route only `POST /slack/events` and a minimal health endpoint. Return no configuration, dependency, credential, or detailed failure data from health checks.
- [x] Enforce request-body, header, connection, and request-time limits before Bolt buffers the body. Slack event payloads contain file metadata rather than attachment binaries, so determine a small bound from representative payload tests.
- [x] Add edge rate limiting and, for AWS, evaluate AWS WAF rules for malformed/flood traffic. Slack signatures remain the source-authentication mechanism; do not depend on source IP allowlisting as a substitute.
- [x] Keep system time synchronized because request freshness validation depends on it.
- [x] Store the signing secret in the existing protected bundle or cloud secret manager, exclude it from logs and OpenCode's environment, and document rotation.
- [x] Ensure rejected signatures and malformed requests cannot cause unbounded log volume or leak request bodies, signatures, prompts, tokens, or attachment metadata.
- [x] Keep Node and `@slack/bolt` on supported, patched versions and include them in dependency-vulnerability monitoring.
- [x] Test valid signatures, invalid signatures, stale timestamps, malformed JSON, wrong methods/paths, oversized bodies, slow requests, duplicate events, retry headers, and unauthorized but validly signed workspace/user events.

M2-D implementation is complete through the reviewed NGINX configuration, loopback-only and bounded private receiver, privacy-preserving rejection logger, dependency monitoring, automated tests, and operator runbook. Production acceptance still requires the deployment-specific TLS, firewall/reachability, NTP, external traffic, and log-search evidence in `docs/public-endpoint-hardening.md`; repository tests cannot manufacture that evidence.

**Acceptance criteria**

- The internet cannot directly address the Node receiver in the production topology.
- Oversized and rate-limited traffic is rejected before Bolt buffers or processes it.
- Invalid or stale requests create no jobs and produce no Slack API calls.
- Validly signed but unauthorized events create no jobs.
- Duplicate valid events create one job and at most one initial reply.
- Edge and application logs contain no request bodies or secret material.

## Milestone 3 — Single-node AWS lift

Do this before replacing SQLite or distributing workers. The goal is to move the proven process boundary into AWS with minimal semantic change.

### Recommended first topology

- [ ] Run one coordinator/OpenCode deployment on EC2 or ECS-on-EC2.
- [ ] Terminate public HTTPS at an Application Load Balancer and route only the Slack Events API and health paths.
- [ ] Keep coordinator-to-OpenCode traffic on loopback or an equivalently private same-task/host boundary.
- [ ] Use encrypted EBS for SQLite, audit data, repository data, and worktrees.
- [ ] Inject container/process-specific credentials from AWS Secrets Manager without exposing Slack credentials to OpenCode.
- [ ] Apply separate IAM roles/security identities to ingress/coordinator and execution components where the runtime permits it.
- [ ] Restrict inbound security groups to the load balancer and restrict worker outbound access according to the approved provider/repository needs.
- [ ] Add backups, restore rehearsal, log shipping, alarms, and a documented rollback procedure.
- [ ] Keep desired task/instance count at one while SQLite and local OpenCode sessions are authoritative.

### Explicit non-goals for the first AWS lift

- Lambda execution of coding jobs.
- Horizontal coordinator scaling over a shared SQLite database.
- SQLite WAL on EFS as a substitute for a transactional shared database.
- Automatic replay of interrupted coding jobs.
- SQS, DynamoDB, or PostgreSQL migration without a demonstrated availability or scaling need.

**Milestone 3 exit criteria**

- A signed Slack HTTPS event completes end-to-end through the AWS-hosted service.
- Restart, queued-job survival, interrupted-job failure, retention, and backup/restore behavior are demonstrated.
- Slack and provider secrets remain separated.
- The deployment has no unsupported multi-writer SQLite topology.

## Milestone 4 — Discord Gateway conversations

The first HTTPS-only slash-command implementation proved the integration boundary. The selected product flow now uses the Discord Gateway: `/agent` in a normal channel creates an owned public thread, and ordinary owner messages in that registered thread continue the same session.

- [x] Define the product interaction: slash command shape, allowed guilds/users, thread/session behavior, attachments, and response visibility.
- [x] Verify Discord interaction signatures before normalization.
- [x] Defer/acknowledge interactions within Discord's deadline.
- [x] Normalize application/guild, channel, thread, and actor identities.
- [x] Namespace Discord event and session keys.
- [x] Implement Discord-specific delivery and output limits.
- [x] Handle interaction-token lifetime explicitly; long-running jobs may require follow-up messages through bot credentials rather than the original callback token.
- [x] Add Discord allowlist, replay, duplicate, authorization, and delivery tests.
- [x] Confirm Slack and Discord jobs can coexist without identity, session, or reporter collisions.
- [x] Add outbound Gateway lifecycle handling with Guilds, Guild Messages, and Message Content intents.
- [x] Create and persist one owned public thread for each top-level `/agent` command.
- [x] Normalize and durably deduplicate owner follow-up messages by Discord message ID.

M4 uses a guild-scoped `/agent` command with a required prompt and one optional image. The Gateway receives both interactions and thread messages over an outbound connection, so no public Discord endpoint is needed. A top-level command creates a bot-owned thread registered to the initiating user; the initial command and later owner messages use that thread ID as the shared OpenCode session/worktree boundary. Interaction tokens are used only for immediate acknowledgement and are never persisted. Bot-owned progress and final messages are redacted and bounded.

**Milestone 4 exit criteria**

- One allowlisted slash-command flow creates a thread and completes end-to-end over the Gateway.
- Two ordinary owner follow-ups reuse the same session/worktree, while another user and an unrelated thread create no job.
- Discord support introduces no Discord branches inside the core execution loop.
- Documentation does not claim support for arbitrary Discord messages unless a Gateway transport is implemented.

## Future milestone — Distributed AWS orchestration

Open this only when horizontal scaling, stronger availability, or worker isolation has a concrete requirement.

Candidate architecture:

- API Gateway/Lambda or a lightweight ingress service for request verification.
- SQS FIFO with normalized session key as `MessageGroupId` for per-conversation ordering.
- DynamoDB or PostgreSQL for jobs, sessions, leases, idempotency, limits, and usage.
- Isolated ECS/EC2 execution workers with explicit worktree lifecycle.
- S3 and CloudWatch for durable audit/log storage.
- A delivery service that owns Slack/Discord credentials and consumes completion events.

Before implementation, specify worker leases, heartbeats, visibility-timeout extension, poison-job handling, session/worktree affinity, cancellation, delivery retries, and exactly-once claims. SQS alone does not replace the current transactional queue, concurrency policy, or session database.

## Implementation sequencing

Milestone 1 packages M1-A through M1-D are complete. The remaining dependency graph is:

```text
M1 integration seam (complete) --> M2-A/B receiver, acknowledgement, deduplication
                                         |
                                         v
                                  M2-C docs/manifest
                                         |
                                         v
                                  M2-D edge hardening --> M3 AWS lift

M1 + M2 ---------------------------------------------> M4 Discord
```

M2-A through M2-D are implemented with the durable-inbox acknowledgement guarantee and reviewed endpoint-hardening configuration recorded below. Each production deployment must archive its edge evidence before it can claim the M2-D acceptance criteria.

If work is split across contributors, each contributor should claim one work package and avoid overlapping primary files. Each package must return:

1. files changed;
2. behavior and migration decisions;
3. focused checks run and their results;
4. unresolved assumptions or follow-up work;
5. confirmation that unrelated worktree changes were not modified.

The integrator must run `npm run check`, `npm test`, and `npm run build` after combining each milestone. Live Slack or AWS checks supplement but do not replace automated receiver, normalization, migration, and deduplication tests.

## Decisions resolved

- Normalized identity columns remain additive for one compatibility milestone; normalized columns and integration-namespaced keys are authoritative for new reads and writes.
- Slack Events API acknowledgement is released only after an authorized event is committed to the SQLite inbound inbox. The receiver does not wait for attachment downloads, job submission, OpenCode, or Slack API calls. Inbox recovery plus idempotent job submission provides durable at-least-once internal processing without claiming exactly-once external delivery.
- Persisted delivery state is a generic delivery-message ID with an additive backfill from Slack's legacy `reply_ts`; platform reporters interpret the ID. Discord interaction tokens are not persisted.
- Discord M4 uses Gateway ingress. `/agent` is top-level only, creates a public owner-bound thread, and ordinary owner messages in that thread continue the session.

## Decisions intentionally deferred

- The exact AWS compute choice between EC2 and ECS-on-EC2.
- Shared-database and queue technology for distributed execution.

Resolve these at the start of the milestone that needs them; do not block Slack transport separation on later cloud or Discord choices.
