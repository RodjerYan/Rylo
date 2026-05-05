// updater.ts — client auto-update service.
// Uses custom Tauri commands that check/apply updates from GitHub releases.

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createLogger } from "@lib/logger";

const log = createLogger("updater");
const GITHUB_UPDATER_ENDPOINT =
  "https://github.com/RodjerYan/Rylo/releases/latest/download/latest.json";

export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
  readonly error?: string;
}

export type UpdaterStage =
  | "checking"
  | "update_available"
  | "up_to_date"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export interface UpdaterStatusEvent {
  readonly stage: UpdaterStage;
  readonly message: string;
  readonly version: string | null;
  readonly downloaded: number | null;
  readonly total: number | null;
}

const DEFAULT_STATUS_EVENT: UpdaterStatusEvent = {
  stage: "checking",
  message: "",
  version: null,
  downloaded: null,
  total: null,
};

/** Check if a newer client version is available in the GitHub release channel. */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  // Preflight updater manifest URL. Unsiged GitHub releases often don't
  // publish latest.json, and that should be treated as "no updates", not error.
  try {
    const preflight = await tauriFetch(GITHUB_UPDATER_ENDPOINT, {
      method: "GET",
      maxRedirections: 5,
    } as RequestInit);
    if (preflight.status === 404) {
      log.debug("Updater manifest missing (latest.json=404), treating as up-to-date");
      return { available: false, version: null, body: null };
    }
  } catch (probeErr) {
    // Do not fail here; the Rust updater check below is the source of truth.
    log.debug("Updater manifest preflight failed, falling back to command", {
      error: String(probeErr),
    });
  }

  try {
    const result = await invoke<UpdateCheckResult>("check_client_update");
    if (result.available) {
      log.info("Update available", { version: result.version });
    } else {
      log.debug("No update available");
    }
    return result;
  } catch (err) {
    const error = String(err);
    log.error("Update check failed", { error });
    return { available: false, version: null, body: null, error };
  }
}

/** Download and install a pending update, then relaunch the app. */
export async function downloadAndInstallUpdate(): Promise<void> {
  log.info("Downloading and installing update...");
  await invoke("download_and_install_update");
  log.info("Update installed, relaunching...");
  await relaunch();
}

export type UpdaterStatusListener = (event: UpdaterStatusEvent) => void;

/** Listen to updater status events emitted by the Rust updater commands. */
export async function listenUpdaterStatus(
  listener: UpdaterStatusListener,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen("updater-status", (event) => {
      const payload = event.payload as Partial<UpdaterStatusEvent>;
      listener({
        stage: payload.stage ?? DEFAULT_STATUS_EVENT.stage,
        message: payload.message ?? DEFAULT_STATUS_EVENT.message,
        version: payload.version ?? DEFAULT_STATUS_EVENT.version,
        downloaded: payload.downloaded ?? DEFAULT_STATUS_EVENT.downloaded,
        total: payload.total ?? DEFAULT_STATUS_EVENT.total,
      });
    });
  } catch (err) {
    log.debug("Updater status events unavailable", { error: String(err) });
    return () => {};
  }
}
