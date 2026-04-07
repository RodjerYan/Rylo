/**
 * ChannelController — channel switching, component mount/destroy lifecycle.
 * Creates and manages MessageList, TypingIndicator, and MessageInput per channel.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { clearChildren, setText } from "@lib/dom";
import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { ChannelType } from "@lib/types";
import { createMessageList } from "@components/MessageList";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { addPendingSend, getChannelMessages, setMessagePinned } from "@stores/messages.store";
import type { MessageController } from "./MessageController";
import type { PendingDeleteManager } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import { updateChatHeaderForDm } from "./ChatHeader";
import type { ChatHeaderRefs } from "./ChatHeader";
import { dmStore } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { openUserProfile } from "@components/UserProfileOverlay";
import { formatStatusForDmHeader } from "@lib/presence";
import { createSelectionBar } from "@components/SelectionBar";
import type { SelectionBarControl } from "@components/SelectionBar";
import { createForwardModal } from "@components/ForwardModal";
import { clearSelection } from "@stores/selection.store";

const log = createLogger("channel-ctrl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelControllerOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  readonly pendingDeleteManager: PendingDeleteManager;
  readonly reactionCtrl: ReactionController;
  readonly typingLimiter: { tryConsume(key?: string): boolean };
  readonly showToast: (msg: string, type: string) => void;
  readonly getCurrentUserId: () => number;
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
  };
  readonly chatHeaderName: HTMLSpanElement | null;
  readonly chatHeaderRefs: ChatHeaderRefs | null;
}

export interface ChannelController {
  /** Mount components for a channel. No-op if same channel already mounted. */
  mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void;
  /** Destroy current channel components and reset state. */
  destroyChannel(): void;
  /** Currently mounted channel ID, or null. */
  readonly currentChannelId: number | null;
  /** Currently mounted message list (for scroll-to-message). */
  readonly messageList: MessageListComponent | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createChannelController(
  opts: ChannelControllerOptions,
): ChannelController {
  const {
    ws,
    api,
    msgCtrl,
    pendingDeleteManager,
    reactionCtrl,
    typingLimiter,
    showToast,
    getCurrentUserId,
    slots,
    chatHeaderName,
    chatHeaderRefs,
  } = opts;

  let _currentChannelId: number | null = null;
  let channelAbort: AbortController | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  let channelUnsubs: Array<() => void> = [];
  let selectionBar: SelectionBarControl | null = null;

  function destroyChannel(): void {
    pendingDeleteManager.cleanup();
    clearSelection();

    if (channelAbort !== null) {
      channelAbort.abort();
      channelAbort = null;
    }

    if (selectionBar !== null) {
      selectionBar.destroy();
      selectionBar = null;
    }
    if (messageList !== null) {
      messageList.destroy?.();
      messageList = null;
    }
    if (typingIndicator !== null) {
      typingIndicator.destroy?.();
      typingIndicator = null;
    }
    if (messageInput !== null) {
      messageInput.destroy?.();
      messageInput = null;
    }
    for (const unsub of channelUnsubs) {
      unsub();
    }
    channelUnsubs = [];
    clearChildren(slots.messagesSlot);
    clearChildren(slots.typingSlot);
    clearChildren(slots.inputSlot);

    _currentChannelId = null;
  }

  function mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void {
    if (_currentChannelId === channelId) return;

    destroyChannel();
    _currentChannelId = channelId;

    log.info("Switching channel", { channelId, channelName });

    ws.send({
      type: "channel_focus",
      payload: { channel_id: channelId },
    });

    channelAbort = new AbortController();
    const signal = channelAbort.signal;
    const userId = getCurrentUserId();

    void msgCtrl.loadMessages(channelId, signal);

    // MessageList
    messageList = createMessageList({
      channelId,
      channelName,
      channelType,
      currentUserId: userId,
      onScrollTop: () => {
        if (channelAbort !== null) {
          void msgCtrl.loadOlderMessages(channelId, channelAbort.signal);
        }
      },
      onReplyClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        messageInput?.setReplyTo(msgId, msg?.user.username ?? "");
      },
      onEditClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        if (msg !== undefined) {
          messageInput?.startEdit(msgId, msg.content);
        }
      },
      onDeleteClick: (msgId: number) => {
        const result = pendingDeleteManager.tryDelete(msgId);
        if (result === "confirmed") {
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
          showToast("Message deleted", "success");
        } else {
          showToast("Click delete again to confirm", "info");
        }
      },
      onReactionClick: (msgId: number, emoji: string) => {
        reactionCtrl.handleReaction(msgId, emoji);
      },
      onPinClick: (msgId: number, chId: number, currentlyPinned: boolean) => {
        const action = currentlyPinned
          ? api.unpinMessage(chId, msgId)
          : api.pinMessage(chId, msgId);
        action.then(() => {
          setMessagePinned(chId, msgId, !currentlyPinned);
          showToast(currentlyPinned ? "Message unpinned" : "Message pinned", "success");
        }).catch((err) => {
          log.error("Pin/unpin failed", { error: String(err) });
          showToast("Failed to pin/unpin message", "error");
        });
      },
    });
    messageList.mount(slots.messagesSlot);

    // TypingIndicator
    typingIndicator = createTypingIndicator({
      channelId,
      currentUserId: userId,
    });
    typingIndicator.mount(slots.typingSlot);

    // MessageInput
    messageInput = createMessageInput({
      channelId,
      channelName,
      onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => {
        if (ws.getState() !== "connected") {
          log.warn("Cannot send message: not connected");
          showToast("Not connected — message not sent", "error");
          return;
        }
        const requestID = ws.send({
          type: "chat_send",
          payload: {
            channel_id: channelId,
            content,
            reply_to: replyTo,
            attachments,
          },
        });
        addPendingSend(requestID, channelId, content, replyTo, attachments);
      },
      onUploadFile: async (file: File) => {
        try {
          const result = await api.uploadFile(file);
          return { id: result.id, url: result.url, filename: result.filename };
        } catch (err) {
          log.error("File upload failed", { error: String(err) });
          showToast("File upload failed", "error");
          throw err;
        }
      },
      onTyping: () => {
        if (typingLimiter.tryConsume(String(channelId))) {
          ws.send({
            type: "typing_start",
            payload: { channel_id: channelId },
          });
        }
      },
      onEditMessage: (messageId: number, content: string) => {
        const trimmed = content.trim();
        if (trimmed === "") {
          showToast("Message cannot be empty", "error");
          return;
        }
        const msgs = getChannelMessages(channelId);
        const original = msgs.find((m) => m.id === messageId);
        if (original !== undefined && original.content === trimmed) {
          return;
        }
        ws.send({
          type: "chat_edit",
          payload: { message_id: messageId, content: trimmed },
        });
        showToast("Message edited", "success");
      },
    });
    messageInput.mount(slots.inputSlot);

    // SelectionBar — mounts as overlay over the input area
    selectionBar = createSelectionBar({
      currentUserId: userId,
      onDeleteForMe: (messageIds) => {
        // Delete for me: send delete for each (server will handle visibility per user)
        // The Rylo server's chat_delete broadcasts to all; so we use it as "delete for all"
        // For "delete for me only" we visually hide via a client-side filter in the future.
        // For now, treat the same as delete-for-all since the server doesn't distinguish.
        for (const msgId of messageIds) {
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
        }
        showToast(`Удалено ${messageIds.length} сообщ.`, "success");
      },
      onDeleteForAll: (messageIds) => {
        for (const msgId of messageIds) {
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
        }
        showToast(`Удалено у всех ${messageIds.length} сообщ.`, "success");
      },
      onForward: (messages) => {
        // Show ForwardModal
        const modal = createForwardModal({
          onForward: (targetChannelId: number) => {
            modal.destroy();
            // Send each selected message as a new chat_send to the target channel
            for (const msg of messages) {
              const content = msg.content.trim() !== ""
                ? msg.content
                : (msg.attachments.length > 0 ? `[Attachment: ${msg.attachments[0]?.filename ?? "file"}]` : "");
              if (content === "") continue;
              const reqId = ws.send({
                type: "chat_send",
                payload: {
                  channel_id: targetChannelId,
                  content,
                  reply_to: null,
                  attachments: [],
                },
              });
              addPendingSend(reqId, targetChannelId, content, null, []);
            }
            clearSelection();
            showToast(`Переслано ${messages.length} сообщ.`, "success");
          },
          onClose: () => modal.destroy(),
        });
        // Mount modal in document body so it overlays everything
        document.body.appendChild(modal.element);
      },
    });
    const selBarWrapper = createElement("div", { class: "selection-bar-wrapper" });
    selBarWrapper.appendChild(selectionBar.element);
    slots.inputSlot.appendChild(selBarWrapper);

    // Arrow-up edit: listen for edit-last-message bubbling from MessageInput
    slots.inputSlot.addEventListener("edit-last-message", () => {
      const msgs = getChannelMessages(channelId);
      const myId = getCurrentUserId();
      // Find the last message sent by the current user (array is chronological)
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (m.user.id === myId && !m.deleted) {
          messageInput?.startEdit(m.id, m.content);
          break;
        }
      }
    }, { signal });

    // Update header
    if (chatHeaderRefs !== null && channelType === "dm") {
      const updateDmHeader = (): void => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        let statusValue = dmChannel?.recipient.status ?? "offline";
        let lastSeenValue = dmChannel?.recipient.lastSeen ?? null;
        if (dmChannel !== undefined) {
          const member = membersStore.getState().members.get(dmChannel.recipient.id);
          statusValue = member?.status ?? statusValue;
          lastSeenValue = member?.lastSeen ?? lastSeenValue;
        }
        updateChatHeaderForDm(chatHeaderRefs, {
          username: channelName,
          status: formatStatusForDmHeader(statusValue, lastSeenValue),
          profileID: dmChannel?.recipient.profileId,
        });
      };
      updateDmHeader();
      channelUnsubs.push(
        membersStore.subscribeSelector(
          (s) => s.members,
          () => updateDmHeader(),
        ),
      );
      channelUnsubs.push(
        dmStore.subscribeSelector(
          (s) => s.channels,
          () => updateDmHeader(),
        ),
      );
      chatHeaderRefs.nameEl.classList.add("ch-name--clickable");
      chatHeaderRefs.hashEl.classList.add("ch-name--clickable");
      const openRecipientProfile = (): void => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        if (dmChannel === undefined) {
          return;
        }
        openUserProfile({
          id: dmChannel.recipient.id,
          profileId: dmChannel.recipient.profileId,
          username: dmChannel.recipient.username,
          avatar: dmChannel.recipient.avatar,
          status: dmChannel.recipient.status,
          lastSeen: dmChannel.recipient.lastSeen ?? undefined,
        });
      };
      chatHeaderRefs.nameEl.addEventListener("click", openRecipientProfile, { signal });
      chatHeaderRefs.hashEl.addEventListener("click", openRecipientProfile, { signal });
    } else if (chatHeaderRefs !== null) {
      updateChatHeaderForDm(chatHeaderRefs, null);
      chatHeaderRefs.nameEl.classList.remove("ch-name--clickable");
      chatHeaderRefs.hashEl.classList.remove("ch-name--clickable");
      if (chatHeaderName !== null) {
        setText(chatHeaderName, channelName);
      }
    } else if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }
  }

  return {
    mountChannel,
    destroyChannel,
    get currentChannelId() {
      return _currentChannelId;
    },
    get messageList() {
      return messageList;
    },
  };
}
