/**
 * ForwardModal — channel picker modal to forward selected messages.
 */
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";

export interface ForwardModalOptions {
  /** Called with the target channelId the user picked */
  readonly onForward: (channelId: number) => void;
  readonly onClose: () => void;
}

export interface ForwardModalControl {
  readonly element: HTMLDivElement;
  destroy(): void;
}

export function createForwardModal(opts: ForwardModalOptions): ForwardModalControl {
  const backdrop = createElement("div", { class: "modal-backdrop" });
  const modal = createElement("div", { class: "forward-modal" });

  // Header
  const header = createElement("div", { class: "forward-modal-header" });
  const title = createElement("h3", {}, "Переслать в...");
  const closeBtn = createElement("button", { class: "forward-modal-close" });
  closeBtn.appendChild(createIcon("x", 18));
  closeBtn.addEventListener("click", () => opts.onClose());
  appendChildren(header, title, closeBtn);

  // Search
  const searchInput = createElement("input", {
    class: "forward-modal-search",
    placeholder: "Поиск каналов...",
    type: "text",
  }) as HTMLInputElement;

  // Channel list
  const list = createElement("div", { class: "forward-modal-list" });

  // Populate list
  function buildList(filter: string): void {
    clearChildren(list);

    const channels = Array.from(channelsStore.getState().channels.values())
      .filter((c) => c.type === "text" || c.type === "voice" || c.type === "announcement")
      .filter((c) => filter === "" || c.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.position - b.position);

    const dmChannels = dmStore.getState().channels
      .filter((c) => filter === "" || c.recipient.username.toLowerCase().includes(filter.toLowerCase()));

    if (channels.length > 0) {
      const groupLabel = createElement("div", { class: "forward-group-label" }, "Каналы");
      list.appendChild(groupLabel);
    }

    for (const ch of channels) {
      const row = createElement("div", { class: "forward-channel-row" });
      const icon = createElement("span", { class: "forward-ch-icon" });
      icon.appendChild(createIcon("hash", 14));
      const name = createElement("span", { class: "forward-ch-name" }, ch.name);
      appendChildren(row, icon, name);
      row.addEventListener("click", () => opts.onForward(ch.id));
      list.appendChild(row);
    }

    if (dmChannels.length > 0) {
      const groupLabel = createElement("div", { class: "forward-group-label" }, "Личные сообщения");
      list.appendChild(groupLabel);
    }

    for (const dm of dmChannels) {
      const row = createElement("div", { class: "forward-channel-row" });
      
      // Mini avatar
      const av = createElement("div", { class: "forward-dm-avatar" });
      av.textContent = dm.recipient.username.charAt(0).toUpperCase();
      
      const name = createElement("span", { class: "forward-ch-name" }, dm.recipient.username);
      appendChildren(row, av, name);
      row.addEventListener("click", () => opts.onForward(dm.channelId));
      list.appendChild(row);
    }

    if (list.childElementCount === 0) {
      const empty = createElement("div", { class: "forward-empty" }, "Ничего не найдено");
      list.appendChild(empty);
    }
  }

  buildList("");
  searchInput.addEventListener("input", () => buildList(searchInput.value));

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) opts.onClose();
  });

  appendChildren(modal, header, searchInput, list);
  backdrop.appendChild(modal);

  return {
    element: backdrop,
    destroy() {
      backdrop.remove();
    },
  };
}
