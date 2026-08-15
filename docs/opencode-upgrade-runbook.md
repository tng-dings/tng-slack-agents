# OpenCode compatibility, upgrade, and rollback runbook

## Policy

AgentRunner accepts work only when the authenticated loopback OpenCode health response is schema-valid and its exact version appears in `openCode.approvedVersions`. Exact versions are used instead of a broad semantic-version range because the runner consumes a manually reviewed HTTP/SSE protocol and OpenCode does not negotiate that protocol version.

Do not add a version merely to bypass startup rejection. Add it only after completing the compatibility validation below. Retain the previously approved version in the list until the rollback window closes.

## Compatibility validation

Perform validation with a disposable repository and the same native-Windows service identity, launcher policy, model configuration, and secret separation used in production.

1. Record the candidate binary path, `opencode --version` output, installer/source, and checksum in the change record.
2. Keep the production runner stopped. Start the candidate OpenCode server on a separate reviewed loopback port with Basic authentication.
3. Run the repository gates:

   ```powershell
   npm run check
   npm test
   npm run build
   npm run security:audit
   ```

4. Temporarily place the exact candidate version in the disposable configuration's `openCode.approvedVersions`, then run `npm run doctor` and `npm run smoke`.
5. Exercise the live compatibility matrix:
   - new session creation and multi-turn session loading;
   - image attachment input;
   - text, usage, tool, permission, error, and status events;
   - unattended permission rejection;
   - timeout and graceful cancellation;
   - runner termination during an active turn, restart abort/status reconciliation, and quarantine when status cannot prove idle;
   - two independent sessions plus serialization of two jobs in one session;
   - retention removal of a clean worktree while preserving its branch, refusal to remove a dirty worktree, and later branch reattachment.
6. Inspect JSONL and SQLite audit events for `opencode_schema_mismatch`, `opencode_unknown_event`, `opencode_version_rejected`, abort failures, or leaked prompt/secret content. Any unexplained occurrence blocks approval.
7. Add the exact candidate version to the production allowlist, deploy the candidate worker, run `npm run doctor`, and only then start AgentRunner and the integration gateways.

## Rollback

1. Stop Slack/Discord ingress and AgentRunner so no new work is accepted.
2. Allow bounded shutdown cancellation to finish. Preserve the database, audit log, worktrees, and OpenCode session data.
3. Restore the previously approved OpenCode binary and worker configuration. Do not reverse or delete the additive SQLite columns.
4. Remove the rejected candidate from `openCode.approvedVersions`, keep the restored exact version, and restart OpenCode.
5. Run `npm run doctor`. Start AgentRunner only after health, schema, authentication, and version checks pass.
6. Run `npm run status`, then start AgentRunner and confirm it does not fail with `SESSION_RECONCILIATION_REQUIRED`. If status is blocked or startup fails, keep gateways stopped, restore OpenCode health, and restart AgentRunner so the old provider turns can be stopped and retired.
7. Preserve audit evidence and document the failing schema/event/version. Add a regression fixture before attempting the upgrade again.

## Emergency override

There is no wildcard or ignore-version switch. An operator may explicitly add an exact version only after documenting the validation evidence. This keeps an accidental worker upgrade from silently accepting user work.
