/** Normalize profile media URL values; empty strings are treated as missing. */
export function normalizeProfileMedia(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() === "" ? null : value;
}

