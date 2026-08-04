# Security notes

## Enforced controls

- Slack input is accepted only from direct messages and exact configured user IDs.
- Jobs are deduplicated by Slack event ID, ordered within a thread, concurrency-limited, timed out, and checked against the user's daily reported cost before and during execution.
- OpenCode binds to `127.0.0.1` and uses HTTP Basic authentication with a high-entropy password.
- Unexpected OpenCode permission requests are rejected rather than approved through Slack.
- The source repository is fixed in administrator-controlled configuration. Worktree paths are SHA-256-derived beneath one resolved root and Git is invoked with an argument array, not a shell string.
- Secrets are absent from committed configuration. Service launchers decrypt a DPAPI LocalMachine blob into process environment variables; filesystem ACLs protect the blob.
- Audit payloads redact configured secrets, Slack token forms, and common password/API-key forms before writing JSONL and SQLite.

## Known MVP limitations

- Native Windows worktrees are isolation from accidental checkout collisions, not containment. OpenCode commands can reach anything accessible to the service identity.
- OpenCode-reported cost is authoritative. Providers that report usage late or as zero can overshoot a cap; timeout and concurrency limits remain the backstop.
- JSONL and SQLite audits intentionally include prompts, outputs, and tool events. Treat the data directory as sensitive and implement the agreed 30-day retention operationally; automatic rotation/deletion is not included in this MVP.
- Slack message streaming can fail due to workspace features or API availability. The gateway falls back to throttled `chat.update` calls.
- A job already executing when the runner crashes is marked failed on restart, not retried automatically. This avoids duplicating file changes. Queued jobs remain durable.

## Before adding users

Obtain written Slack/security approval, use a disposable or backed-up repository, verify service-account ACLs, validate provider data handling, confirm audit retention/access, and test rollback. The next hardening milestone should place the executor in WSL/VM isolation and add a worker-level network/filesystem policy.
