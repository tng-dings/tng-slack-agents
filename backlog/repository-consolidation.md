# Repository consolidation

## Goal

Reduce accidental complexity before Windows-service and hosted-deployment work.
This pass should preserve behavior and avoid speculative abstractions for an AWS
architecture that has not been selected.

## Review sequence

- [ ] Map composition roots and module ownership for integrations, ingress,
  orchestration, persistence, executors, workspaces, and service launchers.
- [ ] Confirm each public barrel export has a current consumer or a deliberate
  test seam.
- [ ] Identify dead compatibility fields, migrations, scripts, manifests, and
  deployment assets; record removal preconditions before deleting them.
- [ ] Consolidate the duplicated HTTP and inbox utilities listed below while
  retaining clear platform-specific call sites.
- [ ] Normalize provider-neutral naming in current docs and generic code while
  keeping provider-specific terminology inside executor implementations.
- [ ] Check configuration defaults, example configuration, CLI validation, and
  service provisioning for drift.
- [ ] Check tests for redundant fixtures, missing ownership boundaries, and
  assertions tied to obsolete implementation details.
- [ ] Re-run all repository checks and update the current architecture if module
  ownership changes materially.

## Constraints

- Do not combine cleanup with a database/queue migration, serverless rewrite, or
  generic plugin framework.
- Preserve both Slack transports, both Discord transports, and both executors.
- Preserve additive database migrations until rollback compatibility has an
  explicit removal decision.
- Treat local `config.json`, `.env`, `data/`, generated output, and installed
  service binaries as operator state, not cleanup targets.
- Make small reviewable changes with focused tests; avoid a repository-wide
  rename unless it removes a demonstrated source of confusion.

## Exit criteria

- Module boundaries are documented and match the code.
- Remaining duplication is either removed or explicitly justified.
- No obsolete deployment claim remains in active documentation.
- The complete verification suite passes from a clean checkout.

## Known duplication

- [ ] Share bounded request-body reading, fixed response headers, and the
  content-free rate-limited rejection logger between Slack and Discord HTTP.
- [ ] Share the durable inbox pump while keeping payload validation and adapter
  dispatch platform-specific.
- [ ] Centralize image MIME types, safe error labels/metadata, and unknown-value
  object coercion.
- [ ] Remove Slack's duplicate HTTP hardening defaults and use the fully
  validated configuration, as Discord already does.

Do not unify platform authorization, normalization, delivery, status codes, or
route rules. No new framework or runtime dependency is needed for this work.
