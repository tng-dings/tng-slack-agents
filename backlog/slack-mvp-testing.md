# Slack rollout and Windows-service validation

Local interactive Slack Socket Mode runs are complete with both OpenCode and
Claude Code. This backlog contains only the remaining rollout gate; detailed
completed test transcripts and implementation history belong in deployment
evidence or Git history, not here.

## Slack app setup

- [ ] Import and validate [`slack/manifest.json`](../slack/manifest.json), install
  the app, and record its exact application, workspace, and tester member IDs.
- [ ] Keep testing limited to an exact workspace, one allowlisted user per
  installation, and a disposable or backed-up repository.

## Service preparation

- [ ] Install the WinSW services required by the selected executor: AgentRunner
  only for Claude Code, or AgentRunner and OpenCodeServer for OpenCode.
- [ ] Provision secrets with `Set-AgentRunnerSecrets.ps1`: one AgentRunner bundle
  for Claude Code, or separated gateway/worker bundles for OpenCode.
- [ ] Configure a disposable repository, absolute executable paths, and the
  persistent worktree/data locations used by the service identities.
- [ ] Run `Test-AgentRunnerSecurity.ps1` and archive its passing output.
- [ ] Run `npm run doctor` and `npm run smoke` under the selected service
  topology before enabling Slack.

## Service acceptance

- [ ] Confirm an unauthorized Slack member creates no job.
- [ ] Confirm an allowlisted DM receives progress and a redacted result from the
  deterministic session worktree.
- [ ] Confirm a same-thread follow-up reuses and serializes the provider session,
  while a different thread receives a distinct session/worktree.
- [ ] Confirm queued work survives restart and active work is failed rather than
  silently replayed.
- [ ] Confirm shutdown cancellation and interrupted-session reconciliation for
  the selected executor.
- [ ] In Claude mode, confirm the service uses its persistent
  `CLAUDE_CONFIG_DIR` without an OpenCode bundle or service.
- [ ] In OpenCode mode, confirm gateway/worker identity and secret separation.
- [ ] Confirm allowlist, timeout, queue, concurrency, output, and daily-cost
  limits and inspect audit records for bounded metadata and redaction.
- [ ] Rotate development credentials when required by company policy.

## Exit criteria

- [ ] Service and security evidence is archived.
- [ ] Every acceptance item has evidence or a tracked defect.
- [ ] Native Windows execution remains limited to trusted testers and disposable
  or backed-up repositories until a stronger worker sandbox is approved.
