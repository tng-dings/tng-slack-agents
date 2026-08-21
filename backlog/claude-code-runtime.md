# Claude Code runtime follow-up

Both items are line-count wins behind an unresolved question — one empirical, one
about reviewed security posture. Neither blocks Windows-service validation.
Resolve the question first; do not apply either on the strength of the smaller
diff alone.

- [ ] Collapse `usageFromResult` to one source. It sums `modelUsage` and falls
  back to the top-level `usage`, computing the same three numbers twice, because
  the SDK declarations do not say whether the top-level `usage` aggregates the
  turn or reports only the final API call. Settle it with one tool-heavy
  multi-turn job compared against the billed cost, then delete the loser. Cost
  reporting is unaffected either way — it comes from `total_cost_usd`.
- [ ] Replace the ~47-entry provider-variable allowlist in
  `src/claude-environment.ts` with prefix matching (`ANTHROPIC_`, `CLAUDE_`,
  `AWS_`, `GOOGLE_`, `VERTEX_`, plus `API_TIMEOUT_MS`, `CLOUD_ML_REGION`,
  `GCLOUD_PROJECT`) — but only alongside a
  [security review](../docs/security-review.md) update, which describes it as a
  fixed allowlist. `CLAUDE_SECRET_NAMES` stays name-by-name regardless: it drives
  redaction, and prefix matching would scrub non-secret values such as an AWS
  region out of every reply and audit record.
