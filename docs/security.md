# Security model

## Trust boundaries

The Slack gateway/coordinator and OpenCode worker are separate security principals.

| Component | Secrets | Required access | Explicitly excluded |
| --- | --- | --- | --- |
| `AgentRunner` | Slack bot/app tokens; OpenCode client password | Slack API, queue, audit data, worktree creation | Provider credentials |
| `OpenCodeServer` | Provider credential; OpenCode server password | Worktrees and approved provider network | Slack credentials, queue, audit data |

The duplicated OpenCode password authenticates one loopback-only connection. It is not a Slack credential. `%ProgramData%\AgentRunner\gateway-secrets.bin` and `%ProgramData%\OpenCodeWorker\worker-secrets.bin` use separate ACLs and Windows virtual service identities. The worker launcher rejects any `SLACK_*` entry as a defense-in-depth check.

## Enforced controls

- Slack events are accepted only from direct messages, exact configured workspace IDs, and exact configured user IDs.
- Authorization occurs before job persistence or a `Working…` response. Slack `event_id` is the primary idempotency key, so retries do not create duplicate replies.
- The Slack manifest requests only `assistant:write`, `chat:write`, `files:read`, and `im:history`; Socket Mode exposes no inbound HTTP endpoint.
- OpenCode URLs are restricted to HTTP loopback literals, credentials/paths/query strings are rejected, and HTTP redirects are disabled.
- Slack credentials never enter the worker secret bundle. Gateway Git subprocesses receive an allowlisted environment without gateway secrets.
- Runtime-inline OpenCode policy denies external-directory access, web tools, subagents, skills, and interactive questions; unknown tools require approval and are automatically rejected. Shell/edit access remains because this is a coding worker.
- Unexpected OpenCode permission requests are rejected rather than approved through Slack.
- Source and worktree paths are administrator-configured. Worktree names are SHA-256-derived under a resolved root, and Git is invoked with argument arrays rather than shell strings.
- Prompts and outputs have hard character limits. Audit event payloads are bounded and contain hashes/lengths rather than prompt or output bodies.
- Job content is removed on completion by default. Jobs, usage aggregates, JSONL/SQLite audit records, OpenCode sessions, and detached worktrees older than `storage.retentionDays` are purged automatically.
- Slack delivery failures are audited separately and cannot change a successful execution into a failed execution.
- Concurrency, queue, timeout, and reported-cost limits constrain resource use.

## Residual accepted risks for the MVP

- The provider credential is intentionally present in the OpenCode worker and can be exposed by a compromised worker. Use a narrowly scoped key with a low provider-side budget and rotate it after testing.
- Worker outbound network access is intentionally not restricted for this MVP. The owner accepts that the agent or repository code could exfiltrate its provider credential or accessible source; deployment is limited to a dedicated Windows machine with no other sensitive data.
- Native Windows process and ACL isolation is not equivalent to a VM sandbox. OpenCode shell commands can access everything granted to `NT SERVICE\OpenCodeServer`.
- Shell access is necessary for coding tasks. Repository scripts and dependencies are therefore executable content; use only a disposable or backed-up repository for MVP approval testing.
- OpenCode-reported cost can arrive late or be zero. Configure a provider-side spend cap; the local cap is only a secondary control.
- Model prompts and source content leave the machine for the approved model provider. Provider retention, training, and residency terms require separate approval.
- Static Slack tokens remain enabled for the single-workspace MVP. The incident owner must be able to revoke and replace them immediately; automated OAuth token rotation is a later milestone.

## Mandatory operating conditions

1. Install and run the services under the distinct virtual identities declared in the WinSW XML files.
2. Provision secrets only with `Set-AgentRunnerSecrets.ps1`; do not recreate a shared blob.
3. Verify the ACLs and service identities using the commands in `docs/security-review.md` before adding a tester.
4. Use one approved workspace, one allowlisted tester, a disposable repository, and a provider key with a hard external budget.
5. Do not grant the worker read access to `%ProgramData%\AgentRunner` or the gateway read access to the worker secret file.
6. Revoke all Slack and provider credentials on suspected compromise.

Before adding broader users or valuable repositories, move the worker into a VM or similarly hardened boundary and enforce outbound network policy or a provider proxy.
