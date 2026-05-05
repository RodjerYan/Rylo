// UpdateNotifier — startup auto-update status widget.
// Mounts globally and performs check/apply flow on app launch.

import { createElement, appendChildren } from "@lib/dom";
import { createLogger } from "@lib/logger";
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  listenUpdaterStatus,
  type UpdaterStatusEvent,
} from "@lib/updater";
import type { MountableComponent } from "@lib/safe-render";

const log = createLogger("update-notifier");

export interface UpdateNotifierOptions {
  readonly startupDelayMs?: number;
}

const STARTUP_CHECK_DELAY_MS = 1200;
const IDLE_HIDE_DELAY_MS = 1600;
const ERROR_HIDE_DELAY_MS = 4500;

export function createUpdateNotifier(options: UpdateNotifierOptions = {}): MountableComponent {
  const startupDelayMs = options.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
  let container: Element | null = null;
  let card: HTMLDivElement | null = null;
  let textEl: HTMLSpanElement | null = null;
  let progressBarEl: HTMLDivElement | null = null;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let unlisten: (() => void) | null = null;
  let flowStarted = false;
  let completed = false;

  function isTauriRuntime(): boolean {
    if (typeof window === "undefined") return false;
    return "__TAURI_INTERNALS__" in window;
  }

  function ensureCard(): void {
    if (container === null || card !== null) return;
    card = createElement("div", { class: "update-status-card" });
    const spinner = createElement("span", { class: "update-status-spinner" });
    textEl = createElement("span", { class: "update-status-text" }, "Проверка обновлений...");
    const progressWrap = createElement("div", { class: "update-status-progress" });
    progressBarEl = createElement("div", { class: "update-status-progress-bar" });
    progressWrap.appendChild(progressBarEl);
    appendChildren(card, spinner, textEl, progressWrap);
    container.appendChild(card);
  }

  function scheduleHide(delayMs: number): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      removeCard();
    }, delayMs);
  }

  function setProgress(value: number | null): void {
    if (progressBarEl === null) return;
    if (value === null) {
      progressBarEl.style.width = "18%";
      progressBarEl.classList.add("indeterminate");
      return;
    }
    const clamped = Math.min(100, Math.max(0, value));
    progressBarEl.classList.remove("indeterminate");
    progressBarEl.style.width = `${clamped}%`;
  }

  function setMessage(message: string, stateClass: string): void {
    ensureCard();
    if (card === null || textEl === null) return;
    card.classList.remove("state-checking", "state-downloading", "state-ok", "state-error", "state-installing");
    card.classList.add(stateClass);
    textEl.textContent = message;
  }

  function onStatusEvent(event: UpdaterStatusEvent): void {
    if (completed && event.stage !== "error") return;

    switch (event.stage) {
      case "checking":
        setMessage(event.message || "Проверка обновлений...", "state-checking");
        setProgress(null);
        break;
      case "update_available":
        setMessage(
          event.version ? `Найдена версия ${event.version}. Загружаем...` : "Найдено обновление. Загружаем...",
          "state-downloading",
        );
        setProgress(null);
        break;
      case "downloading": {
        const canCompute = event.total !== null && event.total > 0 && event.downloaded !== null;
        const percent = canCompute ? Math.round((event.downloaded! / event.total!) * 100) : null;
        const text = percent === null
          ? "Загрузка обновления..."
          : `Загрузка обновления... ${percent}%`;
        setMessage(text, "state-downloading");
        setProgress(percent);
        break;
      }
      case "installing":
        setMessage("Установка обновления...", "state-installing");
        setProgress(100);
        break;
      case "restarting":
        setMessage("Обновление установлено. Перезапуск...", "state-ok");
        setProgress(100);
        break;
      case "up_to_date":
        completed = true;
        setMessage("Обновлений нет", "state-ok");
        setProgress(100);
        scheduleHide(IDLE_HIDE_DELAY_MS);
        break;
      case "error":
        completed = true;
        setMessage(event.message || "Ошибка обновления", "state-error");
        setProgress(null);
        scheduleHide(ERROR_HIDE_DELAY_MS);
        break;
      default:
        break;
    }
  }

  async function performStartupUpdate(): Promise<void> {
    if (flowStarted) return;
    flowStarted = true;
    onStatusEvent({
      stage: "checking",
      message: "Проверка обновлений...",
      version: null,
      downloaded: null,
      total: null,
    });

    const result = await checkForUpdate();
    if (result.error) {
      onStatusEvent({
        stage: "error",
        message: "Не удалось проверить обновления",
        version: null,
        downloaded: null,
        total: null,
      });
      log.warn("Startup update check failed", { error: result.error });
      return;
    }

    if (!result.available) {
      onStatusEvent({
        stage: "up_to_date",
        message: "Обновлений нет",
        version: null,
        downloaded: null,
        total: null,
      });
      return;
    }

    onStatusEvent({
      stage: "update_available",
      message: "Найдено обновление",
      version: result.version,
      downloaded: null,
      total: null,
    });

    try {
      await downloadAndInstallUpdate();
      onStatusEvent({
        stage: "restarting",
        message: "Обновление установлено. Перезапуск...",
        version: result.version,
        downloaded: null,
        total: null,
      });
    } catch (err) {
      const error = String(err);
      log.error("Startup update install failed", { error });
      onStatusEvent({
        stage: "error",
        message: "Не удалось установить обновление",
        version: result.version,
        downloaded: null,
        total: null,
      });
    }
  }

  function removeCard(): void {
    if (card !== null) {
      card.remove();
      card = null;
      textEl = null;
      progressBarEl = null;
    }
  }

  function mount(target: Element): void {
    container = target;
    if (!isTauriRuntime()) {
      return;
    }
    ensureCard();
    void (async () => {
      unlisten = await listenUpdaterStatus(onStatusEvent);
    })();
    checkTimer = setTimeout(() => {
      void performStartupUpdate();
    }, startupDelayMs);
  }

  function destroy(): void {
    if (checkTimer !== null) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (unlisten !== null) {
      unlisten();
      unlisten = null;
    }
    removeCard();
    container = null;
  }

  return { mount, destroy };
}
