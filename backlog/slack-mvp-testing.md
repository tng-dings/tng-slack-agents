# Slack MVP testing backlog

This is the actionable gate for the first live Slack test. Do not add a tester to the allowlist until the Slack administrator/security sign-off items are complete.

## Slack administrator and security approval

- [ ] Approve one internal, non-Marketplace custom app named **Company Coding Agent** in the test workspace.
- [ ] Approve Slack's current `agent_view` Agents experience with the Messages tab enabled; `assistant_view` is not requested.
- [ ] Approve only the bot scopes `assistant:write`, `chat:write`, and `im:history`.
- [ ] Approve the bot events `app_context_changed`, `app_home_opened`, and `message.im`.
- [ ] Enable Socket Mode and create one app-level `xapp-` token with only `connections:write`.
- [ ] Install the app and transfer its `xoxb-` bot token through the approved secret channel.
- [ ] Confirm DM-only testing with one named allowlisted tester; do not invite the app to channels or multi-person DMs.
- [ ] Approve the data flow from Slack to company-managed local compute and onward to the separately approved model provider through OpenCode.
- [ ] Approve audit capture of user ID, Slack thread, prompt, tool events, output, usage, cost, and failures.
- [ ] Confirm the audit-data owner, access policy, and proposed 30-day operational retention procedure.
- [ ] Record explicit written sign-off and the incident contact authorized to revoke tokens or uninstall the app.

## Operator preparation

- [ ] Import and validate [`slack/manifest.json`](../slack/manifest.json) in Slack's app-management UI.
- [ ] Record the approved tester's Slack member ID in `slack.allowedUserIds` in the local `config.json`.
- [ ] Store the `xoxb-`, `xapp-`, OpenCode server password, and any provider key using the DPAPI bootstrap; never commit them.
- [ ] Point `openCode.workingRepository` at a disposable Git repository containing at least one commit.
- [ ] Start the authenticated localhost OpenCode service and run `npm run doctor` successfully.
- [ ] Run `npm run smoke` successfully before connecting Slack.
- [ ] Start the gateway with `npm run dev` for the interactive MVP test.

## Live acceptance test

- [ ] An unauthorized Slack member receives a denial and no job executes.
- [ ] The allowlisted tester DMs the app and immediately receives `Working…` in the same thread.
- [ ] OpenCode executes in the thread's detached worktree and the response streams or updates in that Slack thread.
- [ ] A second message in the same thread reuses its OpenCode session and is serialized behind any active job.
- [ ] A different thread receives a distinct persisted session/worktree.
- [ ] Restart the gateway with one queued job and confirm the queued job survives.
- [ ] Restart during an active job and confirm it is marked failed rather than silently replayed.
- [ ] Confirm timeout, queue limit, concurrency limit, daily cost cap, and allowlist enforcement.
- [ ] Inspect SQLite and JSONL audit records for the tester, thread, prompt, tool events, output, usage, cost, and redaction.
- [ ] Revoke or rotate the development tokens after testing if required by company policy.

## Exit criteria

- [ ] Slack administrator/security sign-off is archived.
- [ ] Every Definition-of-Done acceptance check has evidence or a tracked defect.
- [ ] Native Windows execution remains limited to trusted testers until a WSL/VM worker sandbox is available.

The prose request suitable for sending to administrators is retained in [`docs/slack-admin-checklist.md`](../docs/slack-admin-checklist.md).
