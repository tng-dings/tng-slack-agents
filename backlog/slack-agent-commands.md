# Slack agent commands

## Goal

Add an explicit, authenticated command surface in Slack for inspecting and cleaning up agent-runner workspace resources. This is deferred work and is not part of deterministic branch-backed worktree provisioning.

## Required behavior

- [ ] Define an unambiguous command syntax or Slack action that cannot be mistaken for an ordinary agent prompt.
- [ ] Apply the existing exact workspace/user authorization policy before accepting a command.
- [ ] Durably deduplicate commands across Socket Mode and Events API delivery retries.
- [ ] Provide a bounded status response containing the session reference, deterministic local branch, worktree presence, and clean/dirty state.
- [ ] Allow explicit worktree removal only when no job or provider turn is active.
- [ ] Refuse dirty-worktree removal by default and clearly report why it was retained.
- [ ] Keep worktree removal separate from local-branch deletion; branch deletion must require stronger operator authority or explicit confirmation.
- [ ] Never implicitly commit, push, merge, rebase, or delete a remote branch.
- [ ] Audit command acceptance, refusal, and completion without exposing Slack conversation identifiers or repository content.
- [ ] Test command/job races, duplicate delivery, dirty worktrees, branches checked out elsewhere, and partial cleanup failures.

## Open decisions

- Exact reserved text, Slack button/action, or operator-only command.
- Whether allowlisted Slack users may remove only clean worktrees or whether removal remains operator-only.
- Whether local branch deletion is ever exposed through Slack rather than a local administrative CLI.
