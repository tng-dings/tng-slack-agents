/**
 * Slack rejects a second app whose name already exists in a workspace, so every
 * tester needs their own name. Personalization renames the app and its bot user
 * and changes nothing else: scopes, events, and transport settings stay exactly
 * as reviewed in slack/manifest.json.
 */

const MAX_APP_NAME_CHARACTERS = 35;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object in the Slack manifest`);
  }
  return value as Record<string, unknown>;
}

function assertValidManifestLabel(label: string): string {
  if (!label) {
    throw new Error('A label is required, for example: npm run slack:manifest -- --label "Simon"');
  }
  if (!LABEL_PATTERN.test(label)) {
    throw new Error(
      "The label must start with a letter or digit and contain only letters, digits, spaces, dots, underscores, or hyphens",
    );
  }
  return label;
}

export function personalizeSlackManifest(manifestValue: unknown, rawLabel: string): Record<string, unknown> {
  const label = assertValidManifestLabel(rawLabel.trim());
  const manifest = record(manifestValue, "manifest");
  const displayInformation = record(manifest.display_information, "display_information");
  const baseName = displayInformation.name;
  if (typeof baseName !== "string" || !baseName.trim()) {
    throw new Error("display_information.name must be a non-empty string in the Slack manifest");
  }

  const name = `${baseName.trim()} (${label})`;
  if (name.length > MAX_APP_NAME_CHARACTERS) {
    throw new Error(
      `The generated app name "${name}" is ${name.length} characters; Slack allows ${MAX_APP_NAME_CHARACTERS}. Use a shorter label.`,
    );
  }

  const features = record(manifest.features, "features");
  return {
    ...manifest,
    display_information: { ...displayInformation, name },
    features: { ...features, bot_user: { ...record(features.bot_user, "features.bot_user"), display_name: name } },
  };
}
