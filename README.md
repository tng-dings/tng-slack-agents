# Self-hosted Slack agent runner

This service accepts allowlisted direct messages from a Slack agent app, persists them as jobs in SQLite, and runs them through an authenticated localhost OpenCode server on Windows. Each Slack thread retains one OpenCode session and one detached Git worktree.

## Current MVP behavior

- Slack Bolt with outbound-only Socket Mode and the current `agent_view` experience.
- DM-only messages; bot messages and other conversation types are ignored. Image attachments (screenshots) are downloaded and forwarded to OpenCode as file parts.
- Immediate `Working…` reply after authorization and event deduplication. Live updates are disabled by default so output can be redacted before delivery.
- Durable SQLite queue and OpenCode session mapping keyed by workspace, channel, and thread timestamp.
- Per-thread serialization, per-user/global concurrency limits, queue limit, timeout, allowlist, and daily cost cap.
- Bounded JSONL and SQLite audit records containing content hashes/lengths, usage, failures, and tool metadata; automatic 30-day retention is enabled by default.
- A detached Git worktree per Slack thread. Running work is never silently replayed after a process crash; it is marked failed, while queued jobs survive.
- Separate DPAPI-protected gateway and worker secret bundles, distinct Windows virtual service identities, and explicit denial of Slack credentials in the worker launcher.

## Prerequisites

- Windows with Node.js 22.13 or later, Git, and a repository containing at least one commit.
- OpenCode installed natively, for example `npm install -g opencode-ai`.
- A configured OpenCode model provider. For a service deployment, prefer a provider API key injected by the DPAPI launcher rather than an interactive user login.
- A Slack app approved and installed by the workspace administrators. See [the admin checklist](docs/slack-admin-checklist.md).

OpenCode officially recommends WSL for the best Windows compatibility, but this MVP intentionally supports native Windows. The executor interface allows a later WSL or remote-worker implementation without changing Slack or queue code.

## Manual OpenCode milestone

1. Run `npm install`.
2. Copy `config.example.json` to the ignored `config.json` and set `openCode.workingRepository` to a disposable Git repository.
3. Start OpenCode in one PowerShell window with the same password used by the client:

   ```powershell
   $env:OPENCODE_SERVER_PASSWORD = '<a-long-random-password>'
   opencode serve --hostname 127.0.0.1 --port 4096
   ```

4. In a second window, set only the client-side password and run the hardcoded smoke prompt:

   ```powershell
   $env:OPENCODE_SERVER_PASSWORD = '<the-same-password>'
   npm run smoke
   ```

   An optional prompt can be supplied after `--`, for example `npm run smoke -- "Review the tests"`.

The smoke command performs the server health check, creates/reuses its persistent session and worktree, consumes SSE events, prints the response, and records usage and tool events.

## Slack development run

Import [slack/manifest.json](slack/manifest.json) when creating the internal app, install it after approval, and obtain an `xoxb-` bot token plus an `xapp-` app-level token with `connections:write`.

```powershell
$env:OPENCODE_SERVER_PASSWORD = '<server-password>'
$env:SLACK_BOT_TOKEN = 'xoxb-...'
$env:SLACK_APP_TOKEN = 'xapp-...'
npm run doctor
npm run dev
```

Only exact workspace IDs in `slack.allowedWorkspaceIds` and user IDs in `slack.allowedUserIds` can enqueue work. Start with a disposable repository and a single allowlisted tester.

## Verification

```powershell
npm run check
npm test
npm run build
```

The suite uses a fake authenticated OpenCode HTTP/SSE server but real SQLite persistence and a real temporary Git worktree. No Slack or model credentials are required.

## Windows services

The `service` directory contains WinSW definitions for `OpenCodeServer` and `AgentRunner`. Build first, place a WinSW executable beside each XML using the matching base name (`OpenCodeServer.exe` and `AgentRunner.exe`), and copy `config.json` to `%ProgramData%\AgentRunner\config.json`.

Install both wrappers first so Windows creates their virtual service identities. Do not start them yet:

```powershell
.\service\OpenCodeServer.exe install
.\service\AgentRunner.exe install
```

Then run `scripts\Set-AgentRunnerSecrets.ps1` from an elevated PowerShell prompt. It writes independently encrypted and ACLed bundles: the gateway bundle contains Slack credentials and the OpenCode client password; the worker bundle contains only the OpenCode server password and explicitly named provider credentials. For example:

```powershell
.\scripts\Set-AgentRunnerSecrets.ps1 -WorkerSecretNames ANTHROPIC_API_KEY
```

Write the absolute `node.exe` location into `%ProgramData%\AgentRunner\node-path.txt` and the absolute `opencode.exe` location into `%ProgramData%\OpenCodeWorker\opencode-path.txt`. Grant both virtual identities read/execute access to this runner project so they can load their wrapper scripts. Grant `NT SERVICE\AgentRunner` the source-repository access needed to create Git worktrees, and grant `NT SERVICE\OpenCodeServer` only the configured repository/worktree and `.git/worktrees` access needed by agent execution. Then start both wrappers:

```powershell
.\service\OpenCodeServer.exe start
.\service\AgentRunner.exe start
```

Before service installation, use an interactive development run to validate OpenCode/provider behavior. Service-account provider configuration is separate from the logged-in user's OpenCode profile.

## Security boundary

Git worktrees prevent two Slack threads from editing the same checkout, but they are not an OS sandbox. The gateway and worker now run under different virtual service identities: Slack secrets never enter the OpenCode bundle or its process environment, and gateway-spawned Git commands receive a secret-free allowlisted environment. The worker still has its provider credential and can access resources granted to `NT SERVICE\OpenCodeServer`. Before expanding beyond trusted testers, move execution into a VM or comparably hardened worker sandbox with network policy. See [the security notes](docs/security.md) and [security review](docs/security-review.md).
