# Tester onboarding: bring your own bot

This is the self-serve path for a tester who wants to run the PoC on their own Windows machine, against their own repository, driven from the shared Slack workspace.

Each tester installs **their own Slack app** with **their own bot token** and runs **their own copy of this runner**. Nobody shares a bot, a token, a queue, or a machine. You DM your bot; your prompts execute on your laptop only.

## Why a bot per tester

The runner is a single process that is both the Slack gateway and the queue worker: it receives your DM and immediately executes it against the OpenCode server on `127.0.0.1`. It has no concept of routing a job to a different machine.

So a shared bot cannot work. In Socket Mode, Slack load-balances events across every open connection for an app token, which means a second person running the same app would receive — and execute — messages meant for someone else, at random. One app per tester keeps ownership unambiguous: your app, your token, your machine.

The cost of this model is that the workspace ends up with one bot per tester, and each install needs administrator approval. At PoC scale (about five testers) that is the cheaper trade.

## What you need before you start

- Windows with Node.js 22.13 or later, Git, and a Slack account in the test workspace.
- Permission from the workspace administrator to create and install an internal app. See the [Slack administrator checklist](slack-admin-checklist.md); the administrator approves the app definition once and then approves each tester's install.
- A **disposable** Git repository with at least one commit, checked out locally. The agent runs unsandboxed shell commands and edits files in worktrees of this repository. Do not point it at anything you cannot afford to lose or leak.
- Expect that repository to accumulate one `agent-runner/<session-hash>` branch per Slack thread. Nothing is committed, pushed, or merged for you, and retention removes only clean worktrees while leaving their branches in place, so you delete them yourself when you are done.
- OpenCode installed (`npm install -g opencode-ai`) and a working model provider.

## 1. Create your own Slack app

Generate a manifest with a name that is unique in the workspace. Slack refuses an app whose name is already taken, which is exactly what happens if two testers paste the same manifest.

```powershell
npm install
npm run slack:manifest -- --label "Simon"
```

This prints a personalized copy of [slack/manifest.json](../slack/manifest.json) — same scopes, same events, same Socket Mode settings as the reviewed definition, with only the app and bot display names changed to `Company Coding Agent (Simon)`. Nothing is written to disk and Slack is not contacted.

Copy the JSON, then at <https://api.slack.com/apps> choose **Create New App → From a manifest**, select the test workspace, and paste it.

Then, in the app's settings:

1. **Basic Information → App-Level Tokens**: generate a token with the `connections:write` scope. This is your `xapp-` token.
2. **Install App**: install to the workspace. This may require administrator approval — request it and wait. After installing, copy the **Bot User OAuth Token**. This is your `xoxb-` token.

Treat both tokens like passwords. Never paste them into source files, config files, or Slack messages.

## 2. Find your Slack IDs

The runner refuses everything that is not an exact match, so both IDs must be right.

- **Member ID**: in Slack, click your avatar → **Profile** → **⋮ More** → **Copy member ID**. It looks like `U0123456789`.
- **Workspace ID**: it looks like `T0123456789`. If you do not know it, leave the example value in place for now — `npm run doctor` in step 4 reports the workspace your bot token actually belongs to, and you can copy the ID out of that failure message.

## 3. Configure the runner

```powershell
Copy-Item config.example.json config.json
```

`config.json` is git-ignored. Edit these fields:

| Field | Value |
| --- | --- |
| `slack.allowedWorkspaceIds` | `["T0123456789"]` — the test workspace |
| `slack.allowedUserIds` | `["U0123456789"]` — **only you** |
| `slack.appId` | your app's ID from Basic Information |
| `openCode.workingRepository` | absolute path to your disposable repository |
| `openCode.approvedVersions` | the exact output of `opencode --version` |

Leave `slack.ingress` as `"socket"`. Events API mode needs a public HTTPS endpoint and is only for the hosted deployment.

Keep `slack.allowedUserIds` to yourself alone. Adding a colleague there does not give them their own agent — it gives them execution on *your* laptop.

If you keep several configurations side by side, point at one with `AGENT_RUNNER_CONFIG`:

```powershell
$env:AGENT_RUNNER_CONFIG = "C:\path\to\config.simon.json"
```

## 4. Run it

Two PowerShell windows, as in the [README](../README.md#interactive-windows-two-terminal-setup). Terminal 1 runs OpenCode:

```powershell
$secret = Read-Host "Choose an OpenCode server password" -AsSecureString
$env:OPENCODE_SERVER_PASSWORD = [System.Net.NetworkCredential]::new("", $secret).Password
Remove-Variable secret

opencode serve --hostname 127.0.0.1 --port 4096
```

Terminal 2 runs the gateway. Enter the same OpenCode password, then your two Slack tokens:

```powershell
function Set-ProcessSecret([string]$Name) {
    $secure = Read-Host $Name -AsSecureString
    $value = [System.Net.NetworkCredential]::new("", $secure).Password
    [Environment]::SetEnvironmentVariable($Name, $value, "Process")
    $value = $null
}

Set-ProcessSecret OPENCODE_SERVER_PASSWORD
Set-ProcessSecret SLACK_BOT_TOKEN
Set-ProcessSecret SLACK_APP_TOKEN
Remove-Item Function:\Set-ProcessSecret

npm run doctor
npm run smoke
npm run dev
```

`npm run doctor` checks your repository, the OpenCode version approval, your token shapes, your allowlist ID formats, and — with one call to Slack — that your bot token actually works and belongs to the workspace you allowlisted. Fix every `FAIL` before moving on. `npm run smoke` proves the model round-trip without Slack. `npm run dev` connects and stays in the foreground.

Now DM your bot in Slack. You should get `Working…` and then a result. Secrets disappear when you close the terminals.

## 5. Verify and contribute

```powershell
npm run check
npm test
npm run build
```

The suite needs no Slack or model credentials: it uses a fake authenticated OpenCode server with real SQLite and a real temporary Git worktree.

Work on a branch, keep `npm run check` and `npm test` green, and open a pull request. If you touch anything security-relevant — scopes, allowlists, ingress, secret handling, the worker boundary — say so explicitly in the description and read [docs/security.md](security.md) first.

Bug reports are more useful with the privacy-preserving snapshot attached:

```powershell
npm run status
```

It prints job counts and hashed blocked-session references. It deliberately does not expose workspace, conversation, or user identifiers, so it is safe to paste into an issue.

## Troubleshooting

**"You are not authorized to use this agent."** Your member ID or workspace ID does not match `config.json`. Re-copy the member ID from your profile and re-run `npm run doctor`.

**The bot never replies at all.** The message was ignored before authorization. The app is DM-only: a channel message, a thread reply from an unsupported subtype, or an edit is dropped silently. DM the bot directly. Also confirm `npm run dev` is still running and reported that it connected.

**`doctor` fails on the OpenCode version.** `openCode.approvedVersions` must contain the exact running version. Follow the [upgrade runbook](opencode-upgrade-runbook.md) after an OpenCode update rather than pasting the new version blindly.

**A run is blocked at startup.** An earlier provider turn was interrupted. `npm run status` exits nonzero and lists the blocked sessions; reconciliation retries automatically, so start the runner again.

## What this model does not give you

- **No sandbox.** Git worktrees separate conversations from each other, not from your machine. The agent runs with your account's reach: your files, your network, your credentials. Use a disposable repository and assume anything on the laptop is in scope.
- **No sharing.** Sessions, worktrees, queue, and audit log are local to your machine. Another tester cannot see or resume your threads.
- **No shared budget.** `limits.dailyCostCap` and the concurrency limits are per-installation, so each tester spends against their own provider credential.
- **No cross-machine routing.** Sending work from Slack to someone else's runner needs the split gateway/worker design, which is not built.
