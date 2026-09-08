import { useEffect, useState } from "react";
import { applyAppearanceOverrides } from "@/settings/apply";
import { parseAppearanceJson } from "@/settings/parse";
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type AppearanceSettings,
  type MarkdownTextSettings,
  type ThemeId,
} from "@/settings/types";

const STORAGE_KEY = "silverhand:appearance";

function read(): AppearanceSettings {
  if (typeof localStorage === "undefined") return DEFAULT_APPEARANCE;
  return parseAppearanceJson(localStorage.getItem(STORAGE_KEY));
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset["theme"] = theme;
}

/** Strip empty / undefined slots so persisted JSON stays minimal and
 *  `prose: undefined` doesn't round-trip into `prose: {}`. */
function pruneOverrides(appearance: AppearanceSettings): AppearanceSettings {
  const next: AppearanceSettings = { theme: appearance.theme };
  if (typeof appearance.fontSize === "number") next.fontSize = appearance.fontSize;
  if (hasOverride(appearance.prose)) next.prose = appearance.prose;
  if (hasOverride(appearance.code)) next.code = appearance.code;
  return next;
}

function hasOverride(slot: MarkdownTextSettings | undefined): slot is MarkdownTextSettings {
  if (!slot) return false;
  return Boolean(slot.fontFamily);
}

/** Clamp + round a font-size before persisting so renderer state and
 *  storage stay within the documented range without depending on the
 *  parser to fix it on the next read. */
function clampSize(n: number | undefined): number | undefined {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

export interface UseAppearance {
  appearance: AppearanceSettings;
  setTheme: (theme: ThemeId) => void;
  /** Set or clear the font family for `prose` or `code`. Pass
   *  `undefined` to clear; the slot is pruned when its only field
   *  goes empty. */
  setMarkdownFont: (slot: "prose" | "code", value: string | undefined) => void;
  /** Set or clear the *shared* markdown font size. Pass `undefined`
   *  to fall back to the theme default. */
  setMarkdownFontSize: (value: number | undefined) => void;
  /** Wipe overrides — falls back to theme defaults. With no args,
   *  clears font size and both font families; with a slot, clears
   *  just that slot's font family. */
  resetMarkdownText: (slot?: "prose" | "code") => void;
  /** Reset just the shared font size to the theme default. */
  resetMarkdownFontSize: () => void;
}

export function useAppearance(): UseAppearance {
  const [appearance, setAppearance] = useState<AppearanceSettings>(read);

  useEffect(() => {
    applyTheme(appearance.theme);
    applyAppearanceOverrides(document.documentElement.style, appearance);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneOverrides(appearance)));
    }
  }, [appearance]);

  return {
    appearance,
    setTheme: (theme) => setAppearance((prev) => ({ ...prev, theme })),
    setMarkdownFont: (slot, value) =>
      setAppearance((prev) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        const nextSlot: MarkdownTextSettings = {};
        if (trimmed) nextSlot.fontFamily = trimmed;
        const next: AppearanceSettings = { ...prev };
        if (hasOverride(nextSlot)) next[slot] = nextSlot;
        else delete next[slot];
        return next;
      }),
    setMarkdownFontSize: (value) =>
      setAppearance((prev) => {
        const clamped = clampSize(value);
        const next: AppearanceSettings = { ...prev };
        if (typeof clamped === "number") next.fontSize = clamped;
        else delete next.fontSize;
        return next;
      }),
    resetMarkdownText: (slot) =>
      setAppearance((prev) => {
        if (slot) {
          const next: AppearanceSettings = { ...prev };
          delete next[slot];
          return next;
        }
        // Full wipe: drop both family slots and the shared size.
        return { theme: prev.theme };
      }),
    resetMarkdownFontSize: () =>
      setAppearance((prev) => {
        const next: AppearanceSettings = { ...prev };
        delete next.fontSize;
        return next;
      }),
  };
}
