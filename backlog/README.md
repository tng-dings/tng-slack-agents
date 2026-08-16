# Backlog

This directory contains only open work and decision records. Implemented
behavior belongs in [`docs/architecture.md`](../docs/architecture.md), operator
instructions belong in `docs/`, and completed work remains available through Git
history rather than as checked-off milestone lists.

## Current housekeeping

1. [Repository consolidation](repository-consolidation.md) — inspect module
   ownership, duplicated utilities, naming, and dead compatibility surface
   before adding another deployment target.
2. Keep `npm run check`, `npm test`, `npm run build`, and
   `npm run security:audit` green throughout cleanup.

## Next validation gates

1. [Slack MVP and Windows-service validation](slack-mvp-testing.md) — local
   Socket Mode testing is complete for OpenCode and Claude Code; service identity,
   provisioning, restart, and security evidence remain open.
2. [HTTP endpoint deployment evidence](../docs/public-endpoint-hardening.md) —
   both platform receivers exist, but a deployed TLS edge, reachability, time,
   and log-redaction checks cannot be proven by repository tests.
3. [Cloud architecture](integrations-http-cloud-roadmap.md) — decide the first
   hosted operating model before implementing AWS infrastructure.

## Deferred product and maintenance work

- [OpenCode runtime and workspace follow-up](opencode-runtime.md)

Items in this section are not prerequisites for the housekeeping pass or the
first Windows-service validation unless that work uncovers a direct dependency.
