const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isSupportedImageMime(value: unknown): value is string {
  return typeof value === "string" && IMAGE_MIME_TYPES.has(value);
}
