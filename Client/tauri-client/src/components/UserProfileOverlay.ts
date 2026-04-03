import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { formatLastSeenRu, formatStatusRu } from "@lib/presence";

export interface UserProfileInput {
  readonly id: number;
  readonly username?: string;
  readonly avatar?: string | null;
  readonly banner?: string | null;
  readonly status?: string;
  readonly role?: string;
  readonly lastSeen?: string | null;
}

interface UserProfileResolved {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly banner: string | null;
  readonly status: string;
  readonly role: string;
  readonly lastSeen: string | null;
}

let overlay: HTMLDivElement | null = null;
let card: HTMLDivElement | null = null;
let bannerEl: HTMLDivElement | null = null;
let avatarEl: HTMLDivElement | null = null;
let nameEl: HTMLDivElement | null = null;
let idEl: HTMLDivElement | null = null;
let statusEl: HTMLDivElement | null = null;
let roleEl: HTMLDivElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let escHandlerBound = false;

function translateRole(role: string): string {
  const normalized = role.trim().toLowerCase();
  if (normalized === "owner") return "Владелец";
  if (normalized === "admin") return "Администратор";
  if (normalized === "moderator") return "Модератор";
  return "Участник";
}

function ensureOverlay(): void {
  if (overlay !== null) {
    return;
  }

  overlay = createElement("div", { class: "profile-overlay" });
  card = createElement("div", { class: "profile-overlay-card" });
  bannerEl = createElement("div", { class: "profile-overlay-banner" });
  avatarEl = createElement("div", { class: "profile-overlay-avatar" });
  const body = createElement("div", { class: "profile-overlay-body" });
  nameEl = createElement("div", { class: "profile-overlay-name" });
  idEl = createElement("div", { class: "profile-overlay-id" });
  statusEl = createElement("div", { class: "profile-overlay-meta" });
  roleEl = createElement("div", { class: "profile-overlay-meta" });
  closeBtn = createElement("button", {
    class: "profile-overlay-close",
    type: "button",
    "aria-label": "Закрыть профиль",
  }, "✕");

  appendChildren(body, nameEl, idEl, statusEl, roleEl);
  appendChildren(card, bannerEl, avatarEl, closeBtn, body);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeUserProfile();
    }
  });
  closeBtn.addEventListener("click", () => closeUserProfile());

  if (!escHandlerBound) {
    document.addEventListener("keydown", handleEscClose);
    escHandlerBound = true;
  }
}

function handleEscClose(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    closeUserProfile();
  }
}

function resolveUserProfile(input: UserProfileInput): UserProfileResolved {
  const member = membersStore.getState().members.get(input.id);
  const dmChannel = dmStore.getState().channels.find((dm) => dm.recipient.id === input.id);
  const me = authStore.getState().user;
  const isSelf = me?.id === input.id;

  const username = input.username
    ?? member?.username
    ?? dmChannel?.recipient.username
    ?? (isSelf ? me?.username : undefined)
    ?? `Пользователь #${input.id}`;

  const avatar = input.avatar
    ?? member?.avatar
    ?? dmChannel?.recipient.avatar
    ?? (isSelf ? me?.avatar ?? null : null)
    ?? null;

  const banner = input.banner
    ?? (isSelf ? me?.banner ?? null : null)
    ?? null;

  const status = input.status
    ?? member?.status
    ?? dmChannel?.recipient.status
    ?? (isSelf ? me?.status ?? "offline" : "offline");
  const lastSeen = input.lastSeen
    ?? member?.lastSeen
    ?? dmChannel?.recipient.lastSeen
    ?? null;

  const role = input.role
    ?? member?.role
    ?? (isSelf ? me?.role ?? "member" : "member");

  return {
    id: input.id,
    username,
    avatar,
    banner,
    status,
    role,
    lastSeen,
  };
}

function setAvatar(avatar: string | null, username: string): void {
  if (avatarEl === null) {
    return;
  }
  clearChildren(avatarEl);
  const initial = username.charAt(0).toUpperCase() || "?";

  if (avatar !== null && avatar.trim() !== "") {
    const image = createElement("img", {
      src: avatar,
      alt: username,
      class: "profile-overlay-avatar-img",
    });
    avatarEl.appendChild(image);
    return;
  }

  setText(avatarEl, initial);
}

function setBanner(banner: string | null): void {
  if (bannerEl === null) {
    return;
  }
  if (banner !== null && banner.trim() !== "") {
    bannerEl.style.backgroundImage = `url("${banner}")`;
    bannerEl.style.backgroundSize = "cover";
    bannerEl.style.backgroundPosition = "center";
    return;
  }
  bannerEl.style.backgroundImage = "";
  bannerEl.style.background = "linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%)";
}

export function openUserProfile(input: UserProfileInput): void {
  ensureOverlay();
  const resolved = resolveUserProfile(input);

  setBanner(resolved.banner);
  setAvatar(resolved.avatar, resolved.username);
  if (nameEl !== null) {
    setText(nameEl, resolved.username);
  }
  if (idEl !== null) {
    setText(idEl, `ID: ${resolved.id}`);
  }
  if (statusEl !== null) {
    const statusLabel = formatStatusRu(resolved.status);
    const seenLabel = resolved.status === "offline"
      ? formatLastSeenRu(resolved.lastSeen)
      : null;
    if (seenLabel !== null) {
      setText(statusEl, `Статус: ${statusLabel} • Был(а) в сети: ${seenLabel}`);
    } else {
      setText(statusEl, `Статус: ${statusLabel}`);
    }
  }
  if (roleEl !== null) {
    setText(roleEl, `Роль: ${translateRole(resolved.role)}`);
  }

  overlay?.classList.add("open");
}

export function openUserProfileById(userID: number): void {
  openUserProfile({ id: userID });
}

export function closeUserProfile(): void {
  overlay?.classList.remove("open");
}
