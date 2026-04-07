export function getDisplayProfileId(profileId?: string | null, fallbackNumericId?: number | null): string {
  const normalized = typeof profileId === "string" ? profileId.trim().toUpperCase() : "";
  if (/^RY\d{6}$/.test(normalized)) {
    return normalized;
  }
  if (typeof fallbackNumericId === "number" && Number.isFinite(fallbackNumericId) && fallbackNumericId > 0) {
    return `RY${String(Math.trunc(fallbackNumericId) % 1_000_000).padStart(6, "0")}`;
  }
  return "RY000000";
}

export function matchesProfileId(query: string, profileId?: string | null, fallbackNumericId?: number | null): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") {
    return false;
  }
  const displayId = getDisplayProfileId(profileId, fallbackNumericId).toLowerCase();
  const numericFallback = typeof fallbackNumericId === "number" && Number.isFinite(fallbackNumericId)
    ? String(Math.trunc(fallbackNumericId))
    : "";
  return displayId.includes(normalizedQuery) || (numericFallback !== "" && numericFallback.includes(normalizedQuery));
}
