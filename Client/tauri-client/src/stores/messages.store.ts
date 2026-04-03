/**
 * Messages store — holds chat messages per channel, pending send tracking,
 * and load state for infinite scroll.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import type {
  ChatMessagePayload,
  ChatEditedPayload,
  ChatDeletedPayload,
  ReactionUpdatePayload,
  MessageUser,
  Attachment,
  ReactionSummary,
  MessageResponse,
} from "@lib/types";
import { authStore } from "@stores/auth.store";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Message {
  readonly id: number;
  readonly channelId: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly replyTo: number | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
  readonly localState?: "sending";
}

interface PendingSend {
  readonly correlationId: string;
  readonly channelId: number;
  readonly content: string;
  readonly replyTo: number | null;
  readonly attachments: readonly string[];
  readonly createdAt: string;
  readonly localId: number;
  readonly user: MessageUser;
  readonly acknowledged: boolean;
  readonly serverMessageId: number | null;
  readonly serverTimestamp: string | null;
}

export interface MessagesState {
  /** Messages per channel: channelId -> ordered array of Message */
  readonly messagesByChannel: ReadonlyMap<number, readonly Message[]>;
  /** Pending send confirmations: correlationId -> channelId */
  readonly pendingSends: ReadonlyMap<string, number>;
  /** Pending outbound messages rendered optimistically in chat */
  readonly pendingMessages: ReadonlyMap<string, PendingSend>;
  /** Whether we've loaded initial messages for a channel */
  readonly loadedChannels: ReadonlySet<number>;
  /** Whether more messages exist above for a channel */
  readonly hasMore: ReadonlyMap<number, boolean>;
}

// -----------------------------------------------------------------------------
// Helpers: convert wire types to store types
// -----------------------------------------------------------------------------

function chatPayloadToMessage(payload: ChatMessagePayload): Message {
  return {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user,
    content: payload.content,
    replyTo: payload.reply_to,
    attachments: payload.attachments,
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: payload.timestamp,
  };
}

function messageResponseToMessage(response: MessageResponse): Message {
  return {
    id: response.id,
    channelId: response.channel_id,
    user: response.user,
    content: response.content,
    replyTo: response.reply_to,
    attachments: response.attachments,
    reactions: response.reactions,
    pinned: response.pinned,
    editedAt: response.edited_at,
    deleted: response.deleted,
    timestamp: response.timestamp,
  };
}

function attachmentsMatch(
  sentAttachmentIDs: readonly string[],
  incoming: readonly Attachment[],
): boolean {
  if (sentAttachmentIDs.length !== incoming.length) {
    return false;
  }
  for (let i = 0; i < sentAttachmentIDs.length; i++) {
    if (sentAttachmentIDs[i] !== incoming[i]?.id) {
      return false;
    }
  }
  return true;
}

function findMatchingPendingSend(
  pendingSends: ReadonlyMap<string, PendingSend>,
  incoming: Message,
): string | null {
  let matchedCorrelationId: string | null = null;
  let matchedLocalId = Number.NEGATIVE_INFINITY;
  for (const [correlationId, pending] of pendingSends) {
    if (pending.channelId !== incoming.channelId) {
      continue;
    }
    if (pending.user.id !== incoming.user.id) {
      continue;
    }
    if (pending.content !== incoming.content) {
      continue;
    }
    if (pending.replyTo !== incoming.replyTo) {
      continue;
    }
    if (!attachmentsMatch(pending.attachments, incoming.attachments)) {
      continue;
    }
    if (pending.localId > matchedLocalId) {
      matchedLocalId = pending.localId;
      matchedCorrelationId = correlationId;
    }
  }
  return matchedCorrelationId;
}

function pendingToMessage(pending: PendingSend): Message {
  return {
    id: pending.localId,
    channelId: pending.channelId,
    user: pending.user,
    content: pending.content,
    replyTo: pending.replyTo,
    attachments: [],
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: pending.serverTimestamp ?? pending.createdAt,
    localState: "sending",
  };
}

function messageSort(a: Message, b: Message): number {
  const aTs = Date.parse(a.timestamp);
  const bTs = Date.parse(b.timestamp);
  if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) {
    return aTs - bTs;
  }
  return a.id - b.id;
}

/** Maximum messages retained per channel. Oldest messages are evicted when exceeded. */
const MAX_MESSAGES_PER_CHANNEL = 500;
let nextPendingLocalId = -1;

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

const INITIAL_STATE: MessagesState = {
  messagesByChannel: new Map(),
  pendingSends: new Map(),
  pendingMessages: new Map(),
  loadedChannels: new Set(),
  hasMore: new Map(),
};

// -----------------------------------------------------------------------------
// Store instance
// -----------------------------------------------------------------------------

export const messagesStore = createStore<MessagesState>(INITIAL_STATE);

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/** Append a new message from a chat_message WS event. */
export function addMessage(payload: ChatMessagePayload): void {
  const message = chatPayloadToMessage(payload);
  const currentUserId = authStore.getState().user?.id ?? 0;
  messagesStore.setState((prev) => {
    const channelId = message.channelId;
    const existing = prev.messagesByChannel.get(channelId) ?? [];
    let updatedMsgs = [...existing, message];
    // Evict oldest messages if over the cap
    if (updatedMsgs.length > MAX_MESSAGES_PER_CHANNEL) {
      updatedMsgs = updatedMsgs.slice(updatedMsgs.length - MAX_MESSAGES_PER_CHANNEL);
    }
    const updated = new Map(prev.messagesByChannel);
    updated.set(channelId, updatedMsgs);
    // If we evicted, there are now more messages on the server above
    const updatedHasMore = new Map(prev.hasMore);
    if (existing.length + 1 > MAX_MESSAGES_PER_CHANNEL) {
      updatedHasMore.set(channelId, true);
    }
    let updatedPendingMessages = prev.pendingMessages;
    if (currentUserId !== 0 && message.user.id === currentUserId) {
      const matchedCorrelationId = findMatchingPendingSend(prev.pendingMessages, message);
      if (matchedCorrelationId !== null) {
        const nextPendingMessages = new Map(prev.pendingMessages);
        nextPendingMessages.delete(matchedCorrelationId);
        updatedPendingMessages = nextPendingMessages;
      }
    }
    return {
      ...prev,
      messagesByChannel: updated,
      hasMore: updatedHasMore,
      pendingMessages: updatedPendingMessages,
    };
  });
}

/** Bulk set messages from a REST response. Marks channel as loaded.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function setMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).reverse();
  const trimmed = converted.length > MAX_MESSAGES_PER_CHANNEL
    ? converted.slice(converted.length - MAX_MESSAGES_PER_CHANNEL)
    : converted;
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, trimmed);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.add(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.set(channelId, hasMore || converted.length > MAX_MESSAGES_PER_CHANNEL);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
    };
  });
}

/** Prepend older messages for infinite scroll.
 *  The server returns messages newest-first; we reverse to chronological order. */
export function prependMessages(
  channelId: number,
  messages: readonly MessageResponse[],
  hasMore: boolean,
): void {
  const converted = messages.map(messageResponseToMessage).reverse();
  messagesStore.setState((prev) => {
    const existing = prev.messagesByChannel.get(channelId) ?? [];
    let combined = [...converted, ...existing];
    // Keep newest messages (end of array); drop oldest loaded history when cap exceeded
    const wasTrimmed = combined.length > MAX_MESSAGES_PER_CHANNEL;
    if (wasTrimmed) {
      combined = combined.slice(combined.length - MAX_MESSAGES_PER_CHANNEL);
    }
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, combined);

    const updatedHasMore = new Map(prev.hasMore);
    // If we trimmed older messages, there are definitely more on the server above.
    updatedHasMore.set(channelId, hasMore || wasTrimmed);

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      hasMore: updatedHasMore,
    };
  });
}

/** Update message content and editedAt from a chat_edited WS event. */
export function editMessage(payload: ChatEditedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id
        ? { ...msg, content: payload.content, editedAt: payload.edited_at }
        : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Soft-delete: mark message as deleted but keep in array. */
export function deleteMessage(payload: ChatDeletedPayload): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === payload.message_id ? { ...msg, deleted: true } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Toggle the pinned state of a message (optimistic update after API call). */
export function setMessagePinned(
  channelId: number,
  messageId: number,
  pinned: boolean,
): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(channelId);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) =>
      msg.id === messageId ? { ...msg, pinned } : msg,
    );

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(channelId, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

/** Track a pending outbound message send. */
export function addPendingSend(
  correlationId: string,
  channelId: number,
  content = "",
  replyTo: number | null = null,
  attachments: readonly string[] = [],
): void {
  const me = authStore.getState().user;
  const pendingUser: MessageUser = {
    id: me?.id ?? 0,
    username: me?.username ?? "Вы",
    avatar: me?.avatar ?? null,
  };
  const pendingSend: PendingSend = {
    correlationId,
    channelId,
    content,
    replyTo,
    attachments: [...attachments],
    createdAt: new Date().toISOString(),
    localId: nextPendingLocalId,
    user: pendingUser,
    acknowledged: false,
    serverMessageId: null,
    serverTimestamp: null,
  };
  nextPendingLocalId -= 1;
  messagesStore.setState((prev) => {
    const updatedPending = new Map(prev.pendingSends);
    updatedPending.set(correlationId, channelId);
    const updatedPendingMessages = new Map(prev.pendingMessages);
    updatedPendingMessages.set(correlationId, pendingSend);
    return {
      ...prev,
      pendingSends: updatedPending,
      pendingMessages: updatedPendingMessages,
    };
  });
}

/** Confirm a pending send — keep message visible until chat_message arrives. */
export function confirmSend(
  correlationId: string,
  messageId: number,
  timestamp: string,
): void {
  messagesStore.setState((prev) => {
    const updatedPendingSends = new Map(prev.pendingSends);
    updatedPendingSends.delete(correlationId);
    const pending = prev.pendingMessages.get(correlationId);
    if (pending === undefined) {
      if (updatedPendingSends.size === prev.pendingSends.size) {
        return prev;
      }
      return {
        ...prev,
        pendingSends: updatedPendingSends,
      };
    }
    const updatedPendingMessages = new Map(prev.pendingMessages);
    updatedPendingMessages.set(correlationId, {
      ...pending,
      acknowledged: true,
      serverMessageId: messageId,
      serverTimestamp: timestamp,
    });
    return {
      ...prev,
      pendingSends: updatedPendingSends,
      pendingMessages: updatedPendingMessages,
    };
  });
}

/** Clear all messages for a channel. */
export function clearChannelMessages(channelId: number): void {
  messagesStore.setState((prev) => {
    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.delete(channelId);

    const updatedLoaded = new Set(prev.loadedChannels);
    updatedLoaded.delete(channelId);

    const updatedHasMore = new Map(prev.hasMore);
    updatedHasMore.delete(channelId);
    const updatedPendingSends = new Map(prev.pendingSends);
    const updatedPendingMessages = new Map(prev.pendingMessages);
    for (const [correlationId, pendingChannelID] of prev.pendingSends) {
      if (pendingChannelID === channelId) {
        updatedPendingSends.delete(correlationId);
        updatedPendingMessages.delete(correlationId);
      }
    }

    return {
      ...prev,
      messagesByChannel: updatedMessages,
      loadedChannels: updatedLoaded,
      hasMore: updatedHasMore,
      pendingSends: updatedPendingSends,
      pendingMessages: updatedPendingMessages,
    };
  });
}

/** Update reactions on a message from a reaction_update WS event. */
export function updateReaction(
  payload: ReactionUpdatePayload,
  currentUserId: number,
): void {
  messagesStore.setState((prev) => {
    const channelMessages = prev.messagesByChannel.get(payload.channel_id);
    if (!channelMessages) return prev;

    const updatedList = channelMessages.map((msg) => {
      if (msg.id !== payload.message_id) return msg;

      const isMe = payload.user_id === currentUserId;
      const existing = msg.reactions;

      if (payload.action === "add") {
        const found = existing.find((r) => r.emoji === payload.emoji);
        if (found !== undefined) {
          const updatedReactions = existing.map((r) =>
            r.emoji === payload.emoji
              ? { ...r, count: r.count + 1, me: r.me || isMe }
              : r,
          );
          return { ...msg, reactions: updatedReactions };
        }
        return {
          ...msg,
          reactions: [...existing, { emoji: payload.emoji, count: 1, me: isMe }],
        };
      }

      // action === "remove"
      const updatedReactions = existing
        .map((r) =>
          r.emoji === payload.emoji
            ? { ...r, count: r.count - 1, me: isMe ? false : r.me }
            : r,
        )
        .filter((r) => r.count > 0);
      return { ...msg, reactions: updatedReactions };
    });

    const updatedMessages = new Map(prev.messagesByChannel);
    updatedMessages.set(payload.channel_id, updatedList);
    return { ...prev, messagesByChannel: updatedMessages };
  });
}

// -----------------------------------------------------------------------------
// Selectors
// -----------------------------------------------------------------------------

/** Get messages for a channel, or empty array if none loaded. */
export function getChannelMessages(channelId: number): readonly Message[] {
  return messagesStore.select(
    (s) => {
      const base = s.messagesByChannel.get(channelId) ?? [];
      const pending: Message[] = [];
      for (const pendingSend of s.pendingMessages.values()) {
        if (pendingSend.channelId === channelId) {
          pending.push(pendingToMessage(pendingSend));
        }
      }
      if (pending.length === 0) {
        return base;
      }
      const merged = [...base, ...pending];
      merged.sort(messageSort);
      return merged;
    },
  );
}

/** Check whether initial messages have been loaded for a channel. */
export function isChannelLoaded(channelId: number): boolean {
  return messagesStore.select((s) => s.loadedChannels.has(channelId));
}

/** Check whether a channel has more older messages to fetch. */
export function hasMoreMessages(channelId: number): boolean {
  return messagesStore.select((s) => s.hasMore.get(channelId) ?? false);
}
