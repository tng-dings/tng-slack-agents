# HTTP ingress and cloud deployment roadmap

## Current baseline

The transport-independent orchestration boundary is implemented. Slack supports
Socket Mode and Events API ingress. Discord supports Gateway and interactions
HTTP ingress. Both platforms use normalized, integration-namespaced identities,
durable jobs and provider sessions, per-conversation serialization, and
integration-routed delivery.

The HTTP receivers, loopback binding, representative request bounds, NGINX edge
configuration, and automated hardening tests are also implemented. This is
repository readiness, not production deployment evidence. TLS installation,
firewall/load-balancer state, external reachability, time synchronization, and
deployed log behavior must still be verified in the target environment.

See [`docs/architecture.md`](../docs/architecture.md) for the current design and
[`docs/public-endpoint-hardening.md`](../docs/public-endpoint-hardening.md) for
the endpoint runbook.

## Direction

The project is intended to become a hosted orchestration application, likely on
AWS. No exact deployment form has been selected. In particular, this backlog
does not assume EC2, ECS, Lambda, a single host, or a distributed worker fleet.

Keep these axes independent:

1. platform integration: Slack, Discord, or a future platform;
2. ingress transport: persistent socket/gateway or authenticated HTTP;
3. orchestration deployment: local service, hosted single instance, or
   horizontally available control plane; and
4. execution deployment: colocated executor, isolated worker, or remote worker
   pool.

## Decision gate: define the first hosted operating model

Write a short architecture decision record before adding cloud infrastructure.
It must establish:

- [ ] target users, repositories, trust level, availability objective, expected
  concurrency, maximum job duration, and cost envelope;
- [ ] whether the first hosted release must support Slack HTTP, Discord HTTP,
  their outbound transports, or a defined combination;
- [ ] whether one process may own ingress, orchestration, delivery, and execution
  or whether executor isolation is mandatory on day one;
- [ ] repository acquisition, credential scope, worktree persistence, session
  affinity, and cleanup behavior;
- [ ] persistence requirements for jobs, sessions, idempotency, audit, limits,
  leases, and usage;
- [ ] cancellation, crash recovery, delivery retry, backup/restore, rollback,
  logging, metrics, alerting, and incident ownership; and
- [ ] network boundaries and secret ownership for platform, provider, and source
  control credentials.

Compare at least these shapes against those requirements:

1. a single hosted VM or task retaining SQLite and local worktrees;
2. a hosted coordinator with separately isolated execution workers; and
3. a distributed control plane with a shared transactional store and durable
   queue.

The decision should explain why the simplest viable shape is sufficient and
which measured threshold would force the next shape.

## First hosted proof

After the decision is accepted:

- [ ] provision the smallest selected environment through reproducible
  infrastructure;
- [ ] terminate TLS at a managed or hardened edge and expose only the enabled
  platform routes and minimal health endpoint;
- [ ] store data on encrypted durable storage and inject secrets through the
  selected secret manager without crossing executor boundaries;
- [ ] demonstrate one authorized Slack request and one authorized Discord
  request for each HTTP transport included in scope;
- [ ] demonstrate invalid-signature, stale, duplicate, unauthorized, oversized,
  slow, and wrong-route cases without job creation or secret-bearing logs;
- [ ] demonstrate queued-job survival, interrupted-job handling, cancellation,
  delivery failure, retention, backup, restore, and rollback; and
- [ ] archive the evidence required by the endpoint and security runbooks.

## Distributed orchestration trigger

Do not replace SQLite or introduce a remote queue solely because AWS is the
target environment. Open distributed design only when requirements demand
horizontal control-plane scaling, stronger availability, or isolated/elastic
workers.

That design must specify transactional job claiming, leases and heartbeats,
per-session ordering, idempotency, visibility extension, poison-job handling,
worker authentication, repository/session affinity, cancellation, usage limits,
and delivery retries. A queue service by itself does not replace those
semantics.

## Related deferred work

- [OpenCode runtime and workspace follow-up](opencode-runtime.md)
