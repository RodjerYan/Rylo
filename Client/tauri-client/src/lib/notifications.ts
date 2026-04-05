/**
 * Notification service — fires desktop notifications, flashes taskbar,
 * and plays sounds for incoming messages based on user preferences.
 */

import { loadPref } from "@components/settings/helpers";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import type { ChatMessagePayload } from "./types";
import { createLogger } from "./logger";

const log = createLogger("notifications");

/** Check if the app window is currently focused. */
function isWindowFocused(): boolean {
  return document.hasFocus();
}

/** Check if the document is actually visible to the user. */
function isDocumentVisible(): boolean {
  return !document.hidden && document.visibilityState === "visible";
}

async function isAppForeground(): Promise<boolean> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [focused, visible, minimized] = await Promise.all([
      win.isFocused(),
      win.isVisible(),
      win.isMinimized(),
    ]);
    return focused && visible && !minimized && isDocumentVisible();
  } catch {
    return isWindowFocused() && isDocumentVisible();
  }
}

/** Check if message content contains @everyone or @here. */
function containsEveryone(content: string): boolean {
  return content.includes("@everyone") || content.includes("@here");
}

/** Get the channel name for a given channel ID. */
function getChannelName(channelId: number): string {
  const channels = channelsStore.getState().channels;
  const channel = channels.get(channelId);
  return channel?.name ?? `Channel ${channelId}`;
}

function resolveNotificationTarget(channelId: number): { titleSuffix: string; isDm: boolean } {
  const dmChannel = dmStore.getState().channels.find((entry) => entry.channelId === channelId);
  if (dmChannel !== undefined) {
    return {
      titleSuffix: dmChannel.recipient.username,
      isDm: true,
    };
  }
  return {
    titleSuffix: `#${getChannelName(channelId)}`,
    isDm: false,
  };
}

/**
 * Handle an incoming chat message — fire desktop notification, flash
 * taskbar, and play sound based on user preferences.
 *
 * Should be called from the dispatcher when a chat_message arrives.
 * Skips notifications for the current user's own messages and when
 * the window is focused on the message's channel.
 */
export function notifyIncomingMessage(payload: ChatMessagePayload): void {
  const currentUser = authStore.getState().user;

  // Don't notify for own messages
  if (currentUser !== null && payload.user.id === currentUser.id) return;

  // Check @everyone suppression
  if (loadPref<boolean>("suppressEveryone", false) && containsEveryone(payload.content)) {
    return;
  }

  void (async () => {
    const activeChannelId = channelsStore.getState().activeChannelId;
    const appForeground = await isAppForeground();

    // Only suppress notifications if the user is actively looking at this exact chat.
    if (appForeground && payload.channel_id === activeChannelId) {
      return;
    }

    const target = resolveNotificationTarget(payload.channel_id);
    const title = target.isDm
      ? `${payload.user.username}`
      : `${payload.user.username} в ${target.titleSuffix}`;
    const body = payload.content.length > 100
      ? payload.content.slice(0, 100) + "..."
      : payload.content;

    if (loadPref<boolean>("desktopNotifications", true)) {
      fireDesktopNotification(title, body);
    }

    if (loadPref<boolean>("flashTaskbar", true)) {
      flashTaskbar();
    }

    if (loadPref<boolean>("notificationSounds", true)) {
      playNotificationSound();
    }
  })();
}

/** Fire a Tauri desktop notification. Falls back to Web Notification API. */
function fireDesktopNotification(title: string, body: string): void {
  void (async () => {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } =
        await import("@tauri-apps/plugin-notification");

      let permitted = await isPermissionGranted();
      if (!permitted) {
        const result = await requestPermission();
        permitted = result === "granted";
      }

      if (permitted) {
        sendNotification({ title, body });
      }
    } catch {
      // Fallback to Web Notification API (dev mode / non-Tauri)
      try {
        if (Notification.permission === "granted") {
          new Notification(title, { body });
        } else if (Notification.permission !== "denied") {
          const result = await Notification.requestPermission();
          if (result === "granted") {
            new Notification(title, { body });
          }
        }
      } catch {
        log.debug("Notifications not available");
      }
    }
  })();
}

/** Flash the taskbar icon to attract attention. */
function flashTaskbar(): void {
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.requestUserAttention(2); // Informational attention
    } catch {
      log.debug("Taskbar flash not available");
    }
  })();
}

// Simple notification sound using Web Audio API
let notifAudioCtx: AudioContext | null = null;

/** Play a brief notification chime. */
function playNotificationSound(): void {
  try {
    if (notifAudioCtx === null) {
      notifAudioCtx = new AudioContext();
    }
    const ctx = notifAudioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  } catch {
    log.debug("Notification sound not available");
  }
}
