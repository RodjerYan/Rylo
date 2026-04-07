/**
 * SelectionBar — floating action bar shown when messages are selected.
 * Displays count, cancel, delete (self / all), and forward options.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import {
  selectionStore,
  clearSelection,
  getSelectedMessages,
} from "@stores/selection.store";

export interface SelectionBarOptions {
  /** Current user's ID to determine delete-for-all eligibility */
  readonly currentUserId: number;
  /** Called when user confirms "Delete for me" */
  readonly onDeleteForMe: (messageIds: number[]) => void;
  /** Called when user confirms "Delete for all" */
  readonly onDeleteForAll: (messageIds: number[]) => void;
  /** Called when user wants to forward selected messages */
  readonly onForward: (messages: ReturnType<typeof getSelectedMessages>) => void;
}

export interface SelectionBarControl {
  readonly element: HTMLDivElement;
  destroy(): void;
}

export function createSelectionBar(opts: SelectionBarOptions): SelectionBarControl {
  // Root container — absolutely positioned over the input slot area
  const bar = createElement("div", { class: "selection-bar", style: "display:none;" });

  // Left side: cancel button
  const cancelBtn = createElement("button", { class: "sel-bar-btn sel-bar-cancel", title: "Отмена" });
  cancelBtn.appendChild(createIcon("x", 20));
  cancelBtn.addEventListener("click", () => clearSelection());

  // Center: count label
  const countLabel = createElement("span", { class: "sel-bar-count" }, "0 сообщений");

  // Right side: action buttons
  const actionsGroup = createElement("div", { class: "sel-bar-actions" });

  const forwardBtn = createElement("button", {
    class: "sel-bar-btn sel-bar-forward",
    title: "Переслать",
  });
  forwardBtn.appendChild(createIcon("corner-up-right", 20));
  forwardBtn.addEventListener("click", () => {
    const selected = getSelectedMessages();
    if (selected.length === 0) return;
    opts.onForward(selected);
  });

  const deleteForMeBtn = createElement("button", {
    class: "sel-bar-btn sel-bar-delete-me",
    title: "Удалить у меня",
  });
  deleteForMeBtn.appendChild(createIcon("eye-off", 20));
  deleteForMeBtn.addEventListener("click", () => {
    const selected = getSelectedMessages();
    if (selected.length === 0) return;
    const confirmed = window.confirm(`Удалить ${selected.length} сообщений только у вас?`);
    if (!confirmed) return;
    opts.onDeleteForMe(selected.map((m) => m.id));
    clearSelection();
  });

  const deleteForAllBtn = createElement("button", {
    class: "sel-bar-btn sel-bar-delete-all",
    title: "Удалить у всех",
  });
  deleteForAllBtn.appendChild(createIcon("trash-2", 20));

  appendChildren(actionsGroup, forwardBtn, deleteForMeBtn, deleteForAllBtn);
  appendChildren(bar, cancelBtn, countLabel, actionsGroup);

  // Subscribe to selection store
  const unsub = selectionStore.subscribe((state) => {
    if (!state.active) {
      bar.style.display = "none";
      deleteForAllBtn.style.display = "";
      return;
    }

    bar.style.display = "flex";
    const count = state.selectedIds.size;
    countLabel.textContent = `${count} ${getCountLabel(count)}`;

    // Show "Delete for all" only if ALL selected messages belong to current user
    const selected = getSelectedMessages();
    const allMine = selected.every((m) => m.userId === opts.currentUserId);
    deleteForAllBtn.style.display = allMine ? "" : "none";
  });

  // Wire up "Delete for all" separately so it can access fresh selection
  deleteForAllBtn.addEventListener("click", () => {
    const selected = getSelectedMessages();
    if (selected.length === 0) return;
    const confirmed = window.confirm(`Удалить ${selected.length} сообщений у всех?`);
    if (!confirmed) return;
    opts.onDeleteForAll(selected.map((m) => m.id));
    clearSelection();
  });

  return {
    element: bar,
    destroy() {
      unsub();
      bar.remove();
    },
  };
}

function getCountLabel(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return "сообщение";
  if (count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14)) return "сообщения";
  return "сообщений";
}
