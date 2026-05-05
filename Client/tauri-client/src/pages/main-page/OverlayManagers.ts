/**
 * Overlay managers — quick switcher, invite manager, and pinned messages panel.
 * Each factory returns an open/toggle + cleanup pair for use in MainPage.
 */

import type { MountableComponent } from "@lib/safe-render";
import type { ApiClient } from "@lib/api";
import { createLogger } from "@lib/logger";
import { createQuickSwitcher } from "@components/QuickSwitcher";
import { createInviteManager } from "@components/InviteManager";
import type { InviteItem } from "@components/InviteManager";
import type { InviteResponse } from "@lib/types";
import { createPinnedMessages } from "@components/PinnedMessages";
import type { PinnedMessage } from "@components/PinnedMessages";
import { createSearchOverlay } from "@components/SearchOverlay";
import { showToast } from "@lib/toast";
import { setActiveChannel } from "@stores/channels.store";

const log = createLogger("overlays");

// ---------------------------------------------------------------------------
// Invite response mapping
// ---------------------------------------------------------------------------

export function mapInviteResponse(r: InviteResponse): InviteItem {
  const createdBy = r.created_by?.username ?? "unknown";
  const uses = r.use_count ?? r.uses ?? 0;
  const status = r.status ?? "active";
  return {
    code: r.code,
    createdBy,
    createdAt: r.created_at ?? "",
    uses,
    maxUses: r.max_uses,
    expiresAt: r.expires_at,
    status,
    redeemedBy: r.redeemed_by?.username ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pinned message mapping
// ---------------------------------------------------------------------------

function pickPinAvatarColor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = username.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 55%)`;
}

export function mapToPinnedMessage(msg: {
  readonly id: number;
  readonly user: { readonly username: string };
  readonly content: string;
  readonly created_at?: string;
  readonly timestamp?: string;
}): PinnedMessage {
  return {
    id: msg.id,
    author: msg.user.username,
    content: msg.content,
    timestamp: msg.created_at ?? msg.timestamp ?? "",
    avatarColor: pickPinAvatarColor(msg.user.username),
  };
}

// ---------------------------------------------------------------------------
// Quick Switcher Manager
// ---------------------------------------------------------------------------

export interface QuickSwitcherManager {
  /** Attach Ctrl+K handler; returns cleanup function. */
  attach(): () => void;
}

export function createQuickSwitcherManager(
  getRoot: () => HTMLDivElement | null,
): QuickSwitcherManager {
  let instance: MountableComponent | null = null;

  function open(): void {
    const root = getRoot();
    if (instance !== null || root === null) return;
    instance = createQuickSwitcher({
      onSelectChannel: (channelId: number) => {
        setActiveChannel(channelId);
      },
      onClose: close,
    });
    instance.mount(root);
  }

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function attach(): () => void {
    const handler = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (instance !== null) {
          close();
        } else {
          open();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      close();
    };
  }

  return { attach };
}

// ---------------------------------------------------------------------------
// Invite Manager Controller
// ---------------------------------------------------------------------------

export interface InviteManagerController {
  open(): Promise<void>;
  cleanup(): void;
}

export function createInviteManagerController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;
  readonly username: string;

}): InviteManagerController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function open(): Promise<void> {
    const root = opts.getRoot();
    if (instance !== null || root === null) return;
    const inviteManager = createInviteManager({
      invites: [],
      username: opts.username,
      loading: true,
      onCreateInvite: async () => {
        const created = await opts.api.createInvite({});
        return mapInviteResponse(created);
      },
      onRevokeInvite: async (code: string) => {
        try {
          await opts.api.revokeInvite(code);
        } catch (err) {
          log.error("Invite revoke failed", { code, error: String(err) });
          throw err;
        }
      },
      onDeleteInvite: async (code: string) => {
        try {
          await opts.api.deleteInvite(code);
          showToast("Приглашение удалено", "success");
        } catch (err) {
          log.error("Invite delete failed", { code, error: String(err) });
          throw err;
        }
      },
      onCopyLink: (code: string) => {
        void navigator.clipboard.writeText(code);
      },
      onClose: close,
      onError: (message: string) => {
        log.error(message);
        showToast(message, "error");
      },
    });
    instance = inviteManager;
    inviteManager.mount(root);

    try {
      const raw = await opts.api.getInvites();
      if (instance !== inviteManager) {
        return;
      }
      inviteManager.setInvites(raw.map(mapInviteResponse));
      inviteManager.setLoadError(null);
    } catch (err) {
      if (instance !== inviteManager) {
        return;
      }
      log.error("Failed to load invites", { error: String(err) });
      inviteManager.setLoadError("Не удалось загрузить приглашения");
      showToast("Не удалось загрузить приглашения", "error");
    } finally {
      if (instance === inviteManager) {
        inviteManager.setLoading(false);
      }
    }
  }

  return { open, cleanup: close };
}

// ---------------------------------------------------------------------------
// Pinned Panel Controller
// ---------------------------------------------------------------------------

export interface PinnedPanelController {
  toggle(): Promise<void>;
  cleanup(): void;
}

export function createPinnedPanelController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;

  readonly getCurrentChannelId: () => number | null;
  readonly onJumpToMessage?: (messageId: number) => boolean;
}): PinnedPanelController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  async function toggle(): Promise<void> {
    if (instance !== null) {
      close();
      return;
    }
    const root = opts.getRoot();
    const channelId = opts.getCurrentChannelId();
    if (root === null || channelId === null) return;
    try {
      const resp = await opts.api.getPins(channelId);
      const pins = resp.messages.map(mapToPinnedMessage);
      instance = createPinnedMessages({
        channelId,
        pinnedMessages: pins,
        onJumpToMessage: (msgId: number) => {
          if (opts.onJumpToMessage !== undefined) {
            const found = opts.onJumpToMessage(msgId);
            if (found) {
              close();
            } else {
              showToast("Message not in loaded window", "info");
            }
          } else {
            close();
          }
        },
        onUnpin: (msgId: number) => {
          void opts.api.unpinMessage(channelId, msgId).then(() => {
            close();
          }).catch((err: unknown) => {
            log.error("Failed to unpin message", { msgId, error: String(err) });
            showToast("Failed to unpin message", "error");
          });
        },
        onClose: close,
      });
      if (root !== null) {
        instance.mount(root);
      }
    } catch (err) {
      log.error("Failed to load pinned messages", { error: String(err) });
      showToast("Failed to load pinned messages", "error");
    }
  }

  return { toggle, cleanup: close };
}

// ---------------------------------------------------------------------------
// Search Overlay Controller
// ---------------------------------------------------------------------------

export interface SearchOverlayController {
  open(): void;
  cleanup(): void;
}

export function createSearchOverlayController(opts: {
  readonly api: ApiClient;
  readonly getRoot: () => HTMLDivElement | null;

  readonly getCurrentChannelId: () => number | null;
  readonly onJumpToMessage?: (channelId: number, messageId: number) => boolean;
}): SearchOverlayController {
  let instance: MountableComponent | null = null;

  function close(): void {
    if (instance !== null) {
      instance.destroy?.();
      instance = null;
    }
  }

  function open(): void {
    const root = opts.getRoot();
    if (instance !== null || root === null) return;

    const channelId = opts.getCurrentChannelId();

    instance = createSearchOverlay({
      currentChannelId: channelId ?? undefined,
      onSearch: async (query, chId, signal) => {
        try {
          const resp = await opts.api.search(query, { channelId: chId }, signal);
          return resp.results;
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          log.error("Search failed", { query, error: String(err) });
          showToast("Search failed", "error");
          throw err;
        }
      },
      onSelectResult: (result) => {
        setActiveChannel(result.channel_id);
        if (opts.onJumpToMessage !== undefined) {
          // Give the channel a frame to mount before scrolling
          requestAnimationFrame(() => {
            const found = opts.onJumpToMessage!(result.channel_id, result.message_id);
            if (!found) {
              showToast("Message not in loaded history", "info");
            }
          });
        }
      },
      onClose: close,
    });
    instance.mount(root);
  }

  return { open, cleanup: close };
}
