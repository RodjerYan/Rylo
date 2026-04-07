/**
 * Selection store — tracks which messages are currently selected.
 * Used for bulk operations: delete, forward.
 */

import { createStore } from "@lib/store";
import type { Message } from "./messages.store";

export interface SelectedMessage {
  readonly id: number;
  readonly channelId: number;
  readonly content: string;
  readonly userId: number;
  readonly username: string;
  readonly attachments: Message["attachments"];
}

export interface SelectionState {
  /** Whether selection mode is active */
  readonly active: boolean;
  /** Currently selected message IDs */
  readonly selectedIds: ReadonlySet<number>;
  /** Map of id -> full message snapshot for action bar display */
  readonly selectedMessages: ReadonlyMap<number, SelectedMessage>;
  /** Channel ID where selection is happening */
  readonly channelId: number | null;
}

const INITIAL_STATE: SelectionState = {
  active: false,
  selectedIds: new Set(),
  selectedMessages: new Map(),
  channelId: null,
};

export const selectionStore = createStore<SelectionState>(INITIAL_STATE);

/** Enter selection mode and select the first message. */
export function startSelection(msg: SelectedMessage): void {
  selectionStore.setState(() => ({
    active: true,
    selectedIds: new Set([msg.id]),
    selectedMessages: new Map([[msg.id, msg]]),
    channelId: msg.channelId,
  }));
}

/** Toggle a message in/out of selection. If selection becomes empty, exits selection mode. */
export function toggleSelection(msg: SelectedMessage): void {
  selectionStore.setState((prev) => {
    if (!prev.active) {
      return {
        active: true,
        selectedIds: new Set([msg.id]),
        selectedMessages: new Map([[msg.id, msg]]),
        channelId: msg.channelId,
      };
    }

    const newIds = new Set(prev.selectedIds);
    const newMsgs = new Map(prev.selectedMessages);

    if (newIds.has(msg.id)) {
      newIds.delete(msg.id);
      newMsgs.delete(msg.id);
    } else {
      newIds.add(msg.id);
      newMsgs.set(msg.id, msg);
    }

    if (newIds.size === 0) {
      return INITIAL_STATE;
    }

    return {
      ...prev,
      selectedIds: newIds,
      selectedMessages: newMsgs,
    };
  });
}

/** Clear all selections and exit mode. */
export function clearSelection(): void {
  selectionStore.setState(() => INITIAL_STATE);
}

/** Get array of selected messages sorted by id (chronological). */
export function getSelectedMessages(): SelectedMessage[] {
  const s = selectionStore.getState();
  return Array.from(s.selectedMessages.values()).sort((a, b) => a.id - b.id);
}
