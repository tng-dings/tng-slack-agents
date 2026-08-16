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

HTTP ingress authenticates and durably accepts a bounded event before releasing
its platform acknowledgement. Public TLS termination, request limits, and rate
controls are deployment responsibilities described in
[`public-endpoint-hardening.md`](public-endpoint-hardening.md). The private Node
listeners remain loopback-only in the supplied configuration.

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
- Keep integration credentials out of the OpenCode worker environment.
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
