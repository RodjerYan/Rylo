/**
 * UserBar component — shows current user info at the bottom of the sidebar.
 * Subscribes to authStore for user data. Settings button opens settings overlay.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { Disposable } from "@lib/disposable";
import { authStore } from "@stores/auth.store";
import { openSettings } from "@stores/ui.store";
import { openUserProfile } from "@components/UserProfileOverlay";
import { fetchImageAsDataUrl, isSafeUrl, resolveServerUrl } from "@components/message-list/attachments";
import { formatStatusRu, getStatusIndicatorModifier, normalizeUserStatus } from "@lib/presence";
import { getDisplayProfileId } from "@lib/profileId";

export interface UserBarOptions {
  readonly onDisconnect?: () => void;
}

export function createUserBar(options?: UserBarOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  let avatarEl: HTMLDivElement | null = null;
  let avatarTextEl: HTMLSpanElement | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let idEl: HTMLSpanElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let profileClickableArea: HTMLDivElement | null = null;
  let avatarRequestSeq = 0;

  function updateFromState(): void {
    const state = authStore.getState();
    const user = state.user;
    const username = user?.username ?? "Unknown";
    const profileId = getDisplayProfileId(user?.profile_id, user?.id);
    const avatar = typeof user?.avatar === "string" ? user.avatar.trim() : "";
    const liveStatus = normalizeUserStatus(user?.status ?? (state.isAuthenticated ? "online" : "offline"));
    const initial = username.charAt(0).toUpperCase() || "?";

    if (avatarEl !== null && avatarTextEl !== null) {
      avatarRequestSeq += 1;
      const requestId = avatarRequestSeq;
      clearChildren(avatarEl);

      const appendFallback = (): void => {
        if (avatarEl === null || avatarTextEl === null || requestId !== avatarRequestSeq) {
          return;
        }
        setText(avatarTextEl, initial);
        avatarEl.appendChild(avatarTextEl);
        appendStatusDot();
      };

      const appendStatusDot = (): void => {
        if (avatarEl === null || requestId !== avatarRequestSeq) {
          return;
        }
        const statusDot = createElement("div", {
          class: `status-dot status-dot--${getStatusIndicatorModifier(liveStatus)}`,
        });
        avatarEl.appendChild(statusDot);
      };

      if (avatar !== "") {
        const resolved = resolveServerUrl(avatar);
        if (isSafeUrl(resolved)) {
          void fetchImageAsDataUrl(resolved).then((dataUrl) => {
            if (avatarEl === null || requestId !== avatarRequestSeq || dataUrl === null || dataUrl.trim() === "") {
              appendFallback();
              return;
            }
            clearChildren(avatarEl);
            const img = createElement("img", {
              src: dataUrl,
              alt: username,
              style: "width:100%;height:100%;border-radius:50%;object-fit:cover;",
            });
            avatarEl.appendChild(img);
            appendStatusDot();
          }).catch(() => {
            appendFallback();
          });
        } else {
          appendFallback();
        }
      } else {
        appendFallback();
      }
    }
    if (nameEl !== null) {
      setText(nameEl, username);
    }
    if (idEl !== null) {
      setText(idEl, `ID: ${profileId}`);
    }
    if (statusEl !== null) {
      setText(statusEl, formatStatusRu(liveStatus));
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "user-bar", "data-testid": "user-bar" });

    avatarEl = createElement(
      "div",
      { class: "ub-avatar", style: "background: var(--accent); position: relative;" },
    );
    avatarTextEl = createElement("span", {});

    const info = createElement("div", { class: "ub-info" });
    nameEl = createElement("span", { class: "ub-name", "data-testid": "user-bar-name" });
    idEl = createElement("span", { class: "ub-id" });
    statusEl = createElement("span", { class: "ub-status" });
    appendChildren(info, nameEl, idEl, statusEl);
    profileClickableArea = createElement("div", {
      class: "ub-profile-clickable",
      role: "button",
      tabindex: "0",
      "aria-label": "Открыть профиль",
    });
    appendChildren(profileClickableArea, avatarEl, info);
    disposable.onEvent(profileClickableArea, "click", () => {
      const user = authStore.getState().user;
      if (user === null) {
        return;
      }
      openUserProfile({
        id: user.id,
        profileId: user.profile_id,
        username: user.username,
        avatar: user.avatar ?? null,
        banner: user.banner ?? null,
        role: user.role,
      });
    });
    disposable.onEvent(profileClickableArea, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        profileClickableArea?.click();
      }
    });

    const buttons = createElement("div", { class: "ub-controls" });

    const settingsBtn = createElement(
      "button",
      { title: "Settings", "aria-label": "Settings" },
    );
    settingsBtn.appendChild(createIcon("settings", 18));

    disposable.onEvent(settingsBtn, "click", () => {
      openSettings();
    });

    buttons.appendChild(settingsBtn);

    if (options?.onDisconnect !== undefined) {
      const disconnectFn = options.onDisconnect;
      const disconnectBtn = createElement("button", {
        class: "ub-ctrl-btn",
        title: "Switch server",
        "aria-label": "Switch server",
        "data-testid": "disconnect-btn",
      });
      disconnectBtn.appendChild(createIcon("log-out", 18));
      disposable.onEvent(disconnectBtn, "click", () => disconnectFn());
      buttons.appendChild(disconnectBtn);
    }

    appendChildren(root, profileClickableArea, buttons);

    updateFromState();

    disposable.onStoreChange(
      authStore,
      (s) => s.user,
      () => updateFromState(),
    );

    container.appendChild(root);
  }

  function destroy(): void {
    disposable.destroy();
    if (root !== null) {
      root.remove();
      root = null;
    }
    avatarEl = null;
    avatarTextEl = null;
    nameEl = null;
    idEl = null;
    statusEl = null;
    profileClickableArea = null;
  }

  return { mount, destroy };
}
