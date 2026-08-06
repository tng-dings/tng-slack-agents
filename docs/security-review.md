# Slack app security review packet

## Executive summary

**Company Coding Agent** is a single-workspace, internal Slack app that accepts direct messages from explicitly approved users and submits coding tasks to a company-managed OpenCode worker. It uses Slack Socket Mode, so the deployment has no public inbound HTTP endpoint.

The Slack gateway and coding worker are separate Windows security principals. Slack credentials exist only in the gateway bundle and process. The OpenCode worker receives only its localhost server password and the separately approved model-provider credential. A deploy-time validation script verifies this separation without printing secret values.

The requested approval scope is one workspace, one named tester, and one disposable or backed-up repository.

## Data flow

```text
Allowlisted Slack DM (text and optional image attachments)
  -> Slack Socket Mode connection
  -> AgentRunner downloads images via authenticated Slack API, persists prompt + attachments as a queued job
  -> authenticated 127.0.0.1 OpenCode API (text prompt + image file parts)
  -> OpenCodeServer (provider credential, detached worktree)
  -> approved model provider
  -> redacted and bounded response to the originating Slack DM thread
```

No Slack credential crosses the localhost worker boundary. Gateway Git subprocesses receive an explicit allowlist of non-secret environment variables.

## Slack permissions

Bot scopes:

- `assistant:write` — agent-thread status and suggestions
- `chat:write` — replies in the originating app DM
- `files:read` — download image attachments (screenshots) shared in DMs
- `im:history` — receive direct messages sent to the app

Events:

- `message.im`
- `app_home_opened`

Controls:

- Socket Mode; no Request URL or inbound listener
- Organization deployment disabled
- Interactivity disabled
- Native Slack streaming is rejected at startup because streamed output cannot be safely redacted
- Direct messages only; bot messages and subtypes ignored
- Exact workspace and user allowlists enforced in both the Slack gateway and runner
- Slack `event_id` deduplication before a response is posted
- Repeated unauthorized denials limited per workspace/user

The version-controlled scope definition is [`slack/manifest.json`](../slack/manifest.json).

## Secrets and process isolation

| Secret | Owner | Exposed to OpenCode |
| --- | --- | --- |
| Slack bot token | `NT SERVICE\AgentRunner` | No |
| Slack app-level token | `NT SERVICE\AgentRunner` | No |
| OpenCode client/server password | Both, in separate bundles | Yes, by design |
| Model-provider credential | `NT SERVICE\OpenCodeServer` | Yes, accepted MVP risk |

Evidence:

- [`Set-AgentRunnerSecrets.ps1`](../scripts/Set-AgentRunnerSecrets.ps1) creates independently encrypted, ACLed bundles.
- [`Start-AgentRunner.ps1`](../scripts/Start-AgentRunner.ps1) reads only `gateway-secrets.bin`.
- [`Start-OpenCode.ps1`](../scripts/Start-OpenCode.ps1) reads only `worker-secrets.bin` and refuses `SLACK_*` entries.
- [`environment.ts`](../src/environment.ts) prevents gateway secrets from reaching Git child processes.
- WinSW definitions use distinct Windows virtual accounts.

## Data handling

- Prompt and output character limits are enforced before unbounded persistence or delivery.
- Audit records contain prompt/output lengths and SHA-256 hashes, not their bodies.
- Tool audit records contain tool name, call ID, and status rather than tool input/output.
- Audit payload size is capped.
- Completed job prompt/output content is removed by default.
- Jobs, usage aggregates, SQLite/JSONL audit events, OpenCode session/message data, and detached worktrees are deleted after the configured retention period; the approval configuration uses 30 days.
- Data directories are restricted to administrators, SYSTEM, and the owning service identity.

## Worker controls

- OpenCode accepts only an HTTP loopback literal; remote hosts, URL credentials, paths, queries, fragments, and redirects are rejected.
- HTTP Basic authentication uses a high-entropy password shared only between the two service bundles.
- Runtime-inline OpenCode configuration disables auto-update, external-directory access, web tools, subagents, skills, and interactive questions. Unknown tools require approval and the coordinator rejects permission requests.
- A detached worktree is used per Slack thread, with per-thread serialization.
- Global/per-user concurrency, queue, timeout, output, and reported-cost limits are enforced.
- Slack delivery failure cannot change a successful execution result or trigger an automatic replay.

## Deployment verification evidence

After installing the services, provisioning secrets, and copying the approved configuration, run from an elevated PowerShell prompt:

```powershell
npm ci
npm run check
npm test
npm audit
.\scripts\Test-AgentRunnerSecurity.ps1
```

Archive the output with the approval ticket. The validation script checks service identities, bundle contents by key name, cross-service ACL exclusions, loopback configuration, allowlists, live-output settings, content retention, and retention duration. It never prints secret values.

## Residual risks requiring reviewer acknowledgement

1. The model-provider credential is available to the coding worker. It must be narrowly scoped, provider-budget-limited, and rotated after testing.
2. Worker outbound network access is not restricted for the MVP. The owner explicitly accepts possible exfiltration of the provider credential or accessible source because the worker runs on a dedicated Windows machine containing only the approved code and worker credential.
3. Native Windows service isolation is weaker than a dedicated VM. Testing is restricted to one trusted user and a disposable/backed-up repository until a VM worker is deployed.
4. The worker intentionally has shell/edit capability. Repository scripts and dependencies are executable content.
5. Source and prompts are transmitted to the separately approved model provider.
6. Slack token rotation is manual for this single-workspace MVP. The incident owner can revoke both Slack tokens immediately.

## Approval requested

Approve the exact manifest, one workspace ID, one tester ID, the documented provider/data flow, 30-day metadata retention, and the residual risks above for time-bounded MVP testing. Expansion to additional users, repositories, or production data requires a new review after VM/network isolation is implemented.
