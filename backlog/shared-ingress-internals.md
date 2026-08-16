# Shared Slack/Discord ingress internals

## Goal

Remove the near-verbatim duplication that accumulated while the Slack and
Discord transports were built in parallel. Both platforms independently grew a
raw-HTTP front end, a rate-limited rejection logger, and a durable inbox pump
with the same structure and, in places, identical code. This is a
quality/maintenance item: no user-visible behavior should change, and it is not
a prerequisite for any milestone in
[`integrations-http-cloud-roadmap.md`](integrations-http-cloud-roadmap.md).

The risk being paid down is divergence. The credential-redaction defect fixed in
`fix: unify credential redaction and unblock Discord-only config` was exactly
this failure mode: three copies of one list, and the Slack copy silently missed
the Discord bot token. Duplicated code drifts, and the drift is invisible
because each copy reads correctly on its own.

## Duplicated today

| Concern | Slack | Discord |
| --- | --- | --- |
| Bounded request-body buffering | `src/slack/http-ingress.ts` | `src/discord/http-ingress.ts` |
| Empty/JSON response writers with fixed security headers | `src/slack/http-ingress.ts` | `src/discord/http-ingress.ts` |
| Rate-limited, content-free rejection logger and its bucket state | `SlackHttpSecurityLogger` | `DiscordHttpSecurityLogger` |
| Durable inbox `start`/`stop`/`pump`/`process` and retry backoff | `src/slack/inbox.ts` | `src/discord/inbox.ts` |
| `errorLabel` for audit-safe error names | `src/slack/inbox.ts` | `src/discord/inbox.ts` |
| `record()` unknown-to-object coercion | `src/slack/normalization.ts` | `src/discord/normalization.ts`, `src/discord/inbox.ts`, `src/discord/gateway-ingress.ts` |
| Image MIME allowlist | `src/slack/adapter.ts` | `src/discord/normalization.ts`, and inline in `src/claude-code.ts` |
| `errorMetadata` for typed error audit fields | `src/runner.ts` | `src/opencode.ts` |

`defaultSlackHttpHardening` in `src/slack/http-ingress.ts` also restates the
bounds already expressed in `defaults` in `src/config.ts`, and the merge it
performs is dead in practice because `src/slack.ts` always passes a fully
defaulted `config.slack.http`. Discord's `DiscordHttpHardeningOptions =
DiscordConfig["http"]` is the shape to converge on.

## Required behavior

- [ ] Extract one bounded-body reader, response writer, and rejection logger
      used by both HTTP ingresses, keeping each platform's distinct status
      codes, headers, and route rules at the call site.
- [ ] Extract one durable inbox processor parameterized by integration and
      payload type, preserving per-integration claim ordering, the existing
      exponential backoff, and restart recovery.
- [ ] Collapse the image MIME allowlist to one exported constant, including the
      inline copy in the Claude executor.
- [ ] Collapse `errorMetadata` and `errorLabel` to one implementation each.
- [ ] Derive the Slack HTTP hardening bounds from configuration rather than a
      second constant, matching how Discord already does it.
- [ ] Keep both transports' public seams exported from `src/slack.ts` and
      `src/discord.ts` so signature verification and request handling stay
      testable without a live platform.

## Constraints

- Socket Mode and Discord Gateway are the tested transports; Slack Events API
  and legacy Discord HTTP are supported and must not regress. Every existing
  ingress test must pass unchanged, and shared code must not weaken any bound
  asserted by `scripts/Test-AgentRunnerSecurity.ps1` or
  `docs/public-endpoint-hardening.md`.
- Do not unify the two platforms' authorization, normalization, or delivery
  rules. They are deliberately different and belong to their adapters.
- No new runtime dependency. This is extraction, not a framework.

## Open decisions

- Whether the shared HTTP helpers live in a new `src/http/` module or beside the
  existing `src/environment.ts`-style flat utilities.
- Whether the shared inbox processor is a base class or a generic collaborator
  holding the platform handler. The two inboxes differ only in payload
  validation and the adapter method they call.
- Whether `SlackHttpSecurityLogger` keeps implementing Bolt's `Logger` interface
  directly or wraps a shared logger, given that Bolt requires `setLevel`/
  `getLevel` that the Discord logger has no use for.
