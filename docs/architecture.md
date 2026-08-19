# Current architecture

This document describes the repository as it exists today. It is not a proposed
AWS design or a record of completed implementation milestones.

## Status

- Slack supports Socket Mode and Events API HTTP ingress.
- Discord supports Gateway ingress and interactions HTTP ingress. Gateway mode
  also receives owner follow-up messages; HTTP mode currently handles slash
  commands only.
- OpenCode and Claude Code have both been exercised locally through Slack Socket
  Mode. Windows-service and hosted-deployment validation are still pending.
- A cloud deployment is a product direction, not a selected architecture. AWS is
  the likely environment, but the compute, persistence, queue, and worker
  isolation choices remain open.

## Runtime shape

```text
Slack Socket Mode ----\
Slack Events API ------> platform ingress + adapter --\
Discord Gateway -------/                                \
Discord interactions HTTP -------------------------------> durable submission
                                                            |
                                              SQLite <-> AgentRunner
                                                            |
                              +-----------------------------+----------------+
                              |                                              |
                  integration reporter                      selected executor
                              |                                              |
                    Slack or Discord                         provider session
                                                                             |
                                                               Git worktree
```

The platform adapters own request or event validation, exact allowlists,
normalization, attachment retrieval, and delivery. `AgentRunner` owns durable
submission, idempotency, per-session serialization, limits, execution, audit,
and recovery. Persisted integration IDs select the correct reporter after a
restart.

## Composition roots and module ownership

Composition stays at the edges of the application. Leaf modules import their
dependencies directly; they do not reach back into a composition root.

| Area | Composition root | Ownership |
| --- | --- | --- |
| Service process | `src/index.ts` | Loads configuration and secrets; constructs the database, audit logger, workspace manager, selected executor, enabled platform gateways, reporter registry, authorization policy, and `AgentRunner`; owns process startup and shutdown order. |
| Slack integration | `src/slack.ts` (`SlackGateway`) | Constructs the Slack Bolt application and selects Socket Mode or Events API ingress. `src/slack/adapter.ts` owns authorization, attachment retrieval, and submission; `normalization.ts` owns payload parsing; `delivery.ts` owns replies; `socket-ingress.ts` and `http-ingress.ts` own transport lifecycle; `inbox.ts` owns the Slack-specific durable handoff. |
| Discord integration | `src/discord.ts` (`DiscordGateway`) | Constructs the Discord API client and selects Gateway or interactions HTTP ingress. `src/discord/adapter.ts` owns authorization, thread creation, attachment retrieval, and submission; `normalization.ts` owns payload parsing; `delivery.ts` owns REST delivery; `gateway-ingress.ts` and `http-ingress.ts` own transport lifecycle; `inbox.ts` owns the Discord-specific durable handoff. |
| Orchestration | `src/runner.ts` (`AgentRunner`) | Owns durable job execution, per-session serialization, limits, cancellation, recovery, usage accounting, and terminal delivery. `src/integrations.ts` routes delivery by persisted integration ID; `src/types.ts` defines the provider- and platform-neutral contracts. |
| Persistence | `src/database.ts` | Owns the SQLite schema, additive migrations, jobs, sessions, inbound events, Discord thread ownership, usage, and audit persistence. `src/status.ts` is a separate read-only operational view. |
| Executors | `src/opencode.ts` and `src/claude-code.ts` | Implement the neutral `Executor` contract. OpenCode protocol and version validation remain in `opencode-protocol.ts` and `opencode-version.ts`; Claude child-process environment filtering remains in `claude-environment.ts`. Executor choice is made only by the service and smoke-test roots. |
| Workspaces | `src/workspace.ts` | Owns deterministic session identity, Git branch/worktree creation and reattachment, collision checks, and retention cleanup. Executors consume this boundary rather than implementing workspace lifecycle themselves. |
| Shared mechanics | `src/http.ts`, `src/inbox.ts`, `src/attachments.ts`, and `src/values.ts` | Provide bounded HTTP mechanics, the transport-neutral durable inbox pump, supported image types, and safe unknown-value helpers. Platform policy, status codes, normalization, authorization, and delivery remain outside these modules. |
| Operator CLIs | `src/cli/*.ts` | Each file is an independent composition root: `doctor`, `smoke`, `status`, Discord command registration, or Slack manifest rendering. CLIs import the narrow leaf modules they need and do not reuse the long-running service root. |
| Windows services | `service/AgentRunner.xml` and `service/OpenCodeServer.xml` | WinSW owns service recovery and invokes `scripts/Start-AgentRunner.ps1` or `scripts/Start-OpenCode.ps1`. Those launchers own DPAPI secret injection, environment cleanup, executable selection, and the final Node or OpenCode process boundary. Provisioning and validation remain in `Set-AgentRunnerSecrets.ps1` and `Test-AgentRunnerSecurity.ps1`. |

### Integration barrel policy

`src/slack.ts` and `src/discord.ts` are application composition modules and the
supported integration test surface; this private package does not expose a
general library API. Production imports only `SlackGateway` and
`DiscordGateway` from the barrels. Tests use the exported adapters, ingress
implementations, reporters, normalization functions, and their named contract
types to exercise integration boundaries without starting the service process.

The raw `hardenSlackRequestListener` and `createDiscordRequestListener`
functions, together with their option and verifier types, are deliberate
injectable HTTP test seams even though no current in-repository caller imports
them from the barrels. Other exported types without a direct importer are the
named parameter or result types of exported classes and functions, so they are
retained to keep the barrel surface type-complete. Internal platform modules
continue to import sibling leaf modules directly, avoiding barrel cycles.

`SlackGatewayDependencies` is the composition-root seam for constructing Bolt
objects in tests without authenticating against Slack. Production uses its
default real factories; the gateway boundary test supplies inert factories and
asserts that Socket Mode and Events API select the expected ingress. Discord's
constructors have no pre-start network side effects, so its equivalent boundary
test uses the real composition objects directly.

### Runtime terminology

An **integration** is a message platform such as Slack or Discord. An
**executor** is the selected local execution adapter (`opencode` or
`claude-code`). A **provider session** is the opaque continuity identifier that
an executor persists for its backend, while a **model provider** is the upstream
service that supplies model inference. Generic orchestration, persistence, and
workspace code use these neutral terms; OpenCode- and Claude-specific names
remain in their configuration, executor, launcher, and compatibility surfaces.

HTTP ingress authenticates and durably accepts a bounded event before releasing
its platform acknowledgement. Public TLS termination, request limits, and rate
controls are deployment responsibilities described in
[`public-endpoint-hardening.md`](public-endpoint-hardening.md). The private Node
listeners remain loopback-only in the supplied configuration.

## Compatibility commitments

The consolidation review found no orphaned runtime or deployment asset. The
remaining compatibility paths are intentional and have explicit removal gates:

| Surface | Current reason | Removal gate |
| --- | --- | --- |
| Slack-era `sessions` and `jobs` identity columns | Older integration-unaware binaries require them; current code dual-writes them while reading normalized integration identities. | Close rollback to those binaries, back up every operator database, prove normalized values are complete, and test a reviewed SQLite table rebuild. |
| `sessions.opencode_session_id` | Older provider-specific binaries require it; current code dual-writes provider-neutral session columns. | Close rollback to those binaries, prove provider columns are complete, and test the table-rebuild migration tracked in the OpenCode backlog. |
| Additive schema-migration branches | No minimum supported database baseline has been declared, and operator databases may predate any individual feature. | Establish a versioned schema baseline and supported source version, rehearse backup/restore, and retain an archived migration fixture before retiring a branch. |
| Unprefixed `source_event_id` reads | They keep old or partially migrated records intelligible during recovery. | Remove with the integration-identity migration after all supported databases use namespaced event keys. |
| Omitted `executor` defaulting to `opencode` | Installed configurations and launch commands predate explicit executor selection. | Require `executor`, migrate installed configuration and automation, and close rollback to OpenCode-assuming launchers. |
| Provisioner `-AdditionalSecretNames` alias | External provisioning commands may still use the original name. | Confirm maintained external automation uses `-WorkerSecretNames`, then announce removal at a release boundary. |
| Rejection of `slack.nativeStreaming: true` | The fail-closed guard prevents old configuration from implying unsafe unredacted streaming is active. | Reject unknown configuration keys and validate every installed configuration without the field. |

Discord interactions HTTP is actively tested and documented despite Gateway
being the preferred conversational transport; it is not compatibility debt.
The non-semantic `jobs_actor_status_idx` and
`discord_threads_guild_owner_idx` indexes were removed because no query used
them. Startup drops either stale index, and an older binary can safely recreate
them without changing data or schema meaning.

## Executor boundary

The configured `executor` applies to one runner process:

- `opencode` uses an authenticated loopback OpenCode server. The Windows-service
  design separates the integration gateway and worker into distinct identities
  and secret bundles.
- `claude-code` runs the Claude Agent SDK under the AgentRunner identity. Slack
  and Discord values are removed from the child environment, but this is not an
  operating-system security boundary.

Every normalized conversation has a deterministic `agent-runner/<session-hash>`
branch and worktree. The provider session is persisted independently of the
integration. Worktrees isolate concurrent repository checkouts; they do not
sandbox executor tools from the host.

## Invariants

- Authenticate platform traffic before treating payload fields as trusted.
- Authorize the exact tenant/guild/workspace and actor before creating a job.
- Namespace event and session identities by integration.
- Deduplicate platform retries and serialize work within one conversation.
- Preserve queued work across restart; never silently replay interrupted work.
- Bound prompts, attachments, output, audit events, concurrency, runtime, and
  reported cost.
- Redact and bound output before platform delivery.
- Keep integration credentials out of executor child environments and
  provider-credential bundles.
- Do not expose either private HTTP listener directly to the internet.

## Deployment boundary

The repository currently contains a Windows-service design and a same-host NGINX
edge configuration. Neither commits the project to its eventual hosted form.
A cloud design must decide, with evidence:

1. whether ingress/orchestration and execution share a host, task, or account;
2. how jobs, sessions, idempotency, leases, and usage are persisted;
3. how a conversation is routed to a worker that owns or can reconstruct its
   repository state;
4. how platform, provider, and source-control credentials are isolated;
5. how interruption, cancellation, delivery retry, backup, restore, and
   observability behave; and
6. which availability and scale requirements justify replacing the current
   single-writer SQLite design.

Possible AWS components are inputs to that decision, not current commitments.
See the active [cloud roadmap](../backlog/integrations-http-cloud-roadmap.md).
