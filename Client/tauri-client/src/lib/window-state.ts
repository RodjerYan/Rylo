/**
 * Window state persistence — saves/restores window position and size.
 * Uses Tauri IPC commands backed by tauri-plugin-store.
 */

import { createLogger } from "./logger";

const log = createLogger("window-state");

export interface WindowState {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
}

const STORAGE_KEY = "windowState";
const SAVE_DEBOUNCE_MS = 500;
const MIN_SAFE_WIDTH = 700;
const MIN_SAFE_HEIGHT = 450;
const MAX_SAFE_DIMENSION = 10_000;

const invokePromise: Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> = import("@tauri-apps/api/core")
  .then((m) => m.invoke)
  .catch(() => null);

/**
 * Save the current window state to the Tauri settings store.
 */
async function saveState(state: WindowState): Promise<void> {
  const invoke = await invokePromise;
  if (!invoke) return;
  try {
    await invoke("save_settings", { key: STORAGE_KEY, value: state });
  } catch (err) {
    log.error("Failed to save window state", { error: String(err) });
  }
}

/**
 * Load the previously saved window state.
 */
async function loadState(): Promise<WindowState | null> {
  const invoke = await invokePromise;
  if (!invoke) return null;
  try {
    const all = (await invoke("get_settings")) as Record<string, unknown>;
    const raw = all[STORAGE_KEY];
    if (raw && typeof raw === "object") {
      const s = raw as Record<string, unknown>;
      if (
        typeof s.x === "number" &&
        typeof s.y === "number" &&
        typeof s.width === "number" &&
        typeof s.height === "number" &&
        typeof s.maximized === "boolean"
      ) {
        return {
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
          maximized: s.maximized,
        };
      }
    }
    return null;
  } catch (err) {
    log.error("Failed to load window state", { error: String(err) });
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSizeReasonable(state: WindowState): boolean {
  return state.width >= MIN_SAFE_WIDTH
    && state.height >= MIN_SAFE_HEIGHT
    && state.width <= MAX_SAFE_DIMENSION
    && state.height <= MAX_SAFE_DIMENSION;
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function stateIntersectsAnyMonitor(
  state: WindowState,
  monitors: ReadonlyArray<{
    position: { x: number; y: number };
    size: { width: number; height: number };
  }>,
): boolean {
  const stateRect = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  for (const monitor of monitors) {
    const mx = monitor.position?.x;
    const my = monitor.position?.y;
    const mw = monitor.size?.width;
    const mh = monitor.size?.height;
    if (!isFiniteNumber(mx) || !isFiniteNumber(my) || !isFiniteNumber(mw) || !isFiniteNumber(mh)) {
      continue;
    }
    const monitorRect = { x: mx, y: my, width: mw, height: mh };
    if (rectsIntersect(stateRect, monitorRect)) {
      return true;
    }
  }
  return false;
}

/**
 * Initialize window state persistence.
 * Restores saved position/size on startup and listens for changes.
 * Returns a cleanup function.
 */
export async function initWindowState(): Promise<() => void> {
  let tauriWindow: typeof import("@tauri-apps/api/window") | undefined;
  try {
    tauriWindow = await import("@tauri-apps/api/window");
  } catch {
    return () => {};
  }

  const win = tauriWindow.getCurrentWindow();
  const cleanups: Array<() => void> = [];

  // Restore saved state
  const saved = await loadState();
  if (saved !== null) {
    try {
      if (saved.maximized) {
        await win.maximize();
      } else {
        const monitors = await tauriWindow.availableMonitors();
        const shouldRestore = isSizeReasonable(saved) && stateIntersectsAnyMonitor(saved, monitors);
        if (shouldRestore) {
          const pos = new tauriWindow.PhysicalPosition(saved.x, saved.y);
          const size = new tauriWindow.PhysicalSize(saved.width, saved.height);
          await win.setPosition(pos);
          await win.setSize(size);
        } else {
          log.warn("Skipping invalid/off-screen saved window state", saved);
          await win.center();
        }
      }
      log.info("Restored window state", { x: saved.x, y: saved.y, width: saved.width, height: saved.height });
    } catch (err) {
      log.warn("Failed to restore window state", { error: String(err) });
    }
  }

  // Debounced save on move/resize
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function debouncedSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      void (async () => {
        try {
          const pos = await win.outerPosition();
          const size = await win.outerSize();
          const maximized = await win.isMaximized();
          await saveState({
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized,
          });
        } catch {
          // Window may have been closed during save
        }
      })();
    }, SAVE_DEBOUNCE_MS);
  }

  try {
    const unlistenMoved = await win.onMoved(() => debouncedSave());
    cleanups.push(unlistenMoved);
  } catch {
    // onMoved may not be available
  }

  try {
    const unlistenResized = await win.onResized(() => debouncedSave());
    cleanups.push(unlistenResized);
  } catch {
    // onResized may not be available
  }

  return () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}
