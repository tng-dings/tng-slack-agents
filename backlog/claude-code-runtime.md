# Claude Code runtime follow-up

## Decision

Keep driving the Agent SDK with one `query()` per turn plus `resume`, rather than
holding a long-lived session object open across turns. Threads sit idle between
messages, so a persistent child process per thread would leak processes for no
gain; the transcript on disk already carries continuity.

The workspace transcript, not the `provider_session_id` column, is treated as the
durable record of a thread: the runner retires that column whenever a turn fails,
so `prepareSession` recovers from `listSessions({ includeWorktrees: false })`.
That flag is load-bearing — every session workspace is a git worktree of one
source repository, so the SDK default would return sibling threads' transcripts.

## Open work

- [ ] Collapse `usageFromResult` to a single source once the aggregation question
  is settled. It currently sums `modelUsage` and falls back to the top-level
  `usage`, which is roughly twelve lines computing the same three numbers twice.
  The SDK type declarations do not say whether the top-level `usage` on a result
  message aggregates the whole turn or reports only the final API call. Settle it
  by running one tool-heavy multi-turn job and comparing the two against the
  billed cost; keep the `modelUsage` sum and delete the fallback if they diverge,
  otherwise keep the top-level read and delete the sum. Cost reporting itself is
  unaffected either way, since it comes from `total_cost_usd`.
- [ ] Replace the name-by-name provider-variable allowlist in
  `src/claude-environment.ts` with prefix matching (`ANTHROPIC_`, `CLAUDE_`,
  `AWS_`, `GOOGLE_`, `VERTEX_`, plus `API_TIMEOUT_MS`, `CLOUD_ML_REGION`, and
  `GCLOUD_PROJECT`) only together with a security-review update. The list is
  currently around forty-seven entries that silently omits any variable a future
  SDK release adds, but [`docs/security-review.md`](../docs/security-review.md)
  describes it as a fixed allowlist, so widening it is a reviewed posture change
  rather than a refactor.
  `CLAUDE_SECRET_NAMES` in the same file must stay name-by-name regardless:
  it drives redaction, and prefix matching there would scrub non-secret values
  such as an AWS region out of every reply and audit record.

## Deferred simplification trigger

Both items are line-count wins behind an unresolved question — one empirical, one
about reviewed security posture. Neither is a prerequisite for Windows-service
validation. Resolve the question first; do not apply either change on the
strength of the smaller diff alone.
