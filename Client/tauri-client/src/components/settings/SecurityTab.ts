import { createElement } from "@lib/dom";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import {
  buildDeleteAccountSection,
  buildPasswordSection,
  buildTotpSection,
} from "./AccountTab";

/** Security settings tab — password, 2FA and danger zone. */
export function buildSecurityTab(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const section = createElement("div", { class: "settings-section" });
  section.appendChild(buildPasswordSection(options, signal));
  section.appendChild(buildTotpSection(options, signal));
  section.appendChild(buildDeleteAccountSection(options, signal));
  return section;
}

