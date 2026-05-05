/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteItem {
  readonly code: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly uses: number;
  readonly maxUses: number | null;
  readonly expiresAt: string | null;
  readonly status?: "active" | "used" | "revoked" | "expired";
  readonly redeemedBy?: string | null;
}

export interface InviteManagerOptions {
  invites: readonly InviteItem[];
  username: string;
  loading?: boolean;
  loadError?: string | null;
  onCreateInvite(): Promise<InviteItem>;
  onRevokeInvite(code: string): Promise<void>;
  onDeleteInvite?(code: string): Promise<void>;
  onCopyLink(code: string): void;
  onClose(): void;
  onError?(message: string): void;
}

export interface InviteManagerComponent extends MountableComponent {
  setInvites(invites: readonly InviteItem[]): void;
  setLoading(loading: boolean): void;
  setLoadError(message: string | null): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskCode(code: string): string {
  if (code.length <= 6) return code;
  return `${code.slice(0, 3)}...${code.slice(-3)}`;
}

function formatInviteInfo(invite: InviteItem): string {
  const status = invite.status ?? "active";
  const redeemedBy = invite.redeemedBy ?? null;
  const uses = invite.maxUses !== null
    ? `${invite.uses}/${invite.maxUses} использований`
    : `${invite.uses} использований`;
  const base = `Создан: ${invite.createdBy} \u00B7 ${uses}`;
  if (status === "used" && redeemedBy !== null) {
    return `${base} \u00B7 Использовал: ${redeemedBy}`;
  }
  if (status === "used") {
    return `${base} \u00B7 Использован`;
  }
  if (status === "revoked") {
    return `${base} \u00B7 Отозван`;
  }
  if (status === "expired") {
    return `${base} \u00B7 Истек`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(
  options: InviteManagerOptions,
): InviteManagerComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let loadingEl: HTMLDivElement | null = null;
  let errorEl: HTMLDivElement | null = null;
  let confirmOverlay: HTMLDivElement | null = null;
  let createBtnEl: HTMLButtonElement | null = null;
  let invites: readonly InviteItem[] = options.invites;
  let isLoading = options.loading ?? false;
  let loadError = options.loadError ?? null;
  let isCreatingInvite = false;
  let destroyed = false;
  const copiedCodes = new Set<string>();
  const revokingCodes = new Set<string>();
  const revokedFeedbackCodes = new Set<string>();
  const deletingCodes = new Set<string>();
  const newlyCreatedCodes = new Set<string>();

  function renderCreateButton(): void {
    if (createBtnEl === null) {
      return;
    }

    clearChildren(createBtnEl);
    createBtnEl.disabled = isCreatingInvite;
    createBtnEl.classList.toggle("invite-manager__create--loading", isCreatingInvite);

    if (isCreatingInvite) {
      createBtnEl.appendChild(createElement("span", { class: "invite-manager__create-spinner" }));
      createBtnEl.appendChild(document.createTextNode(" Создаем приглашение..."));
      return;
    }

    createBtnEl.appendChild(createIcon("external-link", 14));
    createBtnEl.appendChild(document.createTextNode(" Создать приглашение"));
  }

  function clearCreatedHighlight(code: string): void {
    newlyCreatedCodes.delete(code);
    if (listEl === null) {
      return;
    }
    const row = Array.from(listEl.children).find((child) => {
      return child instanceof HTMLElement && child.dataset.inviteCode === code;
    });
    if (row instanceof HTMLElement) {
      row.classList.remove("invite-item--created");
    }
  }

  function startCreateInvite(): void {
    if (isCreatingInvite) {
      return;
    }

    isCreatingInvite = true;
    renderCreateButton();
    renderList();

    void options.onCreateInvite().then((newInvite) => {
      isCreatingInvite = false;
      invites = [newInvite, ...invites];
      newlyCreatedCodes.add(newInvite.code);
      renderCreateButton();
      renderList();
      window.setTimeout(() => clearCreatedHighlight(newInvite.code), 1200);
    }).catch(() => {
      isCreatingInvite = false;
      renderCreateButton();
      renderList();
      options.onError?.("Не удалось создать приглашение");
    });
  }

  function showCopiedFeedback(code: string): void {
    copiedCodes.add(code);
    renderList();
    window.setTimeout(() => {
      copiedCodes.delete(code);
      renderList();
    }, 1100);
  }

  function startRevokeInvite(invite: InviteItem): void {
    if (revokingCodes.has(invite.code) || deletingCodes.has(invite.code)) {
      return;
    }

    revokingCodes.add(invite.code);
    renderList();

    void options.onRevokeInvite(invite.code).then(() => {
      revokingCodes.delete(invite.code);
      revokedFeedbackCodes.add(invite.code);
      invites = invites.map((i) => (i.code === invite.code ? { ...i, status: "revoked" as const } : i));
      renderList();
      window.setTimeout(() => {
        revokedFeedbackCodes.delete(invite.code);
        renderList();
      }, 1300);
    }).catch((err: unknown) => {
      revokingCodes.delete(invite.code);
      renderList();
      const message = err instanceof Error ? err.message : "Не удалось отозвать приглашение";
      options.onError?.(message);
    });
  }

  function closeDeleteConfirm(): void {
    if (confirmOverlay !== null) {
      confirmOverlay.remove();
      confirmOverlay = null;
    }
  }

  function removeInviteWithAnimation(code: string): void {
    if (listEl === null) {
      invites = invites.filter((i) => i.code !== code);
      renderList();
      return;
    }

    const row = Array.from(listEl.children).find((child) => {
      return child instanceof HTMLElement && child.dataset.inviteCode === code;
    });
    if (!(row instanceof HTMLElement)) {
      invites = invites.filter((i) => i.code !== code);
      renderList();
      return;
    }

    row.classList.add("invite-item--removing");
    window.setTimeout(() => {
      deletingCodes.delete(code);
      invites = invites.filter((i) => i.code !== code);
      renderList();
    }, 220);
  }

  function startDeleteInvite(invite: InviteItem): void {
    if (deletingCodes.has(invite.code)) {
      return;
    }

    closeDeleteConfirm();
    deletingCodes.add(invite.code);
    if (!destroyed) {
      renderList();
    }

    void (options.onDeleteInvite?.(invite.code) ?? Promise.resolve()).then(() => {
      if (destroyed) return;
      removeInviteWithAnimation(invite.code);
    }).catch((err: unknown) => {
      if (destroyed) return;
      deletingCodes.delete(invite.code);
      renderList();
      const message = err instanceof Error ? err.message : "Не удалось удалить приглашение";
      options.onError?.(message);
    });
  }

  function openDeleteConfirm(invite: InviteItem): void {
    if (root === null || deletingCodes.has(invite.code)) {
      return;
    }

    closeDeleteConfirm();

    const status = invite.status ?? "active";
    confirmOverlay = createElement("div", { class: "invite-confirm-backdrop" });
    const dialog = createElement("div", {
      class: "invite-confirm-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Подтверждение удаления приглашения",
    });

    const iconWrap = createElement("div", { class: "invite-confirm-dialog__icon" });
    iconWrap.appendChild(createIcon("trash-2", 20));
    const title = createElement("div", { class: "invite-confirm-dialog__title" }, "Удалить приглашение?");
    const text = createElement(
      "div",
      { class: "invite-confirm-dialog__text" },
      status === "active"
        ? "Активное приглашение сначала будет отозвано а затем удалено навсегда."
        : "Приглашение будет навсегда удалено с этого сервера.",
    );

    const codePreview = createElement("div", { class: "invite-confirm-dialog__code" }, invite.code);
    const actions = createElement("div", { class: "invite-confirm-dialog__actions" });
    const cancelBtn = createElement("button", { class: "invite-confirm-dialog__cancel" }, "Отмена");
    const confirmBtn = createElement("button", { class: "invite-confirm-dialog__delete" });
    confirmBtn.appendChild(createIcon("trash-2", 14));
    confirmBtn.appendChild(document.createTextNode(" Удалить"));

    cancelBtn.addEventListener("click", closeDeleteConfirm, { signal: ac.signal });
    confirmBtn.addEventListener("click", () => {
      startDeleteInvite(invite);
    }, { signal: ac.signal });

    appendChildren(actions, cancelBtn, confirmBtn);
    appendChildren(dialog, iconWrap, title, text, codePreview, actions);
    confirmOverlay.appendChild(dialog);
    confirmOverlay.addEventListener("click", (e) => {
      if (e.target === confirmOverlay) {
        closeDeleteConfirm();
      }
    }, { signal: ac.signal });
    root.appendChild(confirmOverlay);
    cancelBtn.focus();
  }

  function renderList(): void {
    if (listEl === null || emptyEl === null || loadingEl === null || errorEl === null) return;
    clearChildren(listEl);

    loadingEl.style.display = isLoading ? "" : "none";
    errorEl.style.display = loadError !== null ? "" : "none";
    errorEl.textContent = loadError ?? "";

    if (isLoading) {
      emptyEl.style.display = "none";
      listEl.style.display = "none";
      return;
    }

    listEl.style.display = "";

    if (invites.length === 0 && !isCreatingInvite) {
      emptyEl.textContent = loadError ?? "Нет активных приглашений";
      emptyEl.style.display = "";
      return;
    }

    emptyEl.style.display = "none";

    if (isCreatingInvite) {
      const pendingRow = createElement("div", { class: "invite-create-pending" });
      const spinner = createElement("span", { class: "invite-create-pending__spinner" });
      const content = createElement("div", { class: "invite-create-pending__content" });
      const title = createElement("div", { class: "invite-create-pending__title" }, "Создаем приглашение");
      const meta = createElement("div", { class: "invite-create-pending__meta" }, "Готовим код и синхронизацию");
      const track = createElement("div", { class: "invite-create-pending__track" });
      const bar = createElement("span", { class: "invite-create-pending__bar" });
      track.appendChild(bar);
      appendChildren(content, title, meta, track);
      appendChildren(pendingRow, spinner, content);
      listEl.appendChild(pendingRow);
    }

    for (const invite of invites) {
      const status = invite.status ?? "active";
      const redeemedBy = invite.redeemedBy ?? null;
      const isInactive = status === "used" || status === "revoked" || status === "expired";
      const isDeleting = deletingCodes.has(invite.code);
      const isCopied = copiedCodes.has(invite.code);
      const isRevoking = revokingCodes.has(invite.code);
      const showRevokedFeedback = revokedFeedbackCodes.has(invite.code);
      const isNew = newlyCreatedCodes.has(invite.code);
      const row = createElement("div", {
        class: `invite-item${isInactive ? " invite-item--inactive" : ""}${isDeleting ? " invite-item--deleting" : ""}${isNew ? " invite-item--created" : ""}`,
      });
      row.dataset.inviteCode = invite.code;

      // Top row: code + action buttons
      const headerRow = createElement("div", { class: "invite-item__header" });
      const code = createElement("span", { class: "invite-item__code" }, maskCode(invite.code));
      const actions = createElement("div", { class: "invite-item__actions" });

      const copyBtn = createElement("button", { class: "invite-item__copy" });
      copyBtn.classList.toggle("invite-item__copy--copied", isCopied);
      copyBtn.appendChild(createIcon(isCopied ? "check" : "external-link", 14));
      copyBtn.appendChild(document.createTextNode(isCopied ? " Скопировано" : " Копировать"));
      copyBtn.addEventListener("click", () => {
        options.onCopyLink(invite.code);
        showCopiedFeedback(invite.code);
      }, { signal: ac.signal });
      copyBtn.disabled = isDeleting;

      appendChildren(actions, copyBtn);
      if (status === "active" || isRevoking || showRevokedFeedback) {
        const revokeBtn = createElement("button", { class: "invite-item__revoke" });
        revokeBtn.classList.toggle("invite-item__revoke--revoking", isRevoking);
        revokeBtn.classList.toggle("invite-item__revoke--done", showRevokedFeedback);
        if (isRevoking) {
          revokeBtn.appendChild(createElement("span", { class: "invite-item__action-spinner" }));
          revokeBtn.appendChild(document.createTextNode(" Отзываем..."));
        } else if (showRevokedFeedback) {
          revokeBtn.appendChild(createIcon("check", 14));
          revokeBtn.appendChild(document.createTextNode(" Отозвано"));
        } else {
          revokeBtn.appendChild(createIcon("x", 14));
          revokeBtn.appendChild(document.createTextNode(" Отозвать"));
        }
        revokeBtn.addEventListener("click", () => {
          startRevokeInvite(invite);
        }, { signal: ac.signal });
        revokeBtn.disabled = isDeleting || isRevoking || showRevokedFeedback;
        actions.appendChild(revokeBtn);
      }
      const deleteBtn = createElement("button", { class: "invite-item__delete" });
      deleteBtn.appendChild(createIcon("trash-2", 14));
      deleteBtn.appendChild(document.createTextNode(" Удалить"));
      deleteBtn.addEventListener("click", () => {
        openDeleteConfirm(invite);
      }, { signal: ac.signal });
      deleteBtn.disabled = isDeleting;
      actions.appendChild(deleteBtn);
      appendChildren(headerRow, code, actions);

      // Bottom row: meta info
      const meta = createElement("div", { class: "invite-item__meta" }, formatInviteInfo(invite));
      const statusText = status === "used"
        ? "Использован"
        : status === "revoked"
          ? "Отозван"
          : status === "expired"
            ? "Истек"
            : "Активен";
      const badge = createElement(
        "span",
        { class: `invite-item__badge invite-item__badge--${status}` },
        statusText,
      );
      if (status === "used" && redeemedBy !== null) {
        badge.textContent = `Использовал: ${redeemedBy}`;
      }

      appendChildren(row, headerRow, meta, badge);
      if (isDeleting) {
        const deletingLayer = createElement("div", { class: "invite-item__deleting-layer" });
        const deletingSpinner = createElement("span", { class: "invite-item__delete-spinner" });
        const deletingText = createElement("span", { class: "invite-item__delete-text" }, "Удаляем...");
        const deletingTrack = createElement("span", { class: "invite-item__delete-track" });
        const deletingBar = createElement("span", { class: "invite-item__delete-bar" });
        deletingTrack.appendChild(deletingBar);
        appendChildren(deletingLayer, deletingSpinner, deletingText, deletingTrack);
        row.appendChild(deletingLayer);
      }
      listEl.appendChild(row);
    }
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "modal-overlay visible",
    });

    const modal = createElement("div", {
      class: "modal invite-manager-modal",
    });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, `Приглашения ${options.username}`);
    const closeBtn = createElement("button", { class: "modal-close" });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", () => options.onClose(), { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    listEl = createElement("div", { class: "invite-manager__list" });
    loadingEl = createElement("div", { class: "invite-manager__loading" }, "Загружаем приглашения...");
    errorEl = createElement("div", { class: "invite-manager__error" });
    emptyEl = createElement("div", { class: "invite-manager__empty" }, "Нет активных приглашений");
    appendChildren(body, loadingEl, errorEl, listEl, emptyEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const createBtn = createElement("button", { class: "invite-manager__create btn-modal-save" });
    createBtnEl = createBtn;
    renderCreateButton();
    createBtn.addEventListener("click", () => {
      startCreateInvite();
    }, { signal: ac.signal });
    footer.appendChild(createBtn);

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmOverlay !== null) {
          closeDeleteConfirm();
          return;
        }
        options.onClose();
      }
    }, { signal: ac.signal });

    // Click overlay to close
    root.addEventListener("click", (e) => {
      if (e.target === root) {
        options.onClose();
      }
    }, { signal: ac.signal });

    appendChildren(modal, header, body, footer);
    root.appendChild(modal);
    renderList();

    container.appendChild(root);
  }

  function destroy(): void {
    destroyed = true;
    ac.abort();
    closeDeleteConfirm();
    if (root !== null) {
      root.remove();
      root = null;
    }
    listEl = null;
    emptyEl = null;
    loadingEl = null;
    errorEl = null;
    createBtnEl = null;
  }

  return {
    mount,
    destroy,
    setInvites(nextInvites: readonly InviteItem[]): void {
      invites = nextInvites;
      loadError = null;
      renderList();
    },
    setLoading(loading: boolean): void {
      isLoading = loading;
      renderList();
    },
    setLoadError(message: string | null): void {
      loadError = message;
      renderList();
    },
  };
}
