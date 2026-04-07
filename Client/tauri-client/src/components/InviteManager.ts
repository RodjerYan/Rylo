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
  loading?: boolean;
  loadError?: string | null;
  onCreateInvite(): Promise<InviteItem>;
  onRevokeInvite(code: string): Promise<void>;
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
  let invites: readonly InviteItem[] = options.invites;
  let isLoading = options.loading ?? false;
  let loadError = options.loadError ?? null;

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

    if (invites.length === 0) {
      emptyEl.textContent = loadError ?? "Нет активных приглашений";
      emptyEl.style.display = "";
      return;
    }

    emptyEl.style.display = "none";

    for (const invite of invites) {
      const status = invite.status ?? "active";
      const redeemedBy = invite.redeemedBy ?? null;
      const isUsed = status === "used";
      const isInactive = status === "used" || status === "revoked" || status === "expired";
      const row = createElement("div", { class: `invite-item${isInactive ? " invite-item--inactive" : ""}` });

      // Top row: code + action buttons
      const headerRow = createElement("div", { class: "invite-item__header" });
      const code = createElement("span", { class: "invite-item__code" }, maskCode(invite.code));
      const actions = createElement("div", { class: "invite-item__actions" });

      const copyBtn = createElement("button", { class: "invite-item__copy" });
      copyBtn.appendChild(createIcon("external-link", 14));
      copyBtn.appendChild(document.createTextNode(" Копировать"));
      copyBtn.addEventListener("click", () => {
        options.onCopyLink(invite.code);
      }, { signal: ac.signal });

      appendChildren(actions, copyBtn);
      if (!isUsed) {
        const revokeBtn = createElement("button", { class: "invite-item__revoke" });
        revokeBtn.appendChild(createIcon("trash-2", 14));
        revokeBtn.appendChild(document.createTextNode(" Отозвать"));
        revokeBtn.addEventListener("click", () => {
          void options.onRevokeInvite(invite.code).then(() => {
            invites = invites.map((i) => (i.code === invite.code ? { ...i, status: "revoked" as const } : i));
            renderList();
          }).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : "Не удалось отозвать приглашение";
            options.onError?.(message);
          });
        }, { signal: ac.signal });
        actions.appendChild(revokeBtn);
      }
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
      listEl.appendChild(row);
    }
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "modal-overlay visible",
    });

    const modal = createElement("div", {
      class: "modal",
    });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Приглашения сервера");
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
    createBtn.appendChild(createIcon("external-link", 14));
    createBtn.appendChild(document.createTextNode(" Создать приглашение"));
    createBtn.addEventListener("click", () => {
      void options.onCreateInvite().then((newInvite) => {
        invites = [...invites, newInvite];
        renderList();
      }).catch(() => {
        options.onError?.("Не удалось создать приглашение");
      });
    }, { signal: ac.signal });
    footer.appendChild(createBtn);

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
    listEl = null;
    emptyEl = null;
    loadingEl = null;
    errorEl = null;
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
