import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import {
  formatLastSeenRu,
  formatStatusRu,
  getStatusIndicatorModifier,
  normalizeUserStatus,
} from "@lib/presence";
import { normalizeProfileMedia } from "@lib/profile-media";
import { fetchImageAsDataUrl, isSafeUrl, resolveServerUrl } from "@components/message-list/attachments";
import { getDisplayProfileId } from "@lib/profileId";

export interface UserProfileInput {
  readonly id: number;
  readonly profileId?: string;
  readonly username?: string;
  readonly avatar?: string | null;
  readonly banner?: string | null;
  readonly status?: string;
  readonly lastSeen?: string | null;
}

interface UserProfileResolved {
  readonly id: number;
  readonly profileId: string;
  readonly username: string;
  readonly avatar: string | null;
  readonly banner: string | null;
  readonly status: string;
  readonly lastSeen: string | null;
}

let overlay: HTMLDivElement | null = null;
let card: HTMLDivElement | null = null;
let bannerEl: HTMLDivElement | null = null;
let avatarEl: HTMLDivElement | null = null;
let nameEl: HTMLDivElement | null = null;
let idEl: HTMLDivElement | null = null;
let statusEl: HTMLDivElement | null = null;
let closeBtn: HTMLButtonElement | null = null;
let escHandlerBound = false;
let avatarRequestSeq = 0;
let bannerRequestSeq = 0;

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
  closeBtn = createElement("button", {
    class: "profile-overlay-close",
    type: "button",
    "aria-label": "Закрыть профиль",
  }, "✕");

  appendChildren(body, nameEl, idEl, statusEl);
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
  const authState = authStore.getState();
  const me = authState.user;
  const isSelf = me?.id === input.id;

  const username = input.username
    ?? member?.username
    ?? dmChannel?.recipient.username
    ?? (isSelf ? me?.username : undefined)
    ?? `Пользователь #${input.id}`;

  const avatar = normalizeProfileMedia(input.avatar)
    ?? normalizeProfileMedia(member?.avatar)
    ?? normalizeProfileMedia(dmChannel?.recipient.avatar)
    ?? (isSelf ? normalizeProfileMedia(me?.avatar) : null)
    ?? null;

  const banner = normalizeProfileMedia(input.banner)
    ?? normalizeProfileMedia(member?.banner)
    ?? normalizeProfileMedia(dmChannel?.recipient.banner)
    ?? (isSelf ? normalizeProfileMedia(me?.banner) : null)
    ?? null;

  const status = member?.status
    ?? dmChannel?.recipient.status
    ?? (isSelf
      ? normalizeUserStatus(me?.status ?? (authState.isAuthenticated ? "online" : "offline"))
      : normalizeUserStatus(input.status));
  const lastSeen = input.lastSeen
    ?? member?.lastSeen
    ?? dmChannel?.recipient.lastSeen
    ?? null;

  return {
    id: input.id,
    profileId: getDisplayProfileId(
      input.profileId
      ?? member?.profileId
      ?? dmChannel?.recipient.profileId
      ?? (isSelf ? me?.profile_id : undefined),
      input.id,
    ),
    username,
    avatar,
    banner,
    status,
    lastSeen,
  };
}

function setAvatar(avatar: string | null, username: string): void {
  if (avatarEl === null) {
    return;
  }
  clearChildren(avatarEl);
  const initial = username.charAt(0).toUpperCase() || "?";
  avatarRequestSeq += 1;
  const requestId = avatarRequestSeq;

  if (avatar !== null && avatar.trim() !== "") {
    const resolved = resolveServerUrl(avatar);
    if (!isSafeUrl(resolved)) {
      setText(avatarEl, initial);
      return;
    }
    const placeholder = createElement("div", { class: "profile-overlay-avatar-loading" }, "...");
    avatarEl.appendChild(placeholder);
    void fetchImageAsDataUrl(resolved).then((dataUrl) => {
      if (avatarEl === null || requestId !== avatarRequestSeq) {
        return;
      }
      clearChildren(avatarEl);
      if (dataUrl === null || dataUrl.trim() === "") {
        setText(avatarEl, initial);
        return;
      }
      const image = createElement("img", {
        src: dataUrl,
        alt: username,
        class: "profile-overlay-avatar-img",
      });
      avatarEl.appendChild(image);
    }).catch(() => {
      if (avatarEl !== null && requestId === avatarRequestSeq) {
        clearChildren(avatarEl);
        setText(avatarEl, initial);
      }
    });
    return;
  }

  setText(avatarEl, initial);
}

function setBanner(banner: string | null): void {
  if (bannerEl === null) {
    return;
  }
  bannerRequestSeq += 1;
  const requestId = bannerRequestSeq;
  const defaultGradient = "linear-gradient(135deg, #5865f2 0%, #8b5cf6 100%)";
  if (banner !== null && banner.trim() !== "") {
    // Handle solid color banners (stored as "color:#hex")
    if (banner.startsWith("color:")) {
      const color = banner.slice(6).trim();
      bannerEl.style.backgroundImage = "";
      bannerEl.style.backgroundSize = "";
      bannerEl.style.backgroundPosition = "";
      bannerEl.style.background = color;
      return;
    }

    const resolved = resolveServerUrl(banner);
    if (!isSafeUrl(resolved)) {
      bannerEl.style.backgroundImage = "";
      bannerEl.style.background = defaultGradient;
      return;
    }
    bannerEl.style.backgroundImage = "";
    bannerEl.style.background = "var(--bg-hover)";
    void fetchImageAsDataUrl(resolved).then((dataUrl) => {
      if (bannerEl === null || requestId !== bannerRequestSeq) {
        return;
      }
      if (dataUrl === null || dataUrl.trim() === "") {
        bannerEl.style.backgroundImage = "";
        bannerEl.style.background = defaultGradient;
        return;
      }
      bannerEl.style.backgroundImage = `url("${dataUrl}")`;
      bannerEl.style.backgroundSize = "cover";
      bannerEl.style.backgroundPosition = "center";
    }).catch(() => {
      if (bannerEl !== null && requestId === bannerRequestSeq) {
        bannerEl.style.backgroundImage = "";
        bannerEl.style.background = defaultGradient;
      }
    });
    return;
  }
  bannerEl.style.backgroundImage = "";
  bannerEl.style.background = defaultGradient;
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
    setText(idEl, `ID: ${resolved.profileId}`);
  }
  if (statusEl !== null) {
    const statusLabel = formatStatusRu(resolved.status);
    const seenLabel = resolved.status === "offline"
      ? formatLastSeenRu(resolved.lastSeen)
      : null;
    const statusText = seenLabel !== null
      ? `Статус: ${statusLabel} • Был(а) в сети: ${seenLabel}`
      : `Статус: ${statusLabel}`;
    clearChildren(statusEl);
    appendChildren(
      statusEl,
      createElement("span", {}, statusText),
      createElement("span", {
        class: `profile-status-indicator profile-status-indicator--${getStatusIndicatorModifier(resolved.status)}`,
        "aria-hidden": "true",
      }),
    );
  }
  overlay?.classList.add("open");
}

export function openUserProfileById(userID: number): void {
  openUserProfile({ id: userID });
}

export function closeUserProfile(): void {
  overlay?.classList.remove("open");
}
