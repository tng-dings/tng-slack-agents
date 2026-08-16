# Discord Gateway administrator checklist

Discord uses an outbound Gateway WebSocket. A guild-scoped `/agent` command starts a bot-owned public thread, and later messages from the initiating user in that thread continue the same provider session and Git worktree. The integration does not accept DMs or messages from unrelated threads.

## Application setup

1. Create an internal Discord application in the [Developer Portal](https://discord.com/developers/applications).
2. Record its Application ID, create the bot user, reset and securely record its bot token, and disable public installation unless wider installation has been approved.
3. On the **Bot** page, enable the **Message Content Intent**. Guild and Guild Messages are standard intents requested by the runner.
4. Install the application into each approved server with the `applications.commands` and `bot` scopes.
5. Grant only View Channel, Send Messages, Read Message History, Create Public Threads, and Send Messages in Threads in approved parent channels.
6. Enable Developer Mode in Discord and copy the exact guild and user snowflake IDs for the allowlists. Do not use names as authorization identifiers.
7. Leave **Interactions Endpoint URL** empty in Gateway mode. Discord interactions may use the configured HTTP endpoint or the Gateway, not both.

## Runner configuration

Set `discord.enabled` to `true`, `discord.ingress` to `"gateway"`, and configure:

- `applicationId`: the exact Application ID;
- `commandName`: `agent`;
- `allowedGuildIds` and `allowedUserIds`: non-empty exact-ID allowlists;
- `maxOutputCharacters`: the Discord-specific final-output bound.

Slack is enabled unless it is explicitly switched off, so a Discord-only
deployment must also set `slack.enabled` to `false`. Its allowlists may then be
omitted, and no Slack credential is required.

The command is accepted only in a normal guild text channel:

```text
/agent prompt:<required text> attachment:<optional image>
```

The bot creates a public thread named `agent-<short interaction id>`. Its starter message contains no prompt text. The initiating user owns the thread; messages from other users, bots, webhooks, and system sources do not enter the session. Follow-up messages may contain text and at most one Discord-hosted PNG, JPEG, GIF, or WebP image.

## Secrets and command registration

For an interactive development run:

```powershell
$env:OPENCODE_SERVER_PASSWORD = '<server-password>'
$env:DISCORD_BOT_TOKEN = '<bot-token>'
npm run discord:register
npm run doctor
npm run dev
```

`npm run discord:register` creates or updates the guild command in every allowlisted guild. If `commandName` changes, remove the obsolete command in the Developer Portal or through the Discord API.

For a Discord-only Windows service deployment:

```powershell
./scripts/Set-AgentRunnerSecrets.ps1 -SlackIngress disabled -EnableDiscord
```

Discord credentials belong only in the AgentRunner gateway bundle. They must never be copied to the OpenCode worker bundle or provider environment. `discord.ingress: "http"` additionally requires `DISCORD_PUBLIC_KEY` and `-DiscordIngress http` during provisioning. HTTP mode accepts slash commands only; it does not receive ordinary owner messages from the created threads, so Gateway mode is required for conversational follow-ups.

## User-visible behavior

- `/agent` in a normal channel creates a public thread and queues the initial prompt there.
- The bot posts `Working…` in the thread and replaces it with the redacted final result; long results are split into bounded messages.
- Ordinary owner messages in that registered thread are follow-up jobs in the same session and branch-backed worktree.
- Jobs are serialized per thread. The configured per-user queue and concurrency limits still apply.
- `/agent` inside a thread is denied; write an ordinary follow-up message instead.
- Archived/deleted or unregistered threads do not create new sessions automatically.

## Acceptance evidence

Archive the following without secret values:

- `npm run check`, `npm test`, `npm run build`, and `npm run security:audit`;
- `npm run doctor` showing `gateway:agent` for the Discord credential check;
- successful command registration in each allowlisted guild;
- successful Gateway connection without a public Discord listener;
- one `/agent` invocation creating a thread, a completed initial result, and two owner follow-ups sharing the same session/worktree;
- rejection or ignoring of a slash command inside a thread, a different user, a bot/webhook message, an unrelated thread, an oversized prompt/body, and an invalid attachment;
- restart recovery for a queued follow-up and deduplication by Discord interaction/message ID;
- a log and SQLite search for the test prompt, bot token, interaction token, and attachment marker strings, requiring no credential/token matches.

Rotate the bot token immediately on suspected disclosure, recreate the protected gateway bundle, restart AgentRunner, and repeat the connection and delivery checks.
