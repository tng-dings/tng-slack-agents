# Slack MVP testing backlog

This is the actionable gate for the first live Slack test. Do not add a tester to the allowlist until the Slack administrator/security sign-off items are complete.

Every section below is completed once, by the operator, against the first installation. Each additional tester then only installs their own app and runner on their own machine, following [`docs/tester-onboarding.md`](../docs/tester-onboarding.md), and confirms that `npm run doctor` and `npm run smoke` pass and that one DM round-trip returns a result. Testers do not repeat the acceptance test; an installation is never shared.

## Slack administrator and security approval

- [ ] Approve internal, non-Marketplace custom apps named **Company Coding Agent (*tester*)** in the test workspace, one per tester and capped at five.
- [ ] Approve Slack's current `agent_view` Agents experience with the Messages tab enabled; `assistant_view` is not requested.
- [ ] Approve only the bot scopes `assistant:write`, `chat:write`, `files:read`, and `im:history`.
- [ ] Approve the bot events `app_home_opened` and `message.im`.
- [ ] Enable Socket Mode and create one app-level `xapp-` token with only `connections:write`.
- [ ] Approve each tester's install; every tester generates and keeps their own `xoxb-` and `xapp-` tokens, so no token is transferred.
- [ ] Confirm DM-only testing with one exact workspace ID and, per install, only that install's own tester; do not invite the apps to channels or multi-person DMs.
- [ ] Approve the data flow from Slack to company-managed local compute and onward to the separately approved model provider through the selected executor.
- [ ] Approve audit capture of user ID, Slack thread, content hashes/lengths, tool metadata, usage, cost, and failures.
- [ ] Confirm the audit-data owner, access policy, and automatic 30-day retention.
- [ ] Record explicit written sign-off and the incident contact authorized to revoke tokens or uninstall the app.

## Operator preparation

- [ ] Import and validate [`slack/manifest.json`](../slack/manifest.json) in Slack's app-management UI; testers install `npm run slack:manifest -- --label "<tester>"` output, which differs only in the app and bot display names.
- [ ] Record the approved workspace ID in `slack.allowedWorkspaceIds` and tester ID in `slack.allowedUserIds`.
- [ ] Install the WinSW services required by the selected executor: AgentRunner only for Claude Code, or AgentRunner plus OpenCodeServer for OpenCode.
- [ ] Provision the selected executor with `Set-AgentRunnerSecrets.ps1`: one AgentRunner DPAPI bundle containing the Claude credential in Claude mode, or separate gateway/worker bundles in OpenCode mode.
- [ ] Run `Test-AgentRunnerSecurity.ps1` against the installed executor and archive its passing output with the approval ticket.
- [ ] Point the selected executor's `workingRepository` at a disposable Git repository containing at least one commit.
- [ ] In OpenCode mode, start the authenticated loopback-only OpenCode service. Claude mode must not require an OpenCode installation, bundle, or service.
- [ ] Run `npm run doctor` and `npm run smoke` successfully with the selected executor before connecting Slack.
- [ ] Start the gateway with `npm run dev` for the interactive MVP test.

## Local executor evidence — 2026-08-16

Evidence recorded against commit `5cec5cc` on native Windows:

- [x] `npm run check` passed.
- [x] `npm test` passed all 81 tests, including Claude environment filtering, permission-mode downgrade detection, cancellation mapping, Windows provisioning assertions, OpenCode regression coverage, and branch-backed workspace lifecycle tests.
- [x] `npm run security:audit` reported zero vulnerabilities at the configured severity threshold.
- [x] `git diff --check` passed.
- [x] Claude Code authenticated with a long-lived `CLAUDE_CODE_OAUTH_TOKEN` while `ANTHROPIC_API_KEY` was absent.
- [x] `npm run doctor` accepted the configured Claude SDK executable and Slack Socket Mode credential shapes.
- [x] A first Claude smoke turn created a file in the deterministic branch-backed worktree and successfully ran `git status --short` under `bypassPermissions`.
- [x] A second Claude smoke turn reused the same worktree and durable Claude UUID through SDK `resume`, preserving the first turn and appending the requested second line.
- [x] Live testing exposed that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the pinned Claude child out of `bypassPermissions`. Commit `5cec5cc` stopped forcing that incompatible setting, added fail-closed effective-mode verification, retained Slack/Discord child-environment exclusion, and documented provider-credential exposure to Claude tool subprocesses.
- [x] Failed Claude smoke databases, audits, transcripts, and session-environment directories were removed; the successful two-turn state was normalized to the canonical local paths.
- [x] The operator reports that the equivalent OpenCode local path has passed through this pre-service point.

This evidence does not yet cover WinSW installation, DPAPI provisioning under the virtual service identity, service ACL validation, live Slack execution, graceful service cancellation, interrupted-session restart recovery, or the final OpenCode service regression. Those remain required below.

## Live acceptance test

Run once by the operator. The behavior verified here is a property of the runner, not of an individual install, so later testers inherit it.

- [ ] An unauthorized Slack member receives a denial and no job executes.
- [ ] The allowlisted tester DMs the app and immediately receives `Working…` in the same thread.
- [ ] The selected executor runs in the thread's deterministic `agent-runner/<session-hash>` branch worktree and the response is delivered in that Slack thread.
- [ ] A second message in the same thread reuses its durable provider session and is serialized behind any active job.
- [ ] A different thread receives a distinct persisted session/worktree.
- [ ] Restart the gateway with one queued job and confirm the queued job survives.
- [ ] Restart during an active job and confirm it is marked failed rather than silently replayed.
- [ ] In Claude mode, confirm shutdown cancellation terminates the SDK child and restart recovery retires the interrupted Claude UUID before later work proceeds with a replacement session.
- [ ] In Claude mode, confirm the service persists `CLAUDE_CONFIG_DIR` under `%ProgramData%\AgentRunner\claude` and operates without an OpenCode bundle or service.
- [ ] In OpenCode mode, confirm the existing gateway/worker identity separation and service smoke test still pass.
- [ ] Confirm timeout, queue limit, concurrency limit, daily cost cap, and allowlist enforcement.
- [ ] Inspect SQLite and JSONL audit records for metadata-only content hashes/lengths, tool metadata, usage, cost, failures, and redaction.
- [ ] Revoke or rotate the development tokens after testing if required by company policy.

## Exit criteria

- [ ] Slack administrator/security sign-off is archived.
- [ ] Every Definition-of-Done acceptance check has evidence or a tracked defect.
- [ ] Native Windows execution remains limited to trusted testers until a WSL/VM worker sandbox is available.

The prose request suitable for sending to administrators is retained in [`docs/slack-admin-checklist.md`](../docs/slack-admin-checklist.md).
