# Integration, HTTPS ingress, and cloud roadmap

This backlog evolves the current Slack Socket Mode MVP into a transport-independent orchestration service. The first delivery target is Slack with a configurable Socket Mode or Events API HTTPS ingress. Discord and a distributed AWS architecture follow only after that boundary is proven.

The work is intentionally phased. Do not combine the initial HTTPS milestone with a generic plugin system, Discord support, or a serverless rewrite.

## Agreed direction

Treat these as independent axes:

1. **Platform integration:** Slack, Discord, or a future platform.
2. **Ingress transport:** Slack Socket Mode, Slack Events API over HTTPS, or Discord interactions over HTTPS.
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

- [`src/slack.ts`](../src/slack.ts) combines Socket Mode lifecycle, event parsing, authorization, attachment download, denial responses, and Slack result delivery.
- [`src/runner.ts`](../src/runner.ts) owns durable submission, limits, queueing, execution, and reporting, but currently reads Slack allowlists directly.
- [`src/types.ts`](../src/types.ts) provides useful `Executor`, `JobReporter`, and `ReporterFactory` seams, while persisted job/session identities still use Slack names such as `workspaceId`, `channelId`, and `threadTs`.
- [`src/database.ts`](../src/database.ts) provides SQLite persistence, source-event deduplication, and per-session serialization.
- [`src/index.ts`](../src/index.ts) assumes one optional Slack gateway and selects its reporter globally.
- [`src/opencode.ts`](../src/opencode.ts) requires a loopback OpenCode server and local worktree path.

These are the constraints to improve, not reasons to replace the working queue and executor.

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

- [ ] Replace the single optional Slack reporter selection with integration-aware routing based on the persisted job.
- [ ] Fail closed and audit a clear delivery error if no adapter exists for a persisted integration.
- [ ] Ensure restart recovery selects the original integration's reporter.
- [ ] Keep console reporting available for explicit local/smoke usage rather than as an accidental fallback for unknown integrations.

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

- [ ] Add the Slack Events API receiver using Slack Bolt's supported HTTP receiver unless a concrete limitation requires a custom server.
- [ ] Verify Slack signatures against the unmodified raw request body and `SLACK_SIGNING_SECRET`.
- [ ] Enforce Slack's request timestamp freshness/replay protection through the receiver or explicit validation.
- [ ] Keep Bolt signature verification explicitly enabled in production; never disable it merely because a load balancer or reverse proxy is present.
- [ ] Validate the expected Slack app ID, workspace, user, event type, DM context, and bot/subtype rules after request authentication. A valid Slack signature proves origin, not user authorization.
- [ ] Support Slack URL-verification challenges.
- [ ] Expose a dedicated health endpoint that does not reveal configuration or secret state.
- [ ] Configure host/port/path explicitly for reverse-proxy or load-balancer deployment.
- [ ] Do not log request bodies, signatures, tokens, prompts, or attachment contents.

**Acceptance criteria**

- Valid signed events are accepted.
- Invalid signatures and stale requests are rejected without enqueueing work.
- URL verification succeeds.
- Health checks work without Slack credentials in the request.

### M2-B: Fast acknowledgement, retries, and deduplication

**Primary files:** Slack HTTPS ingress, submission lifecycle if needed, tests.

- [ ] Ensure Slack receives an acknowledgement inside its deadline without waiting for OpenCode, attachment downloads, result delivery, or a Slack `Working…` API call.
- [ ] Verify the selected Bolt receiver's acknowledgement behavior with an intentionally delayed listener test; do not assume it.
- [ ] Preserve durable `event_id` deduplication and namespace it as Slack.
- [ ] Test duplicate and retry headers, including a retry arriving while the original job is queued or running.
- [ ] If acknowledgement must precede durable job insertion, explicitly document and test the small crash-loss window or add a durable inbound-event inbox. Do not claim at-least-once acceptance without one.

**Acceptance criteria**

- A deliberately slow event handler still receives a timely HTTP acknowledgement.
- Multiple deliveries of one Slack event create one job and at most one `Working…` reply.
- The documented durability guarantee matches the implementation.

### M2-C: Configuration, manifest, and operator documentation

**Primary files:** `config.example.json`, `slack/manifest.json`, `README.md`, `docs/`.

- [ ] Make `SLACK_APP_TOKEN` mandatory only for Socket Mode.
- [ ] Make `SLACK_SIGNING_SECRET` mandatory only for Events API mode.
- [ ] Update the Slack manifest for HTTPS deployment or provide separate clearly named manifests if one manifest cannot safely represent both modes.
- [ ] Document Request URL setup, TLS/reverse-proxy expectations, health checking, and local testing.
- [ ] Update the security model: HTTPS adds a public trust boundary that Socket Mode intentionally avoids.
- [ ] Add signature failure, replay, rate limiting, request-size, and denial-of-service considerations to the security review.
- [ ] Preserve the existing Socket Mode administrator/testing path.

**Milestone 2 exit criteria**

- `socket` and `events-api` each pass the same normalized Slack message acceptance suite.
- HTTPS signature, timestamp, challenge, retry, and fast-ack tests pass without live Slack credentials.
- Socket Mode still passes its existing tests and manual run path.
- Documentation makes clear that Slack incoming webhooks are not used for inbound events.

### M2-D: Public endpoint hardening

**Primary files:** deployment configuration, HTTP ingress tests, security and operator documentation.

- [ ] Terminate TLS at a managed load balancer or hardened reverse proxy; do not directly expose the Node receiver to the internet.
- [ ] Make the Bolt service reachable only from that trusted edge component.
- [ ] Publicly route only `POST /slack/events` and a minimal health endpoint. Return no configuration, dependency, credential, or detailed failure data from health checks.
- [ ] Enforce request-body, header, connection, and request-time limits before Bolt buffers the body. Slack event payloads contain file metadata rather than attachment binaries, so determine a small bound from representative payload tests.
- [ ] Add edge rate limiting and, for AWS, evaluate AWS WAF rules for malformed/flood traffic. Slack signatures remain the source-authentication mechanism; do not depend on source IP allowlisting as a substitute.
- [ ] Keep system time synchronized because request freshness validation depends on it.
- [ ] Store the signing secret in the existing protected bundle or cloud secret manager, exclude it from logs and OpenCode's environment, and document rotation.
- [ ] Ensure rejected signatures and malformed requests cannot cause unbounded log volume or leak request bodies, signatures, prompts, tokens, or attachment metadata.
- [ ] Keep Node and `@slack/bolt` on supported, patched versions and include them in dependency-vulnerability monitoring.
- [ ] Test valid signatures, invalid signatures, stale timestamps, malformed JSON, wrong methods/paths, oversized bodies, slow requests, duplicate events, retry headers, and unauthorized but validly signed workspace/user events.

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

## Milestone 4 — Discord HTTPS interactions

Depends on Milestones 1 and 2 proving the integration boundary. Start with slash commands/interactions. Discord arbitrary channel-message intake generally requires the Discord Gateway WebSocket and is a separate future transport.

- [ ] Define the product interaction: slash command shape, allowed guilds/users, thread/session behavior, attachments, and response visibility.
- [ ] Verify Discord interaction signatures before normalization.
- [ ] Defer/acknowledge interactions within Discord's deadline.
- [ ] Normalize application/guild, channel, thread, and actor identities.
- [ ] Namespace Discord event and session keys.
- [ ] Implement Discord-specific delivery and output limits.
- [ ] Handle interaction-token lifetime explicitly; long-running jobs may require follow-up messages through bot credentials rather than the original callback token.
- [ ] Add Discord allowlist, replay, duplicate, authorization, and delivery tests.
- [ ] Confirm Slack and Discord jobs can coexist without identity, session, or reporter collisions.

**Milestone 4 exit criteria**

- One allowlisted slash-command flow completes end-to-end over HTTPS.
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

## Parallel work coordination

Parallel agents should claim one work package and avoid overlapping primary files. Post the claimed package and files before editing.

Suggested dependency graph:

```text
M1-A normalized persistence ----\
                                +--> M1-D composition/routing --> M2 HTTPS ingress
M1-B generic authorization ----/

M1-C Slack separation -------------------------------/

M2 tests/receiver --> M2 docs/manifest --> M3 AWS lift
M1 + M2 --------------------------------> M4 Discord
```

Safe parallelism after normalized contracts are agreed:

- **Agent A:** M1-A database migration and persistence tests.
- **Agent B:** M1-B authorization/config boundary.
- **Agent C:** M1-C Slack normalization and adapter tests.
- **Integrator:** M1-D composition, conflict resolution, and full verification.
- After M1 integration, one agent can own M2-A/B while another prepares M2-C documentation against the finalized configuration.

Each package must return:

1. files changed;
2. behavior and migration decisions;
3. focused checks run and their results;
4. unresolved assumptions or follow-up work;
5. confirmation that unrelated worktree changes were not modified.

The integrator must run `npm run check`, `npm test`, and `npm run build` after combining each milestone. Live Slack or AWS checks supplement but do not replace automated receiver, normalization, migration, and deduplication tests.

## Decisions intentionally deferred

- Whether normalized identity columns replace legacy Slack columns immediately or remain additive for one compatibility milestone.
- Whether persisted reply context is typed platform columns or a versioned, validated JSON envelope.
- Whether HTTP acknowledgement plus asynchronous in-process submission is an acceptable MVP durability window or requires a durable inbound-event inbox.
- The exact AWS compute choice between EC2 and ECS-on-EC2.
- Discord slash-command syntax and whether a later Discord Gateway transport is needed.
- Shared-database and queue technology for distributed execution.

Resolve these at the start of the milestone that needs them; do not block Slack transport separation on later cloud or Discord choices.
