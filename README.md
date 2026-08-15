# Self-hosted Slack and Discord agent runner

This service accepts allowlisted Slack direct messages and Discord agent-thread conversations, persists them as integration-namespaced jobs in SQLite, and runs them through either an authenticated localhost OpenCode server or a local Claude Code process on Windows. During uninterrupted operation, Slack threads and bot-created Discord threads retain the selected provider's session and a deterministic Git worktree on a dedicated local branch.

## Current MVP behavior

- Slack Bolt with configurable Socket Mode or Events API HTTPS ingress and the current `agent_view` experience.
- Discord Gateway ingress with a guild-scoped `/agent` command that creates an owned public thread; ordinary owner messages in that thread continue the same session and may include one image.
- Slack messages are DM-only; Discord accepts only the configured slash command and owner messages in registered agent threads. Bot and unsupported message types are ignored. Image attachments (screenshots) are downloaded and forwarded to the selected executor.
- Immediate `Working…` reply after authorization and event deduplication. Live updates are disabled by default so output can be redacted before delivery.
- Durable SQLite queue and provider-session mapping keyed by normalized integration, tenant, conversation, and thread identities.
- Per-thread serialization, per-user/global concurrency limits, queue limit, timeout, allowlist, and daily cost cap.
- Bounded JSONL and SQLite audit records containing content hashes/lengths, usage, failures, and tool metadata; automatic 30-day retention is enabled by default.
- A branch-backed Git worktree per Slack or Discord session. The directory and `agent-runner/<session-hash>` branch are derived from the same 80-bit session hash. Running work is never silently replayed after a process crash; it is marked failed, while queued jobs survive.
- The OpenCode deployment supports separate DPAPI-protected gateway and worker secret bundles and distinct Windows virtual service identities. The local Claude subprocess receives a restricted environment that excludes Slack and Discord credentials; provider credential values are included in delivery and audit redaction.

## PoC operating model

- The per-session branch and its worktree are the durable repository state. After an interrupted provider turn, AgentRunner proves the old turn stopped, retires the ambiguous provider session, and continues on the same branch with a fresh provider session.
- Any unresolved provider turn blocks AgentRunner startup. Runtime reconciliation retries automatically; `npm run status` reports blocked sessions using bounded hashed references without exposing platform or conversation identifiers.
- Worktrees use the configured retention period, which is 30 days by default. Retention removes only worktrees that Git reports as clean and leaves their local branches available for later reattachment; tracked changes or non-ignored untracked files cause cleanup to be skipped. Automated commit, push, merge, branch deletion, archive workflows, setup hooks, and orphan adoption are outside the PoC.
- Set top-level `executor` to `opencode` (the backward-compatible default) or `claude-code`. This is one provider per runner process, not per-message routing.
- Execution remains unattended. Claude Code defaults to `bypassPermissions`, giving tools the full access of the AgentRunner OS identity. Git worktrees provide repository isolation between conversations but are not an OS sandbox.

## Prerequisites

- Windows with Node.js 22.13 or later, Git, and a repository containing at least one commit.
- For `opencode`, OpenCode installed natively (for example `npm install -g opencode-ai`) and a configured model provider.
- For `claude-code`, a Claude Code login or supported Anthropic/provider credential available to the AgentRunner identity. The Agent SDK dependency includes its platform CLI; `claudeCode.executablePath` can override it.
- An approved Slack app and/or Discord application. See the [Slack checklist](docs/slack-admin-checklist.md) and [Discord checklist](docs/discord-admin-checklist.md).

OpenCode officially recommends WSL for the best Windows compatibility, but this MVP intentionally supports native Windows. The executor interface allows a later WSL or remote-worker implementation without changing Slack or queue code.

## Local Claude Code setup

Select Claude Code without configuring or starting an OpenCode server:

```json
{
  "executor": "claude-code",
  "claudeCode": {
    "workingRepository": "C:\\source\\your-repository",
    "model": "claude-sonnet-4-5",
    "permissionMode": "bypassPermissions"
  }
}
```

`model` and `executablePath` are optional. `permissionMode` defaults to `bypassPermissions`; all Claude Agent SDK modes are accepted. The executor uses streaming SDK input and output, persists Claude's UUID as `providerSessionId`, passes it as `resume` on the next message in the Slack/Discord thread, and reuses the existing branch-backed worktree. Provider authentication, routing, and model variables for Anthropic, Bedrock, Vertex, and Foundry are forwarded from a fixed allowlist; integration tokens are not. The executor verifies the effective permission mode reported by the Claude child and fails rather than silently accepting a downgrade.

## Interactive Windows: OpenCode two-terminal setup

1. Run `npm install`.
2. Copy `config.example.json` to the ignored `config.json` and set `openCode.workingRepository` to a disposable Git repository.
3. Run `opencode --version`, complete the compatibility checks in the [OpenCode upgrade runbook](docs/opencode-upgrade-runbook.md), and replace the `openCode.approvedVersions` placeholder with that exact validated version. An empty or non-matching allowlist prevents the runner from accepting work.

OpenCode exposes an HTTP API used to run model turns and work in the configured repository. The server is bound to the IPv4 loopback address so it is not directly reachable from the LAN, and a password authenticates the AgentRunner client against other local callers. Use one unique password in both terminals. The password authenticates the loopback connection; it does not encrypt HTTP traffic or protect a machine that is already compromised.

### Terminal 1 — OpenCode worker

Open the first PowerShell window, enter a strong password through the masked prompt, and start OpenCode. Do not use `0.0.0.0` or a LAN address.

```powershell
Set-Location C:\path\to\this\repository

$secret = Read-Host "Choose an OpenCode server password" -AsSecureString
$env:OPENCODE_SERVER_PASSWORD = [System.Net.NetworkCredential]::new("", $secret).Password
Remove-Variable secret

opencode serve --hostname 127.0.0.1 --port 4096
```

Leave Terminal 1 running. Stop it with `Ctrl+C` after the gateway has stopped.

### Terminal 2 — AgentRunner client

Open a second PowerShell window. The helper below reads secrets without putting their values in PowerShell command history. Enter the same OpenCode password used in Terminal 1.

```powershell
Set-Location C:\path\to\this\repository

function Set-ProcessSecret([string]$Name) {
    $secure = Read-Host $Name -AsSecureString
    $value = [System.Net.NetworkCredential]::new("", $secure).Password
    [Environment]::SetEnvironmentVariable($Name, $value, "Process")
    $value = $null
}

Set-ProcessSecret OPENCODE_SERVER_PASSWORD
```

Confirm that OpenCode is listening only on loopback:

```powershell
Get-NetTCPConnection -LocalPort 4096 -State Listen |
    Select-Object LocalAddress, LocalPort, OwningProcess
```

The expected `LocalAddress` is exactly `127.0.0.1`. Stop OpenCode if the listener reports `0.0.0.0`, `::`, or a LAN address. For an OpenCode-only validation, run the hardcoded smoke prompt here. If you are preparing Slack or Discord, continue to the appropriate section below; its command sequence runs this smoke test once after `doctor`.

```powershell
npm run smoke
```

An optional prompt can be supplied after `--`, for example `npm run smoke -- "Review the tests"`. Keep Terminal 2 open and retain the `Set-ProcessSecret` helper for the integration-specific credentials below. Process-scoped secrets disappear when this terminal closes.

The smoke command performs the server health and exact-version approval check, creates/reuses its persistent session and worktree, consumes strictly validated SSE events, prints the response, and records usage and tool events.

For a privacy-preserving queue and recovery snapshot, run:

```powershell
npm run status
```

The command opens SQLite read-only, prints job counts and at most 20 hashed blocked-session references, and exits nonzero when reconciliation blocks startup.

## Slack Socket Mode development run

Import [slack/manifest.json](slack/manifest.json) when creating the internal app, install it after approval, and obtain an `xoxb-` bot token plus an `xapp-` app-level token with `connections:write`.

In `config.json`, keep `slack.ingress` set to `"socket"` and configure the exact app, workspace, and tester IDs. Then, in Terminal 2 from the setup above, enter the Slack tokens through masked prompts and start the gateway:

```powershell
Set-ProcessSecret SLACK_BOT_TOKEN
Set-ProcessSecret SLACK_APP_TOKEN
Remove-Item Function:\Set-ProcessSecret

npm run doctor
npm run smoke
npm run dev
```

Enter the `xoxb-...` value for `SLACK_BOT_TOKEN` and the `xapp-...` value for `SLACK_APP_TOKEN`; do not paste either value into source files or ordinary Slack messages. `npm run dev` remains in the foreground and connects to Slack over an outbound WebSocket. Keep both terminals open while testing, stop the gateway with `Ctrl+C`, and then stop OpenCode. Only exact workspace IDs in `slack.allowedWorkspaceIds` and user IDs in `slack.allowedUserIds` can enqueue work. Start with a disposable repository and a single allowlisted tester.

## Multiple testers: one bot per person

Work executes on the machine that receives the Slack event, and Slack load-balances Socket Mode events across every connection open for one app token. Two people running the same app would therefore execute each other's prompts at random. So each tester installs their own Slack app and runs their own runner against their own repository; nothing is shared between them.

```powershell
npm run slack:manifest -- --label "Simon"
```

That prints [slack/manifest.json](slack/manifest.json) with only the app and bot display names changed, which is what Slack's **Create New App → From a manifest** dialog expects — Slack rejects a duplicate app name in a workspace. The full tester-facing procedure is [docs/tester-onboarding.md](docs/tester-onboarding.md); the administrator-facing version is the [Slack checklist](docs/slack-admin-checklist.md).

Adding another person to `slack.allowedUserIds` is a different thing entirely: it grants them unsandboxed execution on *your* machine under *your* credentials. Keep that list to one member ID per installation.

## Slack Events API development run

Set `slack.ingress` to `"events-api"`, set `slack.appId` to the exact Slack application ID, keep `slack.http.host` at the reviewed `127.0.0.1` address, and configure `port`, `eventsPath`, and `healthPath`. Use [slack/manifest.events-api.json](slack/manifest.events-api.json) after replacing its example Request URL with the managed public TLS URL. The public edge must forward only the events and health paths to the private Node listener.

```powershell
Set-ProcessSecret SLACK_BOT_TOKEN
Set-ProcessSecret SLACK_SIGNING_SECRET
Remove-Item Function:\Set-ProcessSecret

npm run doctor
npm run smoke
npm run dev
```

`SLACK_APP_TOKEN` is not required in this mode. Bolt verifies the raw request signature and timestamp. Authorized message events are normalized and committed to the SQLite inbound inbox before the HTTP 200 response is released. Attachment downloads, job submission, and Slack replies occur asynchronously. Pending or interrupted inbox work resumes after restart, while the existing namespaced job key prevents a retried event from creating a second job or initial reply.

The built-in listener is plain HTTP and must not be exposed directly to the internet. Terminate TLS and enforce body, header, connection, request-time, and rate limits at a managed load balancer or hardened reverse proxy.

Production Events API deployments must follow the [public endpoint hardening runbook](docs/public-endpoint-hardening.md). The supplied NGINX configuration exposes only the exact event and health routes, buffers and limits requests before Bolt, applies connection/rate limits, and proxies to the loopback-only Node listener.

## Discord Gateway development run

Set `discord.enabled` to `true`, set `discord.ingress` to `"gateway"`, and configure the exact application, guild, and user IDs. Enable the Guilds, Guild Messages, and Message Content intents for the bot. The command is `/agent prompt:<required> attachment:<optional image>` and is accepted only in a normal guild channel.

```powershell
Set-ProcessSecret DISCORD_BOT_TOKEN
Remove-Item Function:\Set-ProcessSecret

npm run discord:register
npm run doctor
npm run smoke
npm run dev
```

Do not configure an Interactions Endpoint URL in Gateway mode. AgentRunner opens an outbound WebSocket, durably accepts the slash command, acknowledges it without persisting the interaction token, creates a bot-owned public thread, and submits the first job against that thread ID. Later non-bot messages from the initiating user in that registered thread are durably deduplicated by Discord message ID and reuse the same OpenCode session and worktree.

The bot posts `Working…` and edits that message with the redacted result. Results are public to everyone who can view the thread. DMs, slash commands inside threads, unrelated threads, other users, bots, webhooks, and system messages are ignored or denied. Follow the [Discord administrator checklist](docs/discord-admin-checklist.md). The legacy `"http"` ingress accepts slash commands but does not ingest owner thread messages; use Gateway mode for conversations. HTTP mode must follow the shared [public endpoint hardening runbook](docs/public-endpoint-hardening.md).

## Verification

```powershell
npm run check
npm test
npm run build
```

The suite uses a fake authenticated OpenCode HTTP/SSE server but real SQLite persistence and a real temporary Git worktree. No Slack or model credentials are required.

## Windows services

Build first, place a WinSW executable beside `service\AgentRunner.xml` as `AgentRunner.exe`, and copy the selected configuration to `%ProgramData%\AgentRunner\config.json`. Write the absolute `node.exe` location into `%ProgramData%\AgentRunner\node-path.txt`. Install AgentRunner before provisioning so its virtual service identity exists:

```powershell
.\service\AgentRunner.exe install
```

For Claude Code, set `executor` to `claude-code`, set `storage.worktreeRoot` to `worktrees` (relative to the configuration file), and provision an API key from an elevated prompt:

```powershell
.\scripts\Set-AgentRunnerSecrets.ps1 `
  -Executor claude-code `
  -ClaudeCredentialName ANTHROPIC_API_KEY
```

The OAuth-token alternative is:

```powershell
.\scripts\Set-AgentRunnerSecrets.ps1 `
  -Executor claude-code `
  -ClaudeCredentialName CLAUDE_CODE_OAUTH_TOKEN
```

The launcher decrypts the selected credential into the AgentRunner process and defaults `CLAUDE_CONFIG_DIR` to `%ProgramData%\AgentRunner\claude`. The provisioner creates that persistent directory with access for SYSTEM, Administrators, and `NT SERVICE\AgentRunner`. An interactive Claude login belongs to the logged-in desktop user and is useful for development, but it is not service authentication. Provision the API key or OAuth token explicitly for the AgentRunner service; do not assume a developer's profile is visible to the virtual service account.

Claude mode needs only `AgentRunner.exe`; do not install, provision, or start `OpenCodeServer`. Grant `NT SERVICE\AgentRunner` read/execute access to this runner project and the configured source-repository access needed to create Git worktrees, then start it:

```powershell
.\service\AgentRunner.exe start
```

For OpenCode, omission of `-Executor` remains backward compatible. Install `OpenCodeServer.exe`, then provision the existing split gateway/worker bundles:

```powershell
.\service\OpenCodeServer.exe install
.\scripts\Set-AgentRunnerSecrets.ps1 -WorkerSecretNames ANTHROPIC_API_KEY
```

Write the absolute `opencode.exe` location into `%ProgramData%\OpenCodeWorker\opencode-path.txt`. Grant both virtual identities read/execute access to this project; grant `NT SERVICE\OpenCodeServer` only the configured repository/worktree and `.git/worktrees` access needed by execution. Start OpenCode before AgentRunner.

For either executor, `-SlackIngress events-api` stores `SLACK_SIGNING_SECRET` instead of `SLACK_APP_TOKEN`. Add `-EnableDiscord` for Discord. A Discord-only Gateway deployment may use `-SlackIngress disabled -EnableDiscord`; legacy Discord HTTP ingress also requires `-DiscordIngress http`.

## Security boundary

Git worktrees prevent concurrent integration sessions from editing the same checkout, but they are not an OS sandbox. OpenCode retains the stronger gateway/worker identity and secret separation: integration credentials never enter its worker bundle or environment. In Claude mode, the SDK child environment omits Slack and Discord tokens, but this filtering is not an OS security boundary. In-process Claude runs with `bypassPermissions` by default under the same `NT SERVICE\AgentRunner` identity as the gateway and can potentially read the AgentRunner DPAPI bundle or any other resource available to that identity. Deploying Claude mode therefore explicitly accepts that risk. Before expanding beyond trusted testers, move execution into a VM or comparably hardened worker sandbox with network policy. See [the security notes](docs/security.md) and [security review](docs/security-review.md).
