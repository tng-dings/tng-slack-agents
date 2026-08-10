import { OpenCodeError } from "./errors.js";

export function assertApprovedOpenCodeVersion(version: string, approvedVersions: readonly string[]): void {
  if (!approvedVersions.includes(version)) {
    const configured = approvedVersions.length > 0 ? approvedVersions.join(", ") : "none";
    throw new OpenCodeError(
      `OpenCode ${version} is not approved for this runner (approved exact versions: ${configured})`,
      "OPENCODE_VERSION_UNAPPROVED",
    );
  }
}
