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

export interface UserBarOptions {
  readonly onDisconnect?: () => void;
}

export function createUserBar(options?: UserBarOptions): MountableComponent {
  const disposable = new Disposable();
  let root: HTMLDivElement | null = null;

  // Element references for targeted updates
  let avatarEl: HTMLDivElement | null = null;
  let avatarTextEl: HTMLSpanElement | null = null;
  let nameEl: HTMLSpanElement | null = null;
  let idEl: HTMLSpanElement | null = null;
  let statusEl: HTMLSpanElement | null = null;
  let profileClickableArea: HTMLDivElement | null = null;

  function updateFromState(): void {
    const state = authStore.getState();
    const user = state.user;
    const username = user?.username ?? "Unknown";
    const profileId = user?.profile_id ?? user?.id ?? 0;
    const avatar = user?.avatar ?? null;
    const initial = username.charAt(0).toUpperCase() || "?";

    if (avatarEl !== null && avatarTextEl !== null) {
      clearChildren(avatarEl);
      if (avatar !== null && avatar.trim() !== "") {
        const img = createElement("img", {
          src: avatar,
          alt: username,
          style: "width:100%;height:100%;border-radius:50%;object-fit:cover;",
        });
        avatarEl.appendChild(img);
      } else {
        setText(avatarTextEl, initial);
        avatarEl.appendChild(avatarTextEl);
      }
      const statusDot = createElement("div", {
        class: "status-dot",
        style: "background: var(--green); width: 10px; height: 10px; border-radius: 50%; position: absolute; bottom: 0; right: 0;",
      });
      avatarEl.appendChild(statusDot);
    }
    if (nameEl !== null) {
      setText(nameEl, username);
    }
    if (idEl !== null) {
      setText(idEl, `ID: ${profileId}`);
    }
    if (statusEl !== null) {
      setText(statusEl, state.isAuthenticated ? "В сети" : "Не в сети");
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
        username: user.username,
        avatar: user.avatar ?? null,
        banner: user.banner ?? null,
        status: user.status ?? "offline",
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

    // Initial render
    updateFromState();

    // Subscribe to auth changes
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
