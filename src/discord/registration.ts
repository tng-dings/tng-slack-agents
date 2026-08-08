import type { RunnerConfig } from "../config.js";

export interface DiscordGuildCommandDefinition {
  readonly name: string;
  readonly type: 1;
  readonly description: string;
  readonly options: readonly [
    {
      readonly name: "prompt";
      readonly description: string;
      readonly type: 3;
      readonly required: true;
      readonly min_length: 1;
      readonly max_length: number;
    },
    {
      readonly name: "attachment";
      readonly description: string;
      readonly type: 11;
      readonly required: false;
    },
  ];
}

/** Builds only fields accepted by Discord's application-command option schema. */
export function discordGuildCommand(config: RunnerConfig): DiscordGuildCommandDefinition {
  return {
    name: config.discord.commandName,
    type: 1,
    description: "Run an allowlisted coding-agent task",
    options: [
      {
        name: "prompt",
        description: "What the coding agent should do",
        type: 3,
        required: true,
        min_length: 1,
        max_length: Math.min(6_000, config.limits.maxPromptCharacters),
      },
      {
        name: "attachment",
        description: "Optional screenshot or image",
        type: 11,
        required: false,
      },
    ],
  };
}
