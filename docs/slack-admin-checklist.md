# Slack administrator checklist for MVP testing

Execution status and acceptance-test evidence are tracked in [`backlog/slack-mvp-testing.md`](../backlog/slack-mvp-testing.md).

Ask the Slack workspace owner or security administrator to approve the following exact test setup:

1. Permit internal, non-Marketplace custom Slack apps named **Company Coding Agent (*tester*)** in the test workspace — one per tester, capped at five for the PoC. The app code remains on each tester's company laptop; Socket Mode makes outbound WebSocket/API connections only, and no inbound endpoint or external code deployment is used.
2. Permit Slack's **Agents** feature with the current `agent_view` messaging experience and the Messages tab enabled. The older `assistant_view` is not requested.
3. Approve only these bot scopes: `assistant:write`, `chat:write`, `files:read`, and `im:history`.
4. Approve these bot events: `app_home_opened` and `message.im`.
5. Permit Socket Mode and creation of one app-level `xapp-` token with only `connections:write`. No public Request URL is required.
6. Approve each tester's install individually. Every tester generates their own tokens and never transfers them: the `xoxb-` and `xapp-` values stay in the process environment of the laptop that created them, and are not pasted into source control or ordinary Slack messages.
7. Confirm each app is DM-only for the MVP, allowlists one exact workspace ID and **only its own tester's** member ID, and must not be invited into channels or multi-person DMs.
8. Confirm that messages sent to the app—including source snippets and screenshot images—leave Slack for company-managed local compute and may be sent onward to the separately approved model provider through OpenCode.
9. Approve the stated governance: one concurrent job per user and globally, three queued jobs per user, 30-minute timeout, bounded prompt/output/audit sizes, daily cost cap of 5 currency units as reported by OpenCode, and audit logging of user ID, Slack thread, content hashes/lengths, tool metadata, usage, cost, and failures.
10. Agree on who may access local audit metadata and confirm automatic 30-day retention. Completed job prompt/output bodies are removed by default.
11. Give explicit written sign-off before the tester is added to the allowlist, and identify the incident contact who can disable/uninstall the app or revoke its tokens.

The version-controlled app definition is [slack/manifest.json](../slack/manifest.json). Ask the admin to validate that manifest in Slack's app-management UI and report any organization-specific policy or manifest validation error before installation.

Each tester installs a separate app because the runner executes work on the machine that receives the Slack event, and Slack load-balances Socket Mode events across every connection open for one app token. A shared app would therefore run one tester's prompt on another tester's laptop. `npm run slack:manifest -- --label "<tester>"` emits the approved definition above with only the app and bot display names changed, so every install can be diffed against it. The tester-facing procedure is [tester-onboarding.md](tester-onboarding.md).

The technical security-review packet and deploy-time evidence commands are in [security-review.md](security-review.md).
