/**
 * Account settings tab — profile editing only.
 * Discord-style profile card with colored banner, overlapping avatar,
 * and separated field rows.
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { fetchImageAsDataUrl, isSafeUrl, resolveServerUrl } from "@components/message-list/attachments";
import type { DefaultAvatarCategoryResponse, UserStatus } from "@lib/types";
import { authStore, updateUser } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { loadPref, savePref } from "./helpers";
import { getDisplayProfileId } from "@lib/profileId";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileCardResult {
  readonly card: HTMLDivElement;
  readonly banner: HTMLDivElement;
  readonly avatarLarge: HTMLDivElement;
  readonly avatarEditBtn: HTMLButtonElement;
  readonly bannerEditBtn: HTMLButtonElement;
  readonly headerName: HTMLDivElement;
  readonly headerId: HTMLDivElement;
  readonly usernameValue: HTMLDivElement;
  readonly editUserProfileBtn: HTMLButtonElement;
  readonly editUsernameBtn: HTMLButtonElement;
}

interface ProfileCardModel {
  readonly username: string;
  readonly profileId: string;
  readonly avatar: string | null;
  readonly banner: string | null;
}

const BANNER_COLOR_PREFIX = "color:";

/** Discord-style preset banner colors. */
const BANNER_PRESET_COLORS: readonly string[] = [
  "#5865f2", // Blurple
  "#eb459e", // Fuchsia
  "#ed4245", // Red
  "#fee75c", // Yellow
  "#57f287", // Green
  "#3ba55d", // Dark Green
  "#0d7377", // Teal
  "#00b4d8", // Sky Blue
  "#5bc0eb", // Light Blue
  "#1d428a", // Navy
  "#9b59b6", // Purple
  "#e67e22", // Orange
  "#e74c3c", // Crimson
  "#f47fff", // Pink
  "#1abc9c", // Aqua
  "#11806a", // Deep Teal
  "#2f3136", // Dark Gray
  "#99aab5", // Light Gray
];

function isBannerColor(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(BANNER_COLOR_PREFIX);
}

function parseBannerColor(value: string): string {
  return value.slice(BANNER_COLOR_PREFIX.length).trim();
}

const PROFILE_MEDIA_MAX_SOURCE_SIZE_BYTES = 20 * 1024 * 1024;
const PROFILE_MEDIA_ACCEPT_ATTR = "image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif";
const PROFILE_MEDIA_ALLOWED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
]);

function isSupportedProfileMediaFile(file: File): boolean {
  const normalizedType = file.type.trim().toLowerCase();
  if (normalizedType.startsWith("image/")) {
    return true;
  }
  const lastDot = file.name.lastIndexOf(".");
  const extension = lastDot >= 0 ? file.name.slice(lastDot).toLowerCase() : "";
  return PROFILE_MEDIA_ALLOWED_EXTENSIONS.has(extension);
}

function formatProfileMediaLimitLabel(): string {
  return `${Math.round(PROFILE_MEDIA_MAX_SOURCE_SIZE_BYTES / (1024 * 1024))} МБ`;
}

// ---------------------------------------------------------------------------
// Profile card builder
// ---------------------------------------------------------------------------

function buildProfileCard(model: ProfileCardModel): ProfileCardResult {
  const card = createElement("div", { class: "account-card" });
  const banner = createElement("div", { class: "account-banner" });
  const bannerEditBtn = createElement("button", {
    class: "account-media-edit-btn account-banner-edit-btn",
    type: "button",
    "aria-label": "Изменить обложку",
    title: "Изменить обложку",
  }) as HTMLButtonElement;
  bannerEditBtn.appendChild(createIcon("pencil", 16));
  bannerEditBtn.style.display = "none";
  banner.appendChild(bannerEditBtn);

  // Avatar overlapping the banner
  const avatarWrap = createElement("div", { class: "account-avatar-wrap account-media-editable" });
  const avatarLarge = createElement("div", { class: "account-avatar-large" });
  const statusDot = createElement("div", { class: "account-status-dot" });
  const avatarEditBtn = createElement("button", {
    class: "account-media-edit-btn account-avatar-edit-btn",
    type: "button",
    "aria-label": "Изменить аватар",
    title: "Изменить аватар",
  }) as HTMLButtonElement;
  avatarEditBtn.appendChild(createIcon("pencil", 14));
  avatarEditBtn.style.display = "none";
  appendChildren(avatarWrap, avatarLarge, statusDot, avatarEditBtn);

  // Header row
  const accountHeader = createElement("div", { class: "account-header" });
  const headerMeta = createElement("div", {});
  const headerName = createElement("div", { class: "account-header-name" }, model.username);
  const headerId = createElement("div", { class: "account-field-value" }, `ID: ${model.profileId}`);
  appendChildren(headerMeta, headerName, headerId);
  const editUserProfileBtn = createElement("button", { class: "ac-btn" }, "Изменить профиль");
  appendChildren(accountHeader, headerMeta, editUserProfileBtn);

  // Username field row
  const fieldsContainer = createElement("div", { class: "account-fields" });
  const usernameField = createElement("div", { class: "account-field" });
  const usernameLeft = createElement("div", {});
  const usernameLabel = createElement("div", { class: "account-field-label" }, "Имя пользователя");
  const usernameValue = createElement("div", { class: "account-field-value" }, model.username);
  appendChildren(usernameLeft, usernameLabel, usernameValue);
  const editUsernameBtn = createElement("button", { class: "account-field-edit" }, "Изменить");
  appendChildren(usernameField, usernameLeft, editUsernameBtn);
  fieldsContainer.appendChild(usernameField);

  appendChildren(card, banner, avatarWrap, accountHeader, fieldsContainer);

  applyProfileBanner(banner, model.banner);
  applyProfileAvatar(avatarLarge, model.avatar, model.username);

  return {
    card,
    banner,
    avatarLarge,
    avatarEditBtn,
    bannerEditBtn,
    headerName,
    headerId,
    usernameValue,
    editUserProfileBtn,
    editUsernameBtn,
  };
}

function applyProfileAvatar(target: HTMLDivElement, avatarUrl: string | null, username: string): void {
  clearChildren(target);
  const fallbackLetter = username.charAt(0).toUpperCase() || "?";
  const requestToken = String(Date.now() + Math.random());
  target.dataset.avatarRequestToken = requestToken;

  if (avatarUrl !== null && avatarUrl.trim() !== "") {
    const resolvedUrl = resolveServerUrl(avatarUrl);
    if (!isSafeUrl(resolvedUrl)) {
      setText(target, fallbackLetter);
      return;
    }
    const placeholder = createElement("div", { class: "account-avatar-loading" }, "...");
    target.appendChild(placeholder);
    void fetchImageAsDataUrl(resolvedUrl).then((dataUrl) => {
      if (target.dataset.avatarRequestToken !== requestToken) {
        return;
      }
      clearChildren(target);
      if (dataUrl !== null && dataUrl.trim() !== "") {
        const img = createElement("img", {
          src: dataUrl,
          alt: username,
          style: "width:100%;height:100%;border-radius:50%;object-fit:cover;",
        });
        target.appendChild(img);
        return;
      }
      setText(target, fallbackLetter);
    }).catch(() => {
      if (target.dataset.avatarRequestToken !== requestToken) {
        return;
      }
      clearChildren(target);
      setText(target, fallbackLetter);
    });
    return;
  }
  setText(target, fallbackLetter);
}

function applyProfileBanner(target: HTMLDivElement, bannerUrl: string | null): void {
  const requestToken = String(Date.now() + Math.random());
  target.dataset.bannerRequestToken = requestToken;

  if (bannerUrl !== null && bannerUrl.trim() !== "") {
    // Handle solid color banners (stored as "color:#hex")
    if (isBannerColor(bannerUrl)) {
      const color = parseBannerColor(bannerUrl);
      target.style.backgroundImage = "";
      target.style.backgroundSize = "";
      target.style.backgroundPosition = "";
      target.style.background = color;
      return;
    }

    const resolvedUrl = resolveServerUrl(bannerUrl);
    if (!isSafeUrl(resolvedUrl)) {
      target.style.backgroundImage = "";
      target.style.background = "var(--accent)";
      return;
    }
    target.style.backgroundImage = "";
    target.style.background = "var(--bg-hover)";
    void fetchImageAsDataUrl(resolvedUrl).then((dataUrl) => {
      if (target.dataset.bannerRequestToken !== requestToken) {
        return;
      }
      if (dataUrl !== null && dataUrl.trim() !== "") {
        target.style.backgroundImage = `url("${dataUrl}")`;
        target.style.backgroundSize = "cover";
        target.style.backgroundPosition = "center";
        return;
      }
      target.style.backgroundImage = "";
      target.style.background = "var(--accent)";
    }).catch(() => {
      if (target.dataset.bannerRequestToken !== requestToken) {
        return;
      }
      target.style.backgroundImage = "";
      target.style.background = "var(--accent)";
    });
    return;
  }
  target.style.backgroundImage = "";
  target.style.background = "var(--accent)";
}

// ---------------------------------------------------------------------------
// Password section builder
// ---------------------------------------------------------------------------

export function buildPasswordSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const separator = createElement("div", { class: "settings-separator" });
  const pwHeader = createElement("div", { class: "settings-section-title" }, "Password and Authentication");

  const oldPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Old password", style: "margin-bottom:12px",
  });
  const newPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "New password", style: "margin-bottom:12px",
  });
  const confirmPw = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Confirm new password", style: "margin-bottom:12px",
  });
  const pwError = createElement("div", { style: "color:var(--red);font-size:13px;margin-bottom:8px" });
  const pwBtn = createElement("button", { class: "ac-btn" }, "Change Password");
  let pwSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  pwBtn.addEventListener("click", () => {
    const oldVal = oldPw.value;
    const newVal = newPw.value;
    const confirmVal = confirmPw.value;

    if (newVal.length < 8) {
      setText(pwError, "New password must be at least 8 characters.");
      return;
    }
    if (newVal !== confirmVal) {
      setText(pwError, "Passwords do not match.");
      return;
    }
    setText(pwError, "");
    void options.onChangePassword(oldVal, newVal).then(() => {
      oldPw.value = "";
      newPw.value = "";
      confirmPw.value = "";
      if (pwSuccessTimer !== null) clearTimeout(pwSuccessTimer);
      pwError.style.color = "var(--green)";
      setText(pwError, "Password changed successfully.");
      pwSuccessTimer = setTimeout(() => {
        setText(pwError, "");
        pwError.style.color = "var(--red)";
        pwSuccessTimer = null;
      }, 3000);
    }).catch((err: unknown) => {
      setText(pwError, err instanceof Error ? err.message : "Failed to change password.");
    });
  }, { signal });

  appendChildren(wrapper, separator, pwHeader, oldPw, newPw, confirmPw, pwError, pwBtn);
  return wrapper;
}

// ---------------------------------------------------------------------------
// TOTP section builder
// ---------------------------------------------------------------------------

function buildTotpEnrollForm(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onEnrolled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Add an extra layer of security to your account.");

  const enableBtn = createElement("button", {
    class: "ac-btn",
    "data-testid": "totp-enable-btn",
  }, "Enable 2FA");

  const formArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Enter your password", style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });
  const submitBtn = createElement("button", { class: "ac-btn" }, "Submit");

  appendChildren(formArea, pwInput, errorEl, submitBtn);

  const enrollArea = createElement("div", { style: "display:none" });

  enableBtn.addEventListener("click", () => {
    enableBtn.style.display = "none";
    formArea.style.display = "block";
    pwInput.value = "";
    setText(errorEl, "");
    pwInput.focus();
  }, { signal });

  submitBtn.addEventListener("click", () => {
    const pw = pwInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    submitBtn.disabled = true;
    setText(submitBtn, "Requesting...");

    void options.onEnableTotp(pw).then((result) => {
      formArea.style.display = "none";
      buildTotpConfirmArea(enrollArea, options, pw, result, signal, onEnrolled);
      enrollArea.style.display = "block";
      submitBtn.disabled = false;
      setText(submitBtn, "Submit");
    }).catch((err: unknown) => {
      setText(errorEl, err instanceof Error ? err.message : "Failed to enable 2FA.");
      submitBtn.disabled = false;
      setText(submitBtn, "Submit");
    });
  }, { signal });

  appendChildren(wrapper, description, enableBtn, formArea, enrollArea);
  return wrapper;
}

function buildTotpConfirmArea(
  container: HTMLDivElement,
  options: SettingsOverlayOptions,
  password: string,
  result: { qr_uri: string; backup_codes: string[] },
  signal: AbortSignal,
  onEnrolled: () => void,
): void {
  // Clear previous content immutably (remove children)
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const qrLabel = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
  }, "Scan this URI with your authenticator app, or copy it manually:");

  const qrUri = createElement("code", {
    style: "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
      "font-family:monospace;font-size:12px;word-break:break-all;margin-bottom:12px;" +
      "color:var(--text-primary);user-select:all",
    "data-testid": "totp-qr-uri",
  }, result.qr_uri);

  const elements: HTMLElement[] = [qrLabel, qrUri];

  if (result.backup_codes.length > 0) {
    const backupLabel = createElement("div", {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
    }, "Save these backup codes in a safe place:");
    const backupList = createElement("code", {
      style: "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
        "font-family:monospace;font-size:12px;white-space:pre-wrap;margin-bottom:12px;" +
        "color:var(--text-primary);user-select:all",
    }, result.backup_codes.join("\n"));
    elements.push(backupLabel, backupList);
  }

  const codeInput = createElement("input", {
    class: "form-input", type: "text",
    placeholder: "6-digit code", maxlength: "6",
    style: "margin-bottom:12px",
    "data-testid": "totp-code-input",
  });

  const confirmError = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });

  const confirmBtn = createElement("button", {
    class: "ac-btn",
    "data-testid": "totp-confirm-btn",
  }, "Verify & Activate");

  confirmBtn.addEventListener("click", () => {
    const code = codeInput.value.trim();
    if (code.length === 0) {
      setText(confirmError, "Please enter the 6-digit code.");
      return;
    }
    setText(confirmError, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Verifying...");

    void options.onConfirmTotp(password, code).then(() => {
      onEnrolled();
    }).catch((err: unknown) => {
      setText(confirmError, err instanceof Error ? err.message : "Invalid verification code.");
      confirmBtn.disabled = false;
      setText(confirmBtn, "Verify & Activate");
    });
  }, { signal });

  elements.push(codeInput, confirmError, confirmBtn);
  appendChildren(container, ...elements);
}

function buildTotpDisableView(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onDisabled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Your account is protected with 2FA.");

  const disableBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "totp-disable-btn",
  }, "Disable 2FA");

  const confirmArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input", type: "password",
    placeholder: "Enter your password", style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "totp-error",
  });
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement("button", { class: "ac-btn account-delete-btn" }, "Confirm Disable");
  const cancelBtn = createElement("button", {
    class: "ac-btn", style: "background:var(--bg-active)",
  }, "Cancel");
  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, pwInput, errorEl, btnRow);

  disableBtn.addEventListener("click", () => {
    disableBtn.style.display = "none";
    confirmArea.style.display = "block";
    pwInput.value = "";
    setText(errorEl, "");
    pwInput.focus();
  }, { signal });

  cancelBtn.addEventListener("click", () => {
    confirmArea.style.display = "none";
    disableBtn.style.display = "";
    pwInput.value = "";
    setText(errorEl, "");
  }, { signal });

  confirmBtn.addEventListener("click", () => {
    const pw = pwInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Disabling...");

    void options.onDisableTotp(pw).then(() => {
      onDisabled();
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to disable 2FA.";
      const is403Required = msg.toLowerCase().includes("required");
      setText(errorEl, is403Required
        ? "2FA is required by this server and cannot be disabled"
        : msg);
      confirmBtn.disabled = false;
      setText(confirmBtn, "Confirm Disable");
    });
  }, { signal });

  appendChildren(wrapper, description, disableBtn, confirmArea);
  return wrapper;
}

export function buildTotpSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { "data-testid": "totp-section" });

  const separator = createElement("div", { class: "settings-separator" });
  const headerRow = createElement("div", {
    style: "display:flex;align-items:center;gap:8px;margin-bottom:4px",
  });
  const header = createElement("div", {
    class: "settings-section-title",
    style: "margin-bottom:0",
  }, "Two-Factor Authentication");

  const statusBadge = createElement("span", {
    "data-testid": "totp-status-badge",
    style: "font-size:12px;padding:2px 8px;border-radius:4px;font-weight:600",
  });

  appendChildren(headerRow, header, statusBadge);

  const contentArea = createElement("div", {});

  function render(): void {
    const enabled = authStore.getState().user?.totp_enabled === true;

    if (enabled) {
      statusBadge.textContent = "Enabled";
      statusBadge.style.background = "var(--green, #3ba55d)";
      statusBadge.style.color = "#fff";
    } else {
      statusBadge.textContent = "Disabled";
      statusBadge.style.background = "var(--bg-active)";
      statusBadge.style.color = "var(--text-muted)";
    }

    while (contentArea.firstChild) {
      contentArea.removeChild(contentArea.firstChild);
    }

    if (enabled) {
      contentArea.appendChild(buildTotpDisableView(options, signal, render));
    } else {
      contentArea.appendChild(buildTotpEnrollForm(options, signal, render));
    }
  }

  render();

  appendChildren(wrapper, separator, headerRow, contentArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Status selector builder
// ---------------------------------------------------------------------------

interface StatusOption {
  readonly value: UserStatus;
  readonly label: string;
  readonly description: string;
  readonly color: string;
}

const STATUS_OPTIONS: readonly StatusOption[] = [
  { value: "online",  label: "Online",          description: "",                                                    color: "#3ba55d" },
  { value: "idle",    label: "Idle",             description: "You will appear as idle",                            color: "#faa61a" },
  { value: "dnd",     label: "Do Not Disturb",   description: "You will not receive desktop notifications",         color: "#ed4245" },
  { value: "offline", label: "Offline",            description: "You will appear offline but still have full access", color: "#747f8d" },
];

function buildStatusSelector(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const separator = createElement("div", { class: "settings-separator" });
  const sectionTitle = createElement("div", { class: "settings-section-title" }, "Status");
  const optionsList = createElement("div", { class: "settings-status-options" });

  const currentStatus = loadPref<UserStatus>("userStatus", "online");
  const rowElements = new Map<UserStatus, HTMLDivElement>();

  for (const opt of STATUS_OPTIONS) {
    const isActive = opt.value === currentStatus;
    const row = createElement("div", {
      class: `settings-status-option${isActive ? " active" : ""}`,
      role: "button",
      tabindex: "0",
      "aria-pressed": isActive ? "true" : "false",
    });

    const dot = createElement("div", { class: "settings-status-dot" });
    dot.style.background = opt.color;

    const labelWrap = createElement("div", {});
    const labelEl = createElement("div", { class: "settings-status-label" }, opt.label);
    appendChildren(labelWrap, labelEl);
    if (opt.description.length > 0) {
      const descEl = createElement("div", { class: "settings-status-desc" }, opt.description);
      labelWrap.appendChild(descEl);
    }

    appendChildren(row, dot, labelWrap);

    const selectStatus = (): void => {
      for (const [, el] of rowElements) {
        el.classList.remove("active");
        el.setAttribute("aria-pressed", "false");
      }
      row.classList.add("active");
      row.setAttribute("aria-pressed", "true");
      savePref("userStatus", opt.value);
      options.onStatusChange(opt.value);
    };

    row.addEventListener("click", selectStatus, { signal });
    row.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectStatus();
      }
    }, { signal });

    rowElements.set(opt.value, row);
    optionsList.appendChild(row);
  }

  appendChildren(wrapper, separator, sectionTitle, optionsList);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Delete account (danger zone) builder
// ---------------------------------------------------------------------------

export function buildDeleteAccountSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const separator = createElement("div", { class: "settings-separator" });
  const header = createElement("div", {
    class: "settings-section-title",
    style: "color:var(--red)",
  }, "Опасная зона");

  const description = createElement("div", {
    style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
  }, "Безвозвратно удалить ваш аккаунт и все связанные с ним данные.");

  const deleteBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "delete-account-trigger",
  }, "Удалить аккаунт");

  // Inline confirmation area (hidden by default)
  const confirmArea = createElement("div", {
    class: "account-delete-confirm",
    style: "display:none",
    "data-testid": "delete-account-confirm-area",
  });

  const warningText = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:12px;line-height:1.4",
  }, "Это действие необратимо. Все ваши данные будут удалены. Введите пароль для подтверждения.");

  const passwordInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: "Введите пароль",
    style: "margin-bottom:12px",
    "data-testid": "delete-account-password",
  });

  const errorEl = createElement("div", {
    style: "color:var(--red);font-size:13px;margin-bottom:8px",
    "data-testid": "delete-account-error",
  });

  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement("button", {
    class: "ac-btn account-delete-btn",
    "data-testid": "delete-account-confirm",
  }, "Подтвердить удаление");
  const cancelBtn = createElement("button", {
    class: "ac-btn",
    style: "background:var(--bg-active)",
  }, "Отмена");

  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, warningText, passwordInput, errorEl, btnRow);

  // Show confirmation area
  deleteBtn.addEventListener("click", () => {
    deleteBtn.style.display = "none";
    confirmArea.style.display = "block";
    passwordInput.value = "";
    setText(errorEl, "");
    passwordInput.focus();
  }, { signal });

  // Cancel — hide confirmation
  cancelBtn.addEventListener("click", () => {
    confirmArea.style.display = "none";
    deleteBtn.style.display = "";
    passwordInput.value = "";
    setText(errorEl, "");
  }, { signal });

  // Confirm delete
  confirmBtn.addEventListener("click", () => {
    const pw = passwordInput.value;
    if (pw.length === 0) {
      setText(errorEl, "Password is required.");
      return;
    }
    setText(errorEl, "");
    confirmBtn.disabled = true;
    setText(confirmBtn, "Deleting...");

    void options.onDeleteAccount(pw).then(() => {
      // Success — cleanup is handled by the callback (clears auth, navigates away)
    }).catch((err: unknown) => {
      setText(errorEl, err instanceof Error ? err.message : "Failed to delete account.");
      confirmBtn.disabled = false;
      setText(confirmBtn, "Confirm Delete");
    });
  }, { signal });

  appendChildren(wrapper, separator, header, description, deleteBtn, confirmArea);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Main tab builder
// ---------------------------------------------------------------------------

const MAX_USERNAME_LEN = 32;

export function buildAccountTab(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });
  const user = authStore.getState().user;
  const username = user?.username ?? "Unknown";
  const profileId = getDisplayProfileId(user?.profile_id, user?.id);
  const avatar = user?.avatar ?? null;
  const banner = user?.banner ?? null;

  // Profile card
  const {
    card,
    banner: bannerEl,
    avatarLarge,
    avatarEditBtn,
    bannerEditBtn,
    headerName,
    headerId,
    usernameValue,
    editUserProfileBtn,
    editUsernameBtn,
  } = buildProfileCard({
    username,
    profileId,
    avatar,
    banner,
  });
  section.appendChild(card);

  // Status selector
  section.appendChild(buildStatusSelector(options, signal));

  // Inline edit form
  const editForm = createElement("div", { class: "setting-row account-username-edit-row", style: "display:none;margin-bottom:16px" });
  const editInput = createElement("input", { class: "form-input", type: "text", placeholder: "Новое имя пользователя" });
  const saveBtn = createElement("button", { class: "ac-btn" }, "Сохранить");
  const cancelBtn = createElement("button", { class: "ac-btn", style: "background:var(--bg-active)" }, "Отмена");
  const actions = createElement("div", { class: "account-username-edit-actions" });
  appendChildren(actions, saveBtn, cancelBtn);
  appendChildren(editForm, editInput, actions);

  const usernameError = createElement("div", { style: "color:var(--red);font-size:13px;margin-top:4px" });
  editForm.appendChild(usernameError);

  let profileEditMode = false;

  function setProfileEditMode(enabled: boolean): void {
    profileEditMode = enabled;
    card.classList.toggle("account-card--editing", enabled);
    syncMediaControlsAvailability();
  }

  const openEditFormWithoutFocus = () => {
    setProfileEditMode(true);
    editForm.style.display = "flex";
    editInput.value = authStore.getState().user?.username ?? "";
  };

  const openEditFormWithFocus = () => {
    openEditFormWithoutFocus();
    editInput.focus();
  };

  editUserProfileBtn.addEventListener("click", openEditFormWithoutFocus, { signal });
  editUsernameBtn.addEventListener("click", openEditFormWithFocus, { signal });

  cancelBtn.addEventListener("click", () => {
    setProfileEditMode(false);
    editForm.style.display = "none";
    setText(usernameError, "");
  }, { signal });

  saveBtn.addEventListener("click", () => {
    const newName = editInput.value.trim();
    if (newName.length < 2 || newName.length > MAX_USERNAME_LEN) {
      setText(usernameError, `Имя пользователя должно быть от 2 до ${MAX_USERNAME_LEN} символов.`);
      return;
    }
    setText(usernameError, "");
    void options.onUpdateProfile({ username: newName }).then(() => {
      const latestUser = authStore.getState().user;
      const effectiveName = latestUser?.username?.trim() !== ""
        ? latestUser?.username ?? newName
        : newName;
      setText(headerName, effectiveName);
      setText(usernameValue, effectiveName);
      applyProfileAvatar(avatarLarge, latestUser?.avatar ?? avatar, effectiveName);
      setProfileEditMode(false);
      editForm.style.display = "none";
    }).catch((err: unknown) => {
      setText(usernameError, err instanceof Error ? err.message : "Не удалось обновить имя пользователя.");
    });
  }, { signal });

  section.appendChild(editForm);

  const mediaError = createElement("div", { class: "account-media-inline-error" });
  section.appendChild(mediaError);

  let mediaUploadInProgress = false;
  let defaultAvatarSelectionInProgress = false;
  let cachedDefaultAvatarCategories: readonly DefaultAvatarCategoryResponse[] | null = null;
  let defaultCatalogPromise: Promise<readonly DefaultAvatarCategoryResponse[]> | null = null;
  let defaultBannerSelectionInProgress = false;
  let cachedDefaultBannerCategories: readonly DefaultAvatarCategoryResponse[] | null = null;
  let defaultBannerCatalogPromise: Promise<readonly DefaultAvatarCategoryResponse[]> | null = null;

  function syncMediaControlsAvailability(): void {
    const uploadDisabledByFeature = options.onUploadProfileMedia === undefined;
    const disabled = !profileEditMode || uploadDisabledByFeature || mediaUploadInProgress || defaultAvatarSelectionInProgress || defaultBannerSelectionInProgress;
    avatarEditBtn.disabled = disabled;
    bannerEditBtn.disabled = disabled;
    const displayStyle = profileEditMode ? "" : "none";
    avatarEditBtn.style.display = displayStyle;
    bannerEditBtn.style.display = displayStyle;
  }

  function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function buildModalShell(title: string): {
    overlay: HTMLDivElement;
    modal: HTMLDivElement;
    body: HTMLDivElement;
    close: () => void;
  } {
    const overlay = createElement("div", { class: "account-media-modal-overlay" });
    const modal = createElement("div", { class: "account-media-modal" });
    const header = createElement("div", { class: "account-media-modal-header" });
    const titleEl = createElement("div", { class: "account-media-modal-title" }, title);
    const closeBtn = createElement("button", {
      class: "account-media-modal-close",
      type: "button",
      "aria-label": "Закрыть",
    }) as HTMLButtonElement;
    closeBtn.appendChild(createIcon("x", 16));
    const body = createElement("div", { class: "account-media-modal-body" });

    const escHandler = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };

    const close = (): void => {
      document.removeEventListener("keydown", escHandler);
      overlay.remove();
    };

    closeBtn.addEventListener("click", close, { signal });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        close();
      }
    }, { signal });

    appendChildren(header, titleEl, closeBtn);
    appendChildren(modal, header, body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", escHandler);
    signal.addEventListener("abort", close, { once: true });

    return { overlay, modal, body, close };
  }

  function syncProfilePreviewWithStore(fallback?: {
    username?: string;
    avatar?: string | null;
    banner?: string | null;
    profileId?: string;
  }): void {
    const latestUser = authStore.getState().user;
    const latestName = fallback?.username
      ?? (latestUser?.username?.trim() !== ""
        ? latestUser?.username ?? username
        : username);
    const latestAvatar = fallback?.avatar ?? latestUser?.avatar ?? avatar;
    const latestBanner = fallback?.banner ?? latestUser?.banner ?? banner;
    const latestProfileId = getDisplayProfileId(
      latestUser?.profile_id ?? fallback?.profileId,
      latestUser?.id ?? user?.id,
    );

    setText(headerName, latestName);
    setText(usernameValue, latestName);
    setText(headerId, `ID: ${latestProfileId}`);
    applyProfileAvatar(avatarLarge, latestAvatar, latestName);
    applyProfileBanner(bannerEl, latestBanner);
  }

  async function ensureDefaultAvatarCatalog(): Promise<readonly DefaultAvatarCategoryResponse[]> {
    if (cachedDefaultAvatarCategories !== null) {
      return cachedDefaultAvatarCategories;
    }
    if (options.onListDefaultAvatars === undefined) {
      return [];
    }
    if (defaultCatalogPromise !== null) {
      return defaultCatalogPromise;
    }
    defaultCatalogPromise = options.onListDefaultAvatars().then((categories) => {
      cachedDefaultAvatarCategories = categories;
      return categories;
    }).finally(() => {
      defaultCatalogPromise = null;
    });
    return defaultCatalogPromise;
  }

  async function uploadAndApplyProfileMedia(kind: "avatar" | "banner", file: File): Promise<void> {
    if (options.onUploadProfileMedia === undefined) {
      setText(mediaError, "Загрузка медиа недоступна на этом экране.");
      return;
    }
    mediaUploadInProgress = true;
    setText(mediaError, "");
    syncMediaControlsAvailability();
    try {
      const uploaded = await options.onUploadProfileMedia(file);
      if (kind === "avatar") {
        await options.onUpdateProfile({ avatar: uploaded.url });
        syncProfilePreviewWithStore({ avatar: uploaded.url });
      } else {
        await options.onUpdateProfile({ banner: uploaded.url });
        syncProfilePreviewWithStore({ banner: uploaded.url });
      }
    } catch (err: unknown) {
      setText(mediaError, err instanceof Error ? err.message : "Не удалось загрузить изображение профиля.");
      throw err;
    } finally {
      mediaUploadInProgress = false;
      syncMediaControlsAvailability();
    }
  }

  async function selectDefaultAvatar(category: string, avatarName: string, previewUrl?: string): Promise<void> {
    if (options.onSelectDefaultAvatar === undefined) {
      setText(mediaError, "Выбор стандартного аватара недоступен.");
      return;
    }
    if (defaultAvatarSelectionInProgress) {
      return;
    }

    defaultAvatarSelectionInProgress = true;
    setText(mediaError, "");
    syncMediaControlsAvailability();
    const previousAvatar = authStore.getState().user?.avatar ?? avatar;
    try {
      if (previewUrl !== undefined) {
        updateUser({ avatar: previewUrl });
        syncProfilePreviewWithStore({ avatar: previewUrl });
      }
      const updated = await options.onSelectDefaultAvatar(category, avatarName);
      syncProfilePreviewWithStore({
        username: updated.username,
        avatar: updated.avatar ?? null,
        banner: updated.banner ?? null,
        profileId: updated.profile_id,
      });
      return;
    } catch (err: unknown) {
      if (previewUrl !== undefined) {
        updateUser({ avatar: previousAvatar });
        syncProfilePreviewWithStore({ avatar: previousAvatar });
      }
      setText(mediaError, err instanceof Error ? err.message : "Не удалось выбрать стандартный аватар.");
      throw err;
    } finally {
      defaultAvatarSelectionInProgress = false;
      syncMediaControlsAvailability();
    }
  }

  async function ensureDefaultBannerCatalog(): Promise<readonly DefaultAvatarCategoryResponse[]> {
    if (cachedDefaultBannerCategories !== null) {
      return cachedDefaultBannerCategories;
    }
    if (options.onListDefaultBanners === undefined) {
      return [];
    }
    if (defaultBannerCatalogPromise !== null) {
      return defaultBannerCatalogPromise;
    }
    defaultBannerCatalogPromise = options.onListDefaultBanners().then((categories) => {
      cachedDefaultBannerCategories = categories;
      return categories;
    }).finally(() => {
      defaultBannerCatalogPromise = null;
    });
    return defaultBannerCatalogPromise;
  }

  async function selectDefaultBannerRaw(category: string, bannerName: string, previewUrl?: string): Promise<void> {
    if (options.onSelectDefaultBanner === undefined) {
      setText(mediaError, "Выбор стандартной обложки недоступен.");
      return;
    }
    if (defaultBannerSelectionInProgress) {
      return;
    }

    defaultBannerSelectionInProgress = true;
    setText(mediaError, "");
    syncMediaControlsAvailability();
    const previousBanner = authStore.getState().user?.banner ?? banner;
    try {
      if (previewUrl !== undefined) {
        updateUser({ banner: previewUrl });
        syncProfilePreviewWithStore({ banner: previewUrl });
      }
      const updated = await options.onSelectDefaultBanner!(category, bannerName);
      syncProfilePreviewWithStore({
        username: updated.username,
        avatar: updated.avatar ?? null,
        banner: updated.banner ?? null,
        profileId: updated.profile_id,
      });
      return;
    } catch (err: unknown) {
      if (previewUrl !== undefined) {
        updateUser({ banner: previousBanner });
        syncProfilePreviewWithStore({ banner: previousBanner });
      }
      setText(mediaError, err instanceof Error ? err.message : "Не удалось выбрать стандартную обложку.");
      throw err;
    } finally {
      defaultBannerSelectionInProgress = false;
      syncMediaControlsAvailability();
    }
  }

  function openCropModal(kind: "avatar" | "banner"): void {
    const title = kind === "avatar" ? "Изменить аватар" : "Изменить обложку";
    const modalShell = buildModalShell(title);
    const modalSignal = new AbortController();
    const closeModal = (): void => {
      modalSignal.abort();
      modalShell.close();
    };

    const isAvatar = kind === "avatar";
    const previewWidth = isAvatar ? 280 : 600;
    const previewHeight = isAvatar ? 280 : 200;
    const outputWidth = isAvatar ? 640 : 1600;
    const outputHeight = isAvatar ? 640 : 534;

    const description = createElement("div", { class: "account-media-modal-note" },
      isAvatar
        ? "Перетащите изображение и используйте колесо мыши или ползунок для масштабирования."
        : "Выберите обложку, затем сдвиньте и приблизьте нужную часть.");
    const pickerRow = createElement("div", { class: "account-media-picker-row" });
    const pickFileBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "margin-left:0;",
    }, "Выбрать изображение");
    const fileName = createElement("div", { class: "account-media-file-name" }, "Файл не выбран");
    appendChildren(pickerRow, pickFileBtn, fileName);

    const hiddenInput = createElement("input", {
      type: "file",
      accept: PROFILE_MEDIA_ACCEPT_ATTR,
      style: "display:none;",
    }) as HTMLInputElement;
    const stageWrap = createElement("div", {
      class: `account-crop-stage-wrap${isAvatar ? " avatar" : " banner"}`,
      style: `width:${previewWidth}px;height:${previewHeight}px;margin: 0 auto;`,
    });
    const stageCanvas = createElement("canvas", {
      class: "account-crop-stage-canvas",
      width: String(previewWidth),
      height: String(previewHeight),
    }) as HTMLCanvasElement;
    stageWrap.appendChild(stageCanvas);

    const controlsRow = createElement("div", { class: "account-crop-controls" });
    const zoomLabel = createElement("div", { class: "account-crop-zoom-label" }, "Масштаб");
    const zoomInput = createElement("input", {
      class: "settings-slider",
      type: "range",
      min: "1",
      max: "1",
      step: "0.001",
      value: "1",
    }) as HTMLInputElement;
    const zoomValue = createElement("div", { class: "slider-val" }, "100%");
    appendChildren(controlsRow, zoomLabel, zoomInput, zoomValue);

    const modalError = createElement("div", { class: "account-media-modal-error" });
    const actionRow = createElement("div", { class: "account-media-modal-actions" });
    const cancelBtn = createElement("button", { class: "ac-btn", type: "button", style: "background:var(--bg-active);margin-left:0;" }, "Отмена");
    const saveBtn = createElement("button", { class: "ac-btn", type: "button", style: "margin-left:0;" }, "Сохранить");
    saveBtn.disabled = true;
    appendChildren(actionRow, cancelBtn, saveBtn);
    appendChildren(modalShell.body, description, pickerRow, stageWrap, controlsRow, modalError, actionRow, hiddenInput);

    let sourceImage: HTMLImageElement | null = null;
    let fileLoadSequence = 0;
    let zoom = 1;
    let minZoom = 1;
    let maxZoom = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragBaseX = 0;
    let dragBaseY = 0;

    const context = stageCanvas.getContext("2d");
    if (context === null) {
      setText(modalError, "Не удалось создать редактор изображения.");
      pickFileBtn.disabled = true;
      saveBtn.disabled = true;
      return;
    }
    const stageContext = context;

    function renderStage(): void {
      stageContext.clearRect(0, 0, previewWidth, previewHeight);
      stageContext.fillStyle = "rgba(0,0,0,0.15)";
      stageContext.fillRect(0, 0, previewWidth, previewHeight);
      if (sourceImage === null) {
        stageContext.fillStyle = "#9da3af";
        stageContext.font = "15px DM Sans";
        stageContext.textAlign = "center";
        stageContext.fillText("Предпросмотр", previewWidth / 2, previewHeight / 2);
        return;
      }
      stageContext.imageSmoothingEnabled = true;
      stageContext.imageSmoothingQuality = "high";
      stageContext.drawImage(
        sourceImage,
        offsetX,
        offsetY,
        sourceImage.naturalWidth * zoom,
        sourceImage.naturalHeight * zoom,
      );
    }

    function clampOffsets(): void {
      if (sourceImage === null) {
        offsetX = 0;
        offsetY = 0;
        return;
      }
      const scaledWidth = sourceImage.naturalWidth * zoom;
      const scaledHeight = sourceImage.naturalHeight * zoom;
      const minX = previewWidth - scaledWidth;
      const minY = previewHeight - scaledHeight;
      offsetX = clampNumber(offsetX, minX, 0);
      offsetY = clampNumber(offsetY, minY, 0);
    }

    function updateZoomDisplay(): void {
      if (minZoom <= 0) {
        setText(zoomValue, "100%");
        return;
      }
      const percent = Math.round((zoom / minZoom) * 100);
      setText(zoomValue, `${percent}%`);
    }

    function setZoom(newZoom: number, focusX: number, focusY: number): void {
      if (sourceImage === null) {
        return;
      }
      const clamped = clampNumber(newZoom, minZoom, maxZoom);
      if (Math.abs(clamped - zoom) < 0.0001) {
        return;
      }
      const ratio = clamped / zoom;
      offsetX = focusX - (focusX - offsetX) * ratio;
      offsetY = focusY - (focusY - offsetY) * ratio;
      zoom = clamped;
      clampOffsets();
      zoomInput.value = String(zoom);
      updateZoomDisplay();
      renderStage();
    }

    function readFileAsDataUrl(file: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(new Error("Не удалось прочитать файл."));
        reader.readAsDataURL(file);
      });
    }

    async function loadFile(file: File): Promise<void> {
      const currentLoadId = ++fileLoadSequence;
      saveBtn.disabled = true;
      if (!isSupportedProfileMediaFile(file)) {
        sourceImage = null;
        setText(fileName, file.name);
        setText(modalError, "Поддерживаются JPG, PNG, WEBP, GIF, BMP и AVIF.");
        renderStage();
        return;
      }
      if (file.size > PROFILE_MEDIA_MAX_SOURCE_SIZE_BYTES) {
        sourceImage = null;
        setText(fileName, file.name);
        setText(modalError, `Файл слишком большой. Выберите изображение до ${formatProfileMediaLimitLabel()}.`);
        renderStage();
        return;
      }
      setText(fileName, file.name);
      setText(modalError, "");
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (modalSignal.signal.aborted || currentLoadId !== fileLoadSequence || dataUrl.trim() === "") {
          return;
        }
        const image = new Image();
        image.onload = () => {
          if (modalSignal.signal.aborted || currentLoadId !== fileLoadSequence) {
            return;
          }
          sourceImage = image;
          minZoom = Math.max(previewWidth / image.naturalWidth, previewHeight / image.naturalHeight);
          maxZoom = Math.max(minZoom * 4, minZoom + 0.2);
          zoom = minZoom;
          offsetX = (previewWidth - image.naturalWidth * zoom) / 2;
          offsetY = (previewHeight - image.naturalHeight * zoom) / 2;
          zoomInput.min = String(minZoom);
          zoomInput.max = String(maxZoom);
          zoomInput.value = String(zoom);
          clampOffsets();
          updateZoomDisplay();
          renderStage();
          saveBtn.disabled = false;
        };
        image.onerror = () => {
          if (modalSignal.signal.aborted || currentLoadId !== fileLoadSequence) {
            return;
          }
          sourceImage = null;
          saveBtn.disabled = true;
          setText(modalError, "Не удалось открыть изображение.");
          renderStage();
        };
        image.src = dataUrl;
      } catch {
        if (modalSignal.signal.aborted || currentLoadId !== fileLoadSequence) {
          return;
        }
        sourceImage = null;
        saveBtn.disabled = true;
        setText(modalError, "Не удалось открыть изображение.");
        renderStage();
      }
    }

    pickFileBtn.addEventListener("click", () => hiddenInput.click(), { signal: modalSignal.signal });
    hiddenInput.addEventListener("change", () => {
      const selected = hiddenInput.files?.[0];
      if (selected !== undefined) {
        void loadFile(selected);
      }
      hiddenInput.value = "";
    }, { signal: modalSignal.signal });

    zoomInput.addEventListener("input", () => {
      const nextZoom = Number(zoomInput.value);
      setZoom(nextZoom, previewWidth / 2, previewHeight / 2);
    }, { signal: modalSignal.signal });

    stageCanvas.addEventListener("wheel", (event) => {
      if (sourceImage === null) {
        return;
      }
      event.preventDefault();
      const rect = stageCanvas.getBoundingClientRect();
      const focusX = event.clientX - rect.left;
      const focusY = event.clientY - rect.top;
      const nextZoom = event.deltaY < 0 ? zoom * 1.06 : zoom * 0.94;
      setZoom(nextZoom, focusX, focusY);
    }, { signal: modalSignal.signal, passive: false });

    stageCanvas.addEventListener("mousedown", (event) => {
      if (sourceImage === null) {
        return;
      }
      dragging = true;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragBaseX = offsetX;
      dragBaseY = offsetY;
      stageCanvas.classList.add("dragging");
    }, { signal: modalSignal.signal });

    window.addEventListener("mousemove", (event) => {
      if (!dragging || sourceImage === null) {
        return;
      }
      const dx = event.clientX - dragStartX;
      const dy = event.clientY - dragStartY;
      offsetX = dragBaseX + dx;
      offsetY = dragBaseY + dy;
      clampOffsets();
      renderStage();
    }, { signal: modalSignal.signal });

    window.addEventListener("mouseup", () => {
      dragging = false;
      stageCanvas.classList.remove("dragging");
    }, { signal: modalSignal.signal });

    cancelBtn.addEventListener("click", closeModal, { signal: modalSignal.signal });
    saveBtn.addEventListener("click", () => {
      if (sourceImage === null) {
        return;
      }
      saveBtn.disabled = true;
      setText(saveBtn, "Сохранение...");
      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = outputWidth;
      exportCanvas.height = outputHeight;
      const exportCtx = exportCanvas.getContext("2d");
      if (exportCtx === null) {
        setText(modalError, "Не удалось сохранить изображение.");
        saveBtn.disabled = false;
        setText(saveBtn, "Сохранить");
        return;
      }

      const scaleX = outputWidth / previewWidth;
      const scaleY = outputHeight / previewHeight;
      exportCtx.imageSmoothingEnabled = true;
      exportCtx.imageSmoothingQuality = "high";
      exportCtx.drawImage(
        sourceImage,
        offsetX * scaleX,
        offsetY * scaleY,
        sourceImage.naturalWidth * zoom * scaleX,
        sourceImage.naturalHeight * zoom * scaleY,
      );

      const exportMime = isAvatar ? "image/png" : "image/jpeg";
      const exportFilename = isAvatar ? "avatar.png" : "banner.jpg";
      const exportQuality = isAvatar ? 0.95 : 0.92;

      exportCanvas.toBlob((blob) => {
        if (blob === null) {
          setText(modalError, "Не удалось сохранить изображение.");
          saveBtn.disabled = false;
          setText(saveBtn, "Сохранить");
          return;
        }
        const file = new File([blob], exportFilename, { type: exportMime });
        void uploadAndApplyProfileMedia(kind, file).then(() => {
          closeModal();
        }).catch(() => {
          saveBtn.disabled = false;
          setText(saveBtn, "Сохранить");
        });
      }, exportMime, exportQuality);
    }, { signal: modalSignal.signal });

    renderStage();
  }

  function openDefaultAvatarModal(): void {
    const modalShell = buildModalShell("Стандартные аватары");
    const modalSignal = new AbortController();
    const closeModal = (): void => {
      modalSignal.abort();
      modalShell.close();
    };
    const status = createElement("div", { class: "account-default-avatars-state" }, "Загрузка списка аватаров...");
    const error = createElement("div", { class: "account-default-avatars-error" });
    const groups = createElement("div", { class: "account-default-avatars-groups" });
    let selectedCategory: string | null = null;
    let selectedAvatarName: string | null = null;
    let selectedPreviewUrl: string | null = null;
    let selectedButton: HTMLButtonElement | null = null;
    appendChildren(modalShell.body, status, error, groups);

    const renderPreview = (target: HTMLDivElement, previewUrl: string): void => {
      const resolved = resolveServerUrl(previewUrl);
      if (!isSafeUrl(resolved)) {
        setText(target, "Нет превью");
        return;
      }
      void fetchImageAsDataUrl(resolved).then((dataUrl) => {
        if (modalSignal.signal.aborted) {
          return;
        }
        clearChildren(target);
        if (dataUrl === null || dataUrl.trim() === "") {
          setText(target, "Нет превью");
          return;
        }
        const image = createElement("img", {
          class: "account-default-avatar-image",
          src: dataUrl,
          alt: "avatar preview",
        });
        target.appendChild(image);
      }).catch(() => {
        if (!modalSignal.signal.aborted) {
          setText(target, "Нет превью");
        }
      });
    };

    const setSelectedAvatar = (
      button: HTMLButtonElement,
      category: string,
      avatarName: string,
      previewUrl: string,
      saveBtn: HTMLButtonElement,
    ): void => {
      if (selectedButton !== null) {
        selectedButton.classList.remove("selected");
      }
      selectedButton = button;
      selectedButton.classList.add("selected");
      selectedCategory = category;
      selectedAvatarName = avatarName;
      selectedPreviewUrl = previewUrl;
      saveBtn.disabled = false;
      setText(error, "");
    };

    void ensureDefaultAvatarCatalog().then((categories) => {
      if (modalSignal.signal.aborted) {
        return;
      }
      clearChildren(groups);
      setText(error, "");
      if (categories.length === 0) {
        setText(status, "В каталоге Avatars пока нет доступных изображений.");
        return;
      }
      status.style.display = "none";

      for (const category of categories) {
        const group = createElement("div", { class: "account-default-avatar-group" });
        const groupTitle = createElement("div", { class: "account-default-avatar-group-title" }, category.name);
        const grid = createElement("div", { class: "account-default-avatar-grid" });
        for (const avatarEntry of category.avatars) {
          const button = createElement("button", {
            class: "account-default-avatar-item",
            type: "button",
            title: `${category.name}: ${avatarEntry.name}`,
          }) as HTMLButtonElement;
          const previewWrap = createElement("div", { class: "account-default-avatar-preview-wrap" });
          const label = createElement("div", { class: "account-default-avatar-name" }, avatarEntry.name);
          renderPreview(previewWrap, avatarEntry.preview_url);
          button.addEventListener("click", () => {
            setSelectedAvatar(
              button,
              category.name,
              avatarEntry.name,
              avatarEntry.preview_url,
              saveBtn,
            );
          }, { signal: modalSignal.signal });
          appendChildren(button, previewWrap, label);
          grid.appendChild(button);
        }
        appendChildren(group, groupTitle, grid);
        groups.appendChild(group);
      }
    }).catch((err: unknown) => {
      if (modalSignal.signal.aborted) {
        return;
      }
      setText(status, "Не удалось загрузить стандартные аватары.");
      setText(error, err instanceof Error ? err.message : "Ошибка загрузки аватаров.");
    });

    const footer = createElement("div", { class: "account-media-modal-actions" });
    const closeBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "background:var(--bg-active);margin-left:0;",
    }, "Закрыть");
    const saveBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "margin-left:0;",
    }, "Сохранить") as HTMLButtonElement;
    saveBtn.disabled = true;
    closeBtn.addEventListener("click", closeModal, { signal: modalSignal.signal });
    saveBtn.addEventListener("click", () => {
      if (selectedCategory === null || selectedAvatarName === null || selectedPreviewUrl === null) {
        return;
      }
saveBtn.disabled = true;
      closeBtn.disabled = true;
      const originalText = saveBtn.textContent;
      saveBtn.innerHTML = '<span class="spinner-inline"></span> Применение...';
      void selectDefaultAvatar(selectedCategory, selectedAvatarName, selectedPreviewUrl).then(() => {
        closeModal();
      }).catch(() => {
        saveBtn.textContent = originalText;
        saveBtn.disabled = false;
        closeBtn.disabled = false;
      });
    }, { signal: modalSignal.signal });
    appendChildren(footer, closeBtn, saveBtn);
    modalShell.body.appendChild(footer);
  }

  function openDefaultBannerModal(): void {
    const modalShell = buildModalShell("Стандартные обложки");
    const modalSignal = new AbortController();
    const closeModal = (): void => {
      modalSignal.abort();
      modalShell.close();
    };
    const status = createElement("div", { class: "account-default-avatars-state" }, "Загрузка списка обложек...");
    const error = createElement("div", { class: "account-default-avatars-error" });
    const groups = createElement("div", { class: "account-default-avatars-groups" });
    let selectedCategory: string | null = null;
    let selectedBannerName: string | null = null;
    let selectedPreviewUrl: string | null = null;
    let selectedButton: HTMLButtonElement | null = null;
    appendChildren(modalShell.body, status, error, groups);

    const renderPreview = (target: HTMLDivElement, previewUrl: string): void => {
      const resolved = resolveServerUrl(previewUrl);
      if (!isSafeUrl(resolved)) {
        setText(target, "Нет превью");
        return;
      }
      void fetchImageAsDataUrl(resolved).then((dataUrl) => {
        if (modalSignal.signal.aborted) {
          return;
        }
        clearChildren(target);
        if (dataUrl === null || dataUrl.trim() === "") {
          setText(target, "Нет превью");
          return;
        }
        const image = createElement("img", {
          class: "account-default-avatar-image", // Re-using styling class
          src: dataUrl,
          alt: "banner preview",
        });
        target.appendChild(image);
      }).catch(() => {
        if (!modalSignal.signal.aborted) {
          setText(target, "Нет превью");
        }
      });
    };

    const setSelectedBanner = (
      button: HTMLButtonElement,
      category: string,
      bannerName: string,
      previewUrl: string,
      saveBtn: HTMLButtonElement,
    ): void => {
      if (selectedButton !== null) {
        selectedButton.classList.remove("selected");
      }
      selectedButton = button;
      selectedButton.classList.add("selected");
      selectedCategory = category;
      selectedBannerName = bannerName;
      selectedPreviewUrl = previewUrl;
      saveBtn.disabled = false;
      setText(error, "");
    };

    void ensureDefaultBannerCatalog().then((categories) => {
      if (modalSignal.signal.aborted) {
        return;
      }
      clearChildren(groups);
      setText(error, "");
      if (categories.length === 0) {
        setText(status, "В каталоге Banners пока нет доступных изображений.");
        return;
      }
      status.style.display = "none";

      for (const category of categories) {
        const group = createElement("div", { class: "account-default-avatar-group" });
        const groupTitle = createElement("div", { class: "account-default-avatar-group-title" }, category.name);
        const grid = createElement("div", { class: "account-default-avatar-grid" });
        for (const bannerEntry of category.avatars) { // Note: avatars field reused for generic catalog items
          const button = createElement("button", {
            class: "account-default-avatar-item",
            type: "button",
            title: `${category.name}: ${bannerEntry.name}`,
          }) as HTMLButtonElement;
          const previewWrap = createElement("div", { class: "account-default-avatar-preview-wrap" });
          const label = createElement("div", { class: "account-default-avatar-name" }, bannerEntry.name);
          renderPreview(previewWrap, bannerEntry.preview_url);
          button.addEventListener("click", () => {
            setSelectedBanner(
              button,
              category.name,
              bannerEntry.name,
              bannerEntry.preview_url,
              saveBtn,
            );
          }, { signal: modalSignal.signal });
          appendChildren(button, previewWrap, label);
          grid.appendChild(button);
        }
        appendChildren(group, groupTitle, grid);
        groups.appendChild(group);
      }
    }).catch((err: unknown) => {
      if (modalSignal.signal.aborted) {
        return;
      }
      setText(status, "Не удалось загрузить стандартные обложки.");
      setText(error, err instanceof Error ? err.message : "Ошибка загрузки обложек.");
    });

    const footer = createElement("div", { class: "account-media-modal-actions" });
    const closeBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "background:var(--bg-active);margin-left:0;",
    }, "Закрыть");
    const saveBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "margin-left:0;",
    }, "Сохранить") as HTMLButtonElement;
    saveBtn.disabled = true;
    closeBtn.addEventListener("click", closeModal, { signal: modalSignal.signal });
    saveBtn.addEventListener("click", () => {
      if (selectedCategory === null || selectedBannerName === null || selectedPreviewUrl === null) {
        return;
      }
      saveBtn.disabled = true;
      closeBtn.disabled = true;
      void selectDefaultBannerRaw(selectedCategory, selectedBannerName, selectedPreviewUrl).then(() => {
        closeModal();
      }).catch(() => {
        saveBtn.disabled = false;
        closeBtn.disabled = false;
      });
    }, { signal: modalSignal.signal });
    appendChildren(footer, closeBtn, saveBtn);
    modalShell.body.appendChild(footer);
  }

  function openAvatarChooserModal(): void {
    const modalShell = buildModalShell("Выбор аватара");
    const chooserText = createElement("div", { class: "account-media-modal-note" },
      "Выберите источник: загрузить свой аватар или взять стандартный из каталога.");
    const chooserGrid = createElement("div", { class: "account-avatar-choice-grid" });
    const uploadOwnBtn = createElement("button", {
      class: "account-avatar-choice-btn",
      type: "button",
    }, "Загрузить свой аватар");
    const chooseStandardBtn = createElement("button", {
      class: "account-avatar-choice-btn",
      type: "button",
    }, "Выбрать стандартный");
    const closeBtn = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "background:var(--bg-active);margin-left:0;",
    }, "Отмена");

    uploadOwnBtn.addEventListener("click", () => {
      modalShell.close();
      openCropModal("avatar");
    }, { signal });
    chooseStandardBtn.addEventListener("click", () => {
      modalShell.close();
      openDefaultAvatarModal();
    }, { signal });
    closeBtn.addEventListener("click", () => modalShell.close(), { signal });

    appendChildren(chooserGrid, uploadOwnBtn, chooseStandardBtn);
    appendChildren(modalShell.body, chooserText, chooserGrid, closeBtn);
  }

  avatarEditBtn.addEventListener("click", () => {
    if (avatarEditBtn.disabled) {
      return;
    }
    openAvatarChooserModal();
  }, { signal });

  function openBannerColorPickerModal(): void {
    const modalShell = buildModalShell("Выбрать цвет обложки");
    const modalSignal = new AbortController();
    const closeModal = (): void => {
      modalSignal.abort();
      modalShell.close();
    };

    const description = createElement("div", { class: "account-media-modal-note" },
      "Выберите готовый цвет или введите свой HEX-код.");

    // Preset color grid
    const presetsGrid = createElement("div", { class: "banner-color-presets" });
    let selectedColor: string | null = null;
    let selectedSwatch: HTMLButtonElement | null = null;

    // Detect current banner color if any
    const currentBanner = authStore.getState().user?.banner ?? banner;
    const currentBannerColor = isBannerColor(currentBanner) ? parseBannerColor(currentBanner!) : null;

    for (const color of BANNER_PRESET_COLORS) {
      const swatch = createElement("button", {
        class: "banner-color-swatch",
        type: "button",
        title: color,
        "aria-label": `Цвет ${color}`,
      }) as HTMLButtonElement;
      swatch.style.background = color;
      if (currentBannerColor !== null && currentBannerColor.toLowerCase() === color.toLowerCase()) {
        swatch.classList.add("active");
        selectedSwatch = swatch;
        selectedColor = color;
      }
      swatch.addEventListener("click", () => {
        if (selectedSwatch !== null) {
          selectedSwatch.classList.remove("active");
        }
        swatch.classList.add("active");
        selectedSwatch = swatch;
        selectedColor = color;
        hexInput.value = color.replace(/^#/, "");
        previewBox.style.background = color;
        saveBtnEl.disabled = false;
      }, { signal: modalSignal.signal });
      presetsGrid.appendChild(swatch);
    }

    // Custom hex input row
    const customRow = createElement("div", { class: "banner-color-custom-row" });
    const hexLabel = createElement("div", { class: "banner-color-hex-label" }, "Или свой цвет:");
    const hexInputWrap = createElement("div", { class: "accent-hex-row" });
    const hexPrefix = createElement("span", { class: "accent-hex-prefix" }, "#");
    const hexInput = createElement("input", {
      class: "form-input",
      type: "text",
      maxlength: "6",
      placeholder: "5865f2",
      style: "width:120px;font-family:monospace;font-size:14px;",
    }) as HTMLInputElement;
    if (currentBannerColor !== null) {
      hexInput.value = currentBannerColor.replace(/^#/, "");
    }
    appendChildren(hexInputWrap, hexPrefix, hexInput);

    // Preview
    const previewBox = createElement("div", { class: "banner-color-preview" });
    if (currentBannerColor !== null) {
      previewBox.style.background = currentBannerColor;
    } else {
      previewBox.style.background = "var(--accent)";
    }
    appendChildren(customRow, hexLabel, hexInputWrap, previewBox);

    hexInput.addEventListener("input", () => {
      const raw = hexInput.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
      hexInput.value = raw;
      if (raw.length === 3 || raw.length === 6) {
        const color = `#${raw}`;
        previewBox.style.background = color;
        selectedColor = color.length === 4
          ? `#${raw[0]}${raw[0]}${raw[1]}${raw[1]}${raw[2]}${raw[2]}`
          : color;
        // Deselect preset swatch
        if (selectedSwatch !== null) {
          selectedSwatch.classList.remove("active");
          selectedSwatch = null;
        }
        // Auto-select matching preset if exists
        const fullHex = selectedColor.toLowerCase();
        const presetBtn = presetsGrid.querySelector(
          `button[title="${fullHex}"]`,
        ) as HTMLButtonElement | null;
        if (presetBtn !== null) {
          presetBtn.classList.add("active");
          selectedSwatch = presetBtn;
        }
        saveBtnEl.disabled = false;
      } else {
        saveBtnEl.disabled = true;
      }
    }, { signal: modalSignal.signal });

    // Error
    const modalError = createElement("div", { class: "account-media-modal-error" });

    // Actions
    const actionRow = createElement("div", { class: "account-media-modal-actions" });
    const cancelBtnEl = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "background:var(--bg-active);margin-left:0;",
    }, "Отмена");
    const saveBtnEl = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "margin-left:0;",
    }, "Сохранить") as HTMLButtonElement;
    saveBtnEl.disabled = selectedColor === null;

    cancelBtnEl.addEventListener("click", closeModal, { signal: modalSignal.signal });
    saveBtnEl.addEventListener("click", () => {
      if (selectedColor === null) {
        return;
      }
      // Normalize to full 6-char hex
      let hex = selectedColor;
      if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
        const r = hex[1], g = hex[2], b = hex[3];
        hex = `#${r}${r}${g}${g}${b}${b}`;
      }
      const bannerValue = `${BANNER_COLOR_PREFIX}${hex}`;
      saveBtnEl.disabled = true;
      cancelBtnEl.disabled = true;
      setText(saveBtnEl, "Сохранение...");
      setText(modalError, "");
      void options.onUpdateProfile({ banner: bannerValue }).then(() => {
        syncProfilePreviewWithStore({ banner: bannerValue });
        closeModal();
      }).catch((err: unknown) => {
        setText(modalError, err instanceof Error ? err.message : "Не удалось сохранить цвет обложки.");
        saveBtnEl.disabled = false;
        cancelBtnEl.disabled = false;
        setText(saveBtnEl, "Сохранить");
      });
    }, { signal: modalSignal.signal });

    appendChildren(actionRow, cancelBtnEl, saveBtnEl);
    appendChildren(modalShell.body, description, presetsGrid, customRow, modalError, actionRow);
  }

  function openBannerChooserModal(): void {
    const modalShell = buildModalShell("Изменить обложку");
    const chooserText = createElement("div", { class: "account-media-modal-note" },
      "Выберите способ: залить цветом или загрузить своё изображение.");
    const chooserGrid = createElement("div", { class: "account-avatar-choice-grid" });

    const chooseColorBtn = createElement("button", {
      class: "account-avatar-choice-btn banner-choice-color-btn",
      type: "button",
    });
    const colorIcon = createElement("div", { class: "banner-choice-icon" });
    // Small color swatch row inside the button
    const colorSwatches = createElement("div", { class: "banner-choice-mini-swatches" });
    for (const c of BANNER_PRESET_COLORS.slice(0, 6)) {
      const dot = createElement("div", { class: "banner-choice-mini-dot" });
      dot.style.background = c;
      colorSwatches.appendChild(dot);
    }
    colorIcon.appendChild(colorSwatches);
    const colorLabel = createElement("div", { class: "banner-choice-label" }, "Выбрать цвет");
    appendChildren(chooseColorBtn, colorIcon, colorLabel);

    const uploadImageBtn = createElement("button", {
      class: "account-avatar-choice-btn",
      type: "button",
    }, "Загрузить изображение");

    const chooseStandardBtn = createElement("button", {
      class: "account-avatar-choice-btn",
      type: "button",
      style: "grid-column: span 2;",
    }, "Выбрать стандартную обложку");

    const closeBtnEl = createElement("button", {
      class: "ac-btn",
      type: "button",
      style: "background:var(--bg-active);margin-left:0;margin-top:12px;",
    }, "Отмена");

    chooseColorBtn.addEventListener("click", () => {
      modalShell.close();
      openBannerColorPickerModal();
    }, { signal });
    uploadImageBtn.addEventListener("click", () => {
      modalShell.close();
      openCropModal("banner");
    }, { signal });
    chooseStandardBtn.addEventListener("click", () => {
      modalShell.close();
      openDefaultBannerModal();
    }, { signal });
    closeBtnEl.addEventListener("click", () => modalShell.close(), { signal });

    appendChildren(chooserGrid, chooseColorBtn, uploadImageBtn, chooseStandardBtn);
    appendChildren(modalShell.body, chooserText, chooserGrid, closeBtnEl);
  }

  bannerEditBtn.addEventListener("click", () => {
    if (bannerEditBtn.disabled) {
      return;
    }
    openBannerChooserModal();
  }, { signal });

  syncMediaControlsAvailability();

  return section;
}
