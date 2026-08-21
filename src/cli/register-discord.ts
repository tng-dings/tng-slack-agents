import { loadConfig } from "../config.js";
import { DiscordApiClient } from "../discord/delivery.js";
import { discordGuildCommand } from "../discord/registration.js";
import { errorMessage } from "../values.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  if (!config.discord.enabled || !config.discord.applicationId) {
    throw new Error("Discord must be enabled with discord.applicationId before registering commands");
  }
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN is required to register Discord commands");
  const command = discordGuildCommand(config);
  const api = new DiscordApiClient(botToken);
  for (const guildId of config.discord.allowedGuildIds) {
    const path = `/applications/${encodeURIComponent(config.discord.applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`;
    await api.request("POST", path, command);
    console.log(`Registered /${config.discord.commandName} in guild ${guildId}.`);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
