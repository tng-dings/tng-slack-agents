# OpenCode runtime follow-up

## Decision

Keep the native authenticated HTTP/SSE integration behind the provider-neutral
executor interface. Do not migrate to BBX or ACP without a concrete limitation
that the current boundary cannot address.

The implemented baseline already provides strict response/event validation,
exact version approval, durable provider-session and worktree persistence,
cancellation, interrupted-turn reconciliation, and deterministic session
branches. Historical implementation details remain in Git history.

## Open work

- [ ] Complete and record a live compatibility run for each OpenCode version
  before adding it to `openCode.approvedVersions`; follow
  [`docs/opencode-upgrade-runbook.md`](../docs/opencode-upgrade-runbook.md).
- [ ] Remove the compatibility-only `opencode_session_id` column only after the
  rollback window is explicitly closed and an additive migration is reviewed.
- [ ] Add explicit workspace lifecycle state and source-revision metadata when a
  hosted worker design needs them.
- [ ] Add bounded setup hooks only after a real repository demonstrates the
  requirement.
- [ ] Add safe orphan discovery and explicit preserve/archive/delete behavior
  before exposing automated workspace cleanup.
- [ ] Add an authenticated workspace status/cleanup command only if operators
  need a platform-facing alternative to `npm run status`.

## ACP experiment trigger

Open an ACP spike only if native HTTP/SSE blocks a required capability or becomes
unmaintainable. The spike must remain behind the executor interface and prove
session continuity, attachments, permission handling, cancellation, crash
recovery, usage/cost reporting, concurrency, and Windows service identity
separation before it can replace the current transport.
