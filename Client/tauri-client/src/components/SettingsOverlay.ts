/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Security, Appearance, Notifications, Text & Images, Accessibility, Voice & Audio, Keybinds, Advanced, Logs.
 * Subscribes to uiStore for settingsOpen state.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { DefaultAvatarCategoryResponse, MemberResponse, UserStatus } from "@lib/types";
import { uiStore } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { loadPref, applyTheme, THEMES } from "./settings/helpers";
import type { ThemeName } from "./settings/helpers";
import { getActiveThemeName, restoreTheme } from "@lib/themes";
import { syncOsMotionListener } from "@lib/os-motion";
import { buildAccountTab } from "./settings/AccountTab";
import { buildSecurityTab } from "./settings/SecurityTab";
import { buildAppearanceTab } from "./settings/AppearanceTab";
import { buildNotificationsTab } from "./settings/NotificationsTab";
import { buildTextImagesTab } from "./settings/TextImagesTab";
import { buildAccessibilityTab } from "./settings/AccessibilityTab";
import { createVoiceAudioTab } from "./settings/VoiceAudioTab";
import { buildKeybindsTab } from "./settings/KeybindsTab";
import { buildAdvancedTab } from "./settings/AdvancedTab";
import { createLogsTab } from "./settings/LogsTab";

import { fetchImageAsDataUrl, isSafeUrl, resolveServerUrl } from "./message-list/attachments";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  onClose(): void;
  onChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  onUpdateProfile(patch: { username?: string; avatar?: string; banner?: string }): Promise<void>;
  onUploadProfileMedia?(file: File): Promise<{ id: string; url: string; filename: string }>;
  onListDefaultAvatars?(): Promise<readonly DefaultAvatarCategoryResponse[]>;
  onSelectDefaultAvatar?(category: string, name: string): Promise<MemberResponse>;
  onListDefaultBanners?(): Promise<readonly DefaultAvatarCategoryResponse[]>;
  onSelectDefaultBanner?(category: string, name: string): Promise<MemberResponse>;
  onLogout(): void;
  onDeleteAccount(password: string): Promise<void>;
  onStatusChange(status: UserStatus): void;
  onEnableTotp(password: string): Promise<{ qr_uri: string; backup_codes: string[] }>;
  onConfirmTotp(password: string, code: string): Promise<void>;
  onDisableTotp(password: string): Promise<void>;
  /** When false, the Account tab is hidden (e.g. on the connect page). Defaults to true. */
  isAuthenticated?: boolean;
}

export type TabName = "Account" | "Security" | "Appearance" | "Notifications" | "Text & Images" | "Accessibility" | "Voice & Audio" | "Keybinds" | "Advanced" | "Logs";

const TAB_ICONS: Record<TabName, IconName> = {
  Account: "user",
  Security: "check-square",
  Appearance: "palette",
  Notifications: "bell",
  "Text & Images": "image",
  Accessibility: "eye",
  "Voice & Audio": "mic",
  Keybinds: "keyboard",
  Advanced: "settings",
  Logs: "scroll-text",
};

// ---------------------------------------------------------------------------
// Apply stored appearance (called at app startup)
// ---------------------------------------------------------------------------

/**
 * Apply stored appearance preferences (theme, font size, compact mode).
 * Call at app startup so the UI doesn't flash default styles.
 */
export function applyStoredAppearance(): void {
  const activeThemeName = getActiveThemeName();
  if (activeThemeName in THEMES) {
    applyTheme(activeThemeName as ThemeName);
  } else {
    restoreTheme();
  }
  try {
    const rawAccent = localStorage.getItem("rylo:settings:accentColor");
    if (rawAccent !== null) {
      const accent = JSON.parse(rawAccent);
      if (typeof accent === "string" && /^#[\da-fA-F]{3,8}$/.test(accent)) {
        document.documentElement.style.setProperty("--accent", accent);
        document.body.style.setProperty("--accent", accent);
      }
    }
  } catch {
    // Corrupted localStorage — keep the theme default accent.
  }
  document.documentElement.style.setProperty(
    "--font-size",
    `${loadPref<number>("fontSize", 16)}px`,
  );
  document.documentElement.classList.toggle(
    "compact-mode",
    loadPref<boolean>("compactMode", false),
  );
  document.documentElement.classList.toggle("reduced-motion", loadPref<boolean>("reducedMotion", false));
  document.documentElement.classList.toggle("high-contrast", loadPref<boolean>("highContrast", false));
  document.documentElement.classList.toggle("large-font", loadPref<boolean>("largeFont", false));

  syncOsMotionListener(loadPref<boolean>("syncOsMotion", false));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSettingsOverlay(
  options: SettingsOverlayOptions,
): MountableComponent & { open(): void; close(): void } {
  const ac = new AbortController();
  const authenticated = options.isAuthenticated !== false;
  let root: HTMLDivElement | null = null;
  let contentArea: HTMLDivElement | null = null;
  let pageTitle: HTMLHeadingElement | null = null;
  let activeTab: TabName = authenticated ? "Account" : "Appearance";
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let unsubUi: (() => void) | null = null;
  let unsubAuth: (() => void) | null = null;

  // Stateful tabs — create via factory for proper cleanup on tab switch
  const logsTab = createLogsTab(() => activeTab, ac.signal);
  const voiceTab = createVoiceAudioTab(ac.signal);

  // ---- Tab content builders -------------------------------------------------

  const TAB_BUILDERS: Readonly<Record<TabName, () => HTMLDivElement>> = {
    Account: () => buildAccountTab(options, ac.signal),
    Security: () => buildSecurityTab(options, ac.signal),
    Appearance: () => buildAppearanceTab(ac.signal),
    Notifications: () => buildNotificationsTab(ac.signal),
    "Text & Images": () => buildTextImagesTab(ac.signal),
    Accessibility: () => buildAccessibilityTab(ac.signal),
    "Voice & Audio": () => voiceTab.build(),
    Keybinds: () => buildKeybindsTab(ac.signal),
    Advanced: () => buildAdvancedTab(ac.signal),
    Logs: () => logsTab.build(),
  };

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    clearChildren(contentArea);
    if (pageTitle === null) return;
    pageTitle.textContent = activeTab;
    contentArea.appendChild(pageTitle);
    const builder = TAB_BUILDERS[activeTab];
    contentArea.appendChild(builder());
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab) return;
    // Clean up stateful tabs when switching away
    if (activeTab === "Voice & Audio") voiceTab.cleanup();
    activeTab = tab;
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle("active", name === tab);
      btn.setAttribute("aria-selected", name === tab ? "true" : "false");
    }
    renderActiveTab();
  }

  function show(): void {
    root?.classList.add("open");
  }

  function hide(): void {
    root?.classList.remove("open");
    // Stop camera preview and mic meter when settings overlay closes
    voiceTab.cleanup();
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "settings-overlay", "data-testid": "settings-overlay" });

    // Sidebar
    const sidebar = createElement("div", { class: "settings-sidebar" });

    // User profile section at top of sidebar
    const profileSection = createElement("div", { class: "settings-sidebar-profile" });
    const avatarEl = createElement("div", { class: "settings-sidebar-avatar" });
    const profileInfo = createElement("div", {});
    const profileName = createElement("div", { class: "settings-sidebar-name" });
    const editProfileLink = createElement("div", { class: "settings-sidebar-edit" }, "Edit Profile");
    if (authenticated) {
      editProfileLink.addEventListener("click", () => setActiveTab("Account"), { signal: ac.signal });
    } else {
      editProfileLink.style.display = "none";
    }

    let avatarRequestSeq = 0;
    function updateProfileSidebar(): void {
      const u = authStore.getState().user;
      const username = u?.username ?? "Unknown";
      const initial = (u?.username ?? "U").charAt(0).toUpperCase();
      const avatarStr = typeof u?.avatar === "string" ? u.avatar.trim() : "";

      profileName.textContent = username;
      avatarRequestSeq += 1;
      const requestId = avatarRequestSeq;
      clearChildren(avatarEl);

      const fallback = (): void => {
        if (requestId !== avatarRequestSeq) return;
        avatarEl.textContent = initial;
      };

      if (avatarStr !== "") {
        const resolved = resolveServerUrl(avatarStr);
        if (isSafeUrl(resolved)) {
          void fetchImageAsDataUrl(resolved).then((dataUrl) => {
            if (requestId !== avatarRequestSeq || dataUrl === null || dataUrl.trim() === "") {
              fallback();
              return;
            }
            clearChildren(avatarEl);
            const img = createElement("img", {
              src: dataUrl,
              alt: username,
              style: "width:100%;height:100%;border-radius:50%;object-fit:cover;",
            });
            avatarEl.appendChild(img);
          }).catch(() => fallback());
        } else {
          fallback();
        }
      } else {
        fallback();
      }
    }

    updateProfileSidebar();
    unsubAuth = authStore.subscribeSelector(
      (s) => s.user,
      () => updateProfileSidebar(),
    );

    appendChildren(profileInfo, profileName, editProfileLink);
    appendChildren(profileSection, avatarEl, profileInfo);
    sidebar.appendChild(profileSection);

    // "User Settings" category — Account + Security (hidden when not authenticated)
    if (authenticated) {
      const userSettingsCat = createElement("div", { class: "settings-cat" }, "User Settings");
      sidebar.appendChild(userSettingsCat);

      const userTabs: readonly TabName[] = ["Account", "Security"];
      for (const name of userTabs) {
        const btn = createElement("button", {
          class: `settings-nav-item${name === activeTab ? " active" : ""}`,
          role: "tab",
          "aria-selected": name === activeTab ? "true" : "false",
        });
        btn.prepend(createIcon(TAB_ICONS[name], 18));
        btn.appendChild(document.createTextNode(name));
        btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
        tabButtons.set(name, btn);
        sidebar.appendChild(btn);
      }
    }

    // "App Settings" category — remaining tabs
    const appSettingsCat = createElement("div", { class: "settings-cat" }, "App Settings");
    sidebar.appendChild(appSettingsCat);

    const appTabs: readonly TabName[] = ["Appearance", "Notifications", "Text & Images", "Accessibility", "Voice & Audio", "Keybinds", "Advanced", "Logs"];
    for (const name of appTabs) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
        role: "tab",
        "aria-selected": name === activeTab ? "true" : "false",
      });
      btn.prepend(createIcon(TAB_ICONS[name], 18));
      btn.appendChild(document.createTextNode(name));
      btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    if (authenticated) {
      // Separator + Log Out at sidebar bottom
      const logoutWrap = createElement("div", { class: "settings-sidebar-logout" });
      const logoutSep = createElement("div", { class: "settings-sep" });
      const logoutBtn = createElement("button", { class: "settings-nav-item danger" }, "Log Out");
      logoutBtn.addEventListener("click", () => options.onLogout(), { signal: ac.signal });
      appendChildren(logoutWrap, logoutSep, logoutBtn);
      sidebar.appendChild(logoutWrap);
    }

    // Page title (h1) at top of content area — created here, inserted in renderActiveTab
    pageTitle = createElement("h1", {}, activeTab);

    // Content
    contentArea = createElement("div", { class: "settings-content" });

    // Close button wrapped with ESC label
    const closeWrap = createElement("div", { class: "settings-close-wrap" });
    const closeBtn = createElement("button", { class: "settings-close-btn" });
    closeBtn.appendChild(createIcon("x", 18));
    closeBtn.addEventListener("click", () => {
      options.onClose();
    }, { signal: ac.signal });
    const escLabel = createElement("div", { class: "settings-esc-label" }, "ESC");
    appendChildren(closeWrap, closeBtn, escLabel);

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && root?.classList.contains("open")) {
        options.onClose();
      }
    }, { signal: ac.signal });

    // Inner panel (Discord-style centered card)
    const panel = createElement("div", { class: "settings-panel" });
    appendChildren(panel, sidebar, contentArea, closeWrap);

    // Click backdrop (outside panel) to close
    root.addEventListener("click", (e: MouseEvent) => {
      if (e.target === root) options.onClose();
    }, { signal: ac.signal });

    root.appendChild(panel);
    renderActiveTab();

    // Subscribe to uiStore for open/close
    unsubUi = uiStore.subscribeSelector(
      (s) => s.settingsOpen,
      (settingsOpen) => {
        if (settingsOpen) {
          show();
        } else {
          hide();
        }
      },
    );

    // Sync initial state
    if (uiStore.getState().settingsOpen) {
      show();
    }

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (unsubUi !== null) {
      unsubUi();
      unsubUi = null;
    }
    if (unsubAuth !== null) {
      unsubAuth();
      unsubAuth = null;
    }
    logsTab.cleanup();
    voiceTab.cleanup();
    tabButtons.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    contentArea = null;
    pageTitle = null;
  }

  function open(): void {
    show();
  }

  function close(): void {
    hide();
  }

  return { mount, destroy, open, close };
}
