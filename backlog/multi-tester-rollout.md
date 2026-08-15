# Multi-tester rollout backlog

This backlog covers running the PoC with a handful of testers, each on their own machine, before any shared or hosted deployment exists. The tester-facing procedure is [`docs/tester-onboarding.md`](../docs/tester-onboarding.md); the first-install gate remains [`slack-mvp-testing.md`](slack-mvp-testing.md).

## Decided

Recorded so they are not relitigated:

- **One Slack app per tester.** The runner executes work on the machine that receives the Slack event, and Slack load-balances Socket Mode events across every connection open for one app token. A shared app would run one tester's prompt on another tester's laptop.
- **Tokens are never transferred.** Each tester generates their own `xoxb-` and `xapp-` values and keeps them in the process environment of the laptop that created them.
- **An installation is never shared.** Sessions, worktrees, queue, audit log, limits, and provider spend are local to one machine and one tester.
- **The live acceptance test runs once, by the operator.** It verifies properties of the runner rather than of an install, so later testers inherit it and confirm only `doctor`, `smoke`, and one DM round-trip.
- **`slack.allowedUserIds` holds exactly one member ID per installation.** Adding a second person does not give them their own agent; it gives them unsandboxed execution on the first person's machine under that person's credentials.

## Open

- [ ] Confirm whether the workspace requires separate administrator approval per app install, and who grants it. Five installs may mean five approvals through one person, which is the likeliest schedule risk in onboarding.
- [ ] Decide the sandbox threshold. Execution is unattended and unsandboxed on each tester's laptop; Git worktrees isolate conversations from each other, not from the machine. Fix the tester count or the exposure at which a WSL/VM worker becomes mandatory rather than recommended, and record it in [`../docs/security.md`](../docs/security.md).
- [ ] Decide provider credentials and cost ownership. Each installation needs its own configured OpenCode provider and enforces its own `limits.dailyCostCap`, so five testers means five independent budgets with no aggregate view.
- [ ] Agree an OpenCode version floor across testers. `openCode.approvedVersions` is per-installation, so testers can silently run different runtimes and report incomparable defects. Decide whether the operator pins one validated version for the cohort.
- [ ] Decide the defect intake path. `npm run status` output is privacy-preserving and safe to paste, but nothing states where reports go or what evidence is expected beyond it.
- [ ] Define offboarding. A departing tester should uninstall their Slack app, revoke both tokens, and delete their `agent-runner/*` branches and worktrees; retention removes only clean worktrees and deliberately leaves branches in place.
- [ ] Consider whether `doctor` should fail, rather than stay silent, when `slack.allowedUserIds` contains more than one entry. It currently validates only identifier shape, and the one-tester-per-install rule is documentation rather than an enforced invariant.

## Explicitly out of scope

Cross-machine routing — a tester sending work from Slack to a runner on another machine — is not built and is not a PoC goal. It requires splitting the gateway from the worker: a `userId → runnerId` routing table, a network job-claim protocol replacing the local SQLite poll in `src/runner.ts`, worker authentication, an outbound-only connection so laptops behind NAT can participate, and result delivery routed back through the gateway so workers never hold the Slack token. Revisit only if per-tester installs prove to be the binding constraint.
