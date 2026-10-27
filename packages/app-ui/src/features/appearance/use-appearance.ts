import { useEffect, useSyncExternalStore } from "react";
import { applyAppearanceOverrides } from "@/features/appearance/apply";
import { parseAppearanceJson } from "@/features/appearance/parse";
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_IDS,
  type AppearanceSettings,
  type MarkdownTextSettings,
  type ThemeId,
} from "@/features/appearance/types";

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
  /** Absent on platforms that retain the localStorage-only contract. */
  themeStatus: ThemeStatus | undefined;
  setTheme: (theme: ThemeId) => void | Promise<void>;
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

// One store for every caller: the shell reads the theme for native chrome
// while Settings writes it, so a per-hook state would leave the shell stale.
let current: AppearanceSettings | undefined;
const listeners = new Set<() => void>();

export interface ThemePersistence {
  getTheme(): Promise<unknown>;
  saveTheme(theme: ThemeId): Promise<void>;
}
interface ThemeStatus {
  confirmed: boolean;
  pending?: boolean;
  error?: string;
}
let themePersistence: ThemePersistence | undefined;
let themeStatus: ThemeStatus | undefined;
let themeWrites = Promise.resolve();
let queuedThemeWrites = 0;
const themeSnapshot = () => themeStatus;
const notify = () => { for (const listener of listeners) listener(); };

function publishThemeStatus(status: ThemeStatus): void {
  themeStatus = status;
  // Only native initialization/save outcomes establish confirmation. A theme
  // matching the old mirror or the visible dataset is insufficient.
  document.documentElement.dataset["themePersistence"] = status.pending
    ? "pending" : status.confirmed ? "confirmed" : "unconfirmed";
  notify();
}

/** Android installs this before mount. A mirror/default is only a display
 * fallback: no startup write can mistake a failed read for a missing record. */
export async function initializeThemePersistence(persistence: ThemePersistence): Promise<void> {
  themePersistence = persistence;
  publishThemeStatus({ confirmed: false, pending: true });
  let fallback: AppearanceSettings;
  try { fallback = read(); }
  catch { fallback = DEFAULT_APPEARANCE; }
  try {
    const theme = await persistence.getTheme();
    if (!THEME_IDS.includes(theme as ThemeId)) throw new Error("No confirmed native theme");
    current = { ...fallback, theme: theme as ThemeId };
    publishThemeStatus({ confirmed: true });
  } catch (error) {
    current = fallback;
    publishThemeStatus({ confirmed: false, error: String(error) });
    console.warn("Theme persistence not confirmed", error);
  }
  applyTheme(current.theme);
  applyAppearanceOverrides(document.documentElement.style, current);
  notify();
}

function snapshot(): AppearanceSettings {
  current ??= read();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setAppearance(
  update: (prev: AppearanceSettings) => AppearanceSettings,
  nativeThemeConfirmed = false,
): void {
  const next = update(snapshot());
  current = next;
  applyTheme(next.theme);
  applyAppearanceOverrides(document.documentElement.style, next);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneOverrides(next)));
    }
  } catch (error) {
    if (!nativeThemeConfirmed) throw error;
    // A failed compatibility mirror cannot undo an acknowledged native save.
    console.warn("Unable to mirror the confirmed theme", error);
  }
  notify();
}

function setTheme(theme: ThemeId): void | Promise<void> {
  const persistence = themePersistence;
  if (!persistence) return setAppearance((prev) => ({ ...prev, theme }));
  // Do not skip an equal id: a fallback display has not been saved yet.
  queuedThemeWrites++;
  publishThemeStatus({ confirmed: false, pending: true });
  const write = themeWrites.then(async () => {
    let confirmed = false;
    let failure: string | undefined;
    try {
      await persistence.saveTheme(theme);
      // Read the latest snapshot after the ack, preserving intervening font edits.
      setAppearance((prev) => ({ ...prev, theme }), true);
      confirmed = true;
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      queuedThemeWrites--;
      publishThemeStatus(queuedThemeWrites > 0
        ? { confirmed: false, pending: true, error: failure }
        : { confirmed, ...(failure ? { error: failure } : {}) });
    }
  });
  themeWrites = write.catch(() => {});
  return write;
}

export function useAppearance(): UseAppearance {
  const appearance = useSyncExternalStore(subscribe, snapshot, snapshot);
  const status = useSyncExternalStore(subscribe, themeSnapshot, themeSnapshot);

  useEffect(() => {
    const stored = snapshot();
    applyTheme(stored.theme);
    applyAppearanceOverrides(document.documentElement.style, stored);
  }, []);

  return {
    appearance,
    themeStatus: status,
    setTheme,
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
