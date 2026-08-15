# Security model

## Trust boundaries

The integration gateway/coordinator and OpenCode worker are separate security principals.

| Component | Secrets | Required access | Explicitly excluded |
| --- | --- | --- | --- |
| `AgentRunner` | Slack credentials when enabled; Discord bot token and, for legacy HTTP ingress, public key; OpenCode client password | Platform APIs, queue, audit data, worktree creation | Provider credentials |
| `OpenCodeServer` | Provider credential; OpenCode server password | Worktrees and approved provider network | Slack/Discord credentials, queue, audit data |

The duplicated OpenCode password authenticates one loopback-only connection. It is not an integration credential. `%ProgramData%\AgentRunner\gateway-secrets.bin` and `%ProgramData%\OpenCodeWorker\worker-secrets.bin` use separate ACLs and Windows virtual service identities. The worker launcher rejects any `SLACK_*` or `DISCORD_*` entry as a defense-in-depth check.

## Enforced controls

- Slack events are accepted only from direct messages, exact configured workspace IDs, and exact configured user IDs.
- Discord Gateway mode accepts the configured guild slash command only in a normal channel, creates a registered bot-owned thread, and accepts later messages only from that thread's initiating allowlisted user. DMs, unrelated threads, other users, bots, webhooks, and system messages are ignored or denied.
- Discord uses an outbound authenticated Gateway connection with Guilds, Guild Messages, and Message Content intents. Slash commands and thread messages are reduced to sanitized envelopes and durably committed; interaction tokens are used only for the immediate acknowledgement and are never persisted.
- Discord delivery uses bot-owned public messages, with mention parsing and embeds suppressed. Message IDs are persisted for restart recovery, while output is redacted, integration-capped, and split below Discord's message bound.
- Authorization occurs before job persistence or a `Working…` response. Slack `event_id` is the primary idempotency key, so retries do not create duplicate replies.
- The Slack manifests request only `assistant:write`, `chat:write`, `files:read`, and `im:history`. Socket Mode exposes no inbound HTTP endpoint. Events API mode verifies Slack signatures and timestamp freshness before parsing, validates the exact app/workspace/user, and durably commits authorized events before acknowledgement.
- Events API attachment downloads and job execution occur after acknowledgement. Pending or interrupted inbox events resume after restart, processed payloads are erased, and integration-namespaced event keys suppress duplicate Slack retries.
- Events API production configuration binds Bolt to the reviewed `127.0.0.1` listener used by the supplied edge. The reviewed NGINX edge terminates TLS, exposes only the exact event and health routes, buffers at most 256 KiB before proxying, bounds headers/connections/time, and applies per-source and global rate limits.
- The private listener repeats the reviewed body/header/time/connection bounds before Bolt dispatch. Receiver rejection logs contain only rate-limited fixed categories, never parser text or request-controlled content.
- OpenCode URLs are restricted to HTTP loopback literals, credentials/paths/query strings are rejected, and HTTP redirects are disabled.
- Slack and Discord credentials never enter the worker secret bundle. Gateway Git subprocesses receive an allowlisted environment without gateway secrets.
- Runtime-inline OpenCode policy denies external-directory access, web tools, subagents, skills, and interactive questions; unknown tools require approval and are automatically rejected. Shell/edit access remains because this is a coding worker.
- Unexpected OpenCode permission requests are rejected rather than approved through Slack.
- Source and worktree paths are administrator-configured. Worktree directories and `agent-runner/<session-hash>` branch names are derived from the same truncated SHA-256 session hash, and Git is invoked with argument arrays rather than shell strings.
- Prompts and outputs have hard character limits. Audit event payloads are bounded and contain hashes/lengths rather than prompt or output bodies.
- Job content is removed on completion by default. Jobs, usage aggregates, JSONL/SQLite audit records, and OpenCode sessions older than `storage.retentionDays` are purged automatically. Expired worktrees are removed only when Git reports them clean; local branches and dirty worktrees are never deleted by retention.
- Integration delivery failures are audited separately and cannot change a successful execution into a failed execution.
- Concurrency, queue, timeout, and reported-cost limits constrain resource use.

## Residual accepted risks for the MVP

- The provider credential is intentionally present in the OpenCode worker and can be exposed by a compromised worker. Use a narrowly scoped key with a low provider-side budget and rotate it after testing.
- Worker outbound network access is intentionally not restricted for this MVP. The owner accepts that the agent or repository code could exfiltrate its provider credential or accessible source; deployment is limited to a dedicated Windows machine with no other sensitive data.
- Native Windows process and ACL isolation is not equivalent to a VM sandbox. OpenCode shell commands can access everything granted to `NT SERVICE\OpenCodeServer`.
- Shell access is necessary for coding tasks. Repository scripts and dependencies are therefore executable content; use only a disposable or backed-up repository for MVP approval testing.
- OpenCode-reported cost can arrive late or be zero. Configure a provider-side spend cap; the local cap is only a secondary control.
- Model prompts and source content leave the machine for the approved model provider. Provider retention, training, and residency terms require separate approval.
- Static Slack tokens remain enabled for the single-workspace MVP. The incident owner must be able to revoke and replace them immediately; automated OAuth token rotation is a later milestone.
- The Discord bot token is static and manually rotated. Public starter messages, threads, and results are visible to everyone with access to the parent channel; approved users must use only channels appropriate for repository output.
- Discord attachment CDN URLs are short-lived. Normal operation downloads them immediately after durable acknowledgement, but a prolonged coordinator outage can make an accepted image unavailable and cause inbox retries until operator intervention.
- Slack Events API and legacy Discord HTTP mode introduce a public trust boundary. Their Node HTTP listeners are accepted only behind a managed TLS endpoint or hardened reverse proxy that limits request bodies, headers, connections, request duration, and rate before application processing.
- Edge certificate installation, firewall/load-balancer state, time synchronization, and externally observed reachability remain deployment controls for enabled HTTP ingress and require the evidence in `docs/public-endpoint-hardening.md`.

## Mandatory operating conditions

1. Install and run the services under the distinct virtual identities declared in the WinSW XML files.
2. Provision secrets only with `Set-AgentRunnerSecrets.ps1`; do not recreate a shared blob.
3. Verify the ACLs and service identities using the commands in `docs/security-review.md` before adding a tester.
4. Use one approved workspace, one allowlisted tester, a disposable repository, and a provider key with a hard external budget.
5. Do not grant the worker read access to `%ProgramData%\AgentRunner` or the gateway read access to the worker secret file.
6. Revoke all enabled Slack/Discord credentials and provider credentials on suspected compromise.

Before adding broader users or valuable repositories, move the worker into a VM or similarly hardened boundary and enforce outbound network policy or a provider proxy.
