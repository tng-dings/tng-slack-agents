import { readFile } from "node:fs/promises";
import path from "node:path";
import { personalizeSlackManifest } from "../slack/manifest.js";
import { errorMessage } from "../values.js";

/**
 * Prints a personalized copy of the reviewed Socket Mode manifest for pasting
 * into Slack's "from a manifest" dialog. Nothing is written to disk and Slack
 * is not contacted.
 */

function parseLabel(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--label");
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : argv.find((value) => !value.startsWith("--"));
  return raw?.trim() ?? "";
}

async function main(): Promise<void> {
  const label = parseLabel(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(path.resolve("slack/manifest.json"), "utf8")) as unknown;
  console.log(JSON.stringify(personalizeSlackManifest(manifest, label), null, 2));
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
