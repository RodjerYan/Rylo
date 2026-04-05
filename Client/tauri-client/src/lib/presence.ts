import type { UserStatus } from "@lib/types";

export function normalizeUserStatus(status: string | UserStatus | null | undefined): UserStatus {
  const normalized = (status ?? "").trim().toLowerCase();
  if (normalized === "online" || normalized === "idle" || normalized === "dnd" || normalized === "offline") {
    return normalized;
  }
  return "offline";
}

function parseServerTimestamp(raw: string | null | undefined): Date | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = raw.trim();
  if (value === "") {
    return null;
  }
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const normalized = sqliteUtc.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function formatStatusRu(status: string | UserStatus): string {
  const normalized = normalizeUserStatus(status);
  if (normalized === "online") {
    return "В сети";
  }
  if (normalized === "idle") {
    return "Нет на месте";
  }
  if (normalized === "dnd") {
    return "Не беспокоить";
  }
  return "Не в сети";
}

export function getStatusIndicatorModifier(status: string | UserStatus): "online" | "idle" | "dnd" | "offline" {
  return normalizeUserStatus(status);
}

export function formatLastSeenRu(lastSeen: string | null | undefined, now: Date = new Date()): string | null {
  const date = parseServerTimestamp(lastSeen);
  if (date === null) {
    return null;
  }

  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffMinutes = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffMinutes < 1) {
    return "только что";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} мин назад`;
  }
  if (diffHours < 24) {
    return `${diffHours} ч назад`;
  }

  const dateLabel = date.toLocaleDateString("ru-RU");
  const timeLabel = date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${dateLabel} ${timeLabel}`;
}

export function formatStatusForDmHeader(status: string | UserStatus, lastSeen?: string | null): string {
  const normalized = normalizeUserStatus(status);
  if (normalized === "offline") {
    const seen = formatLastSeenRu(lastSeen);
    if (seen !== null) {
      return `Был(а) в сети: ${seen}`;
    }
    return "Не в сети";
  }
  return formatStatusRu(normalized);
}
