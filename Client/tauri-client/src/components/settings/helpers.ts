/**
 * Shared helpers and constants for settings tabs.
 */

import { createElement } from "@lib/dom";
import { applyThemeByName } from "@lib/themes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STORAGE_PREFIX = "rylo:settings:";

export const THEMES = {
  dark: { "--bg-primary": "#313338", "--bg-secondary": "#2b2d31", "--bg-tertiary": "#1e1f22", "--text-normal": "#dbdee1" },
  "neon-glow": { "--bg-primary": "#1a1b1e", "--bg-secondary": "#111214", "--bg-tertiary": "#0d0e10", "--text-normal": "#dbdee1" },
  midnight: { "--bg-primary": "#1a1a2e", "--bg-secondary": "#16213e", "--bg-tertiary": "#0f3460", "--text-normal": "#e0e0e0" },
  light: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f6f8fc",
    "--bg-tertiary": "#edf2f8",
    "--bg-input": "#ffffff",
    "--bg-hover": "#e8eef8",
    "--bg-active": "#dce6ff",
    "--bg-overlay": "rgba(15, 23, 42, 0.26)",
    "--bg-modifier-hover": "rgba(37, 99, 235, 0.08)",
    "--bg-modifier-active": "rgba(37, 99, 235, 0.14)",
    "--bg-modifier-selected": "rgba(37, 99, 235, 0.18)",
    "--text-normal": "#1f2937",
    "--text-muted": "#667085",
    "--text-faint": "#7b8798",
    "--text-micro": "#98a2b3",
    "--text-link": "#2563eb",
    "--header-primary": "#111827",
    "--header-secondary": "#667085",
    "--interactive-normal": "#667085",
    "--interactive-hover": "#1f2937",
    "--interactive-active": "#111827",
    "--interactive-muted": "#98a2b3",
    "--channel-icon": "#667085",
    "--border": "#d8e0eb",
    "--border-strong": "#c1cada",
    "--scrollbar-thin-thumb": "#c5cfdd",
    "--scrollbar-auto-thumb": "#c5cfdd",
    "--scrollbar-auto-track": "transparent",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

// ---------------------------------------------------------------------------
// Preference helpers
// ---------------------------------------------------------------------------

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Basic typeof guard against corrupted localStorage (covers boolean,
    // number, string fallbacks used by current call sites).
    if (typeof parsed !== typeof fallback) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  // Dispatch a custom event so same-window listeners can invalidate caches.
  // The native `storage` event only fires for cross-tab changes.
  window.dispatchEvent(new CustomEvent("rylo:pref-change", { detail: { key } }));
}

// ---------------------------------------------------------------------------
// Accessible toggle creation
// ---------------------------------------------------------------------------

/**
 * Create an accessible toggle switch element with proper ARIA attributes
 * and keyboard support (Enter/Space to toggle).
 */
export function createToggle(
  isOn: boolean,
  opts: { signal: AbortSignal; onChange: (nowOn: boolean) => void },
): HTMLDivElement {
  const toggle = createElement("div", {
    class: isOn ? "toggle on" : "toggle",
    role: "switch",
    tabindex: "0",
    "aria-checked": isOn ? "true" : "false",
  });

  function doToggle(): void {
    const nowOn = !toggle.classList.contains("on");
    toggle.classList.toggle("on", nowOn);
    toggle.setAttribute("aria-checked", String(nowOn));
    opts.onChange(nowOn);
  }

  toggle.addEventListener("click", doToggle, { signal: opts.signal });
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      doToggle();
    }
  }, { signal: opts.signal });

  return toggle;
}

// ---------------------------------------------------------------------------
// Theme application
// ---------------------------------------------------------------------------

export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;

  // Clear any inline properties set by previous themes to prevent bleeding
  // (e.g. going from Light to Dark, where Light defines more variables).
  const allThemeVars = new Set<string>();
  for (const t of Object.values(THEMES)) {
    for (const key of Object.keys(t)) {
      allThemeVars.add(key);
    }
  }
  for (const key of allThemeVars) {
    root.style.removeProperty(key);
  }

  // Apply CSS variables for the new theme
  const theme = THEMES[name];
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(key, value);
  }
  // Delegate body class and persistence to the theme manager
  applyThemeByName(name);
}
