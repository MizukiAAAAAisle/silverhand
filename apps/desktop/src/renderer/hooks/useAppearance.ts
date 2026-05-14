import { useEffect, useState } from 'react';
import { applyAppearanceOverrides } from '@/settings/apply';
import { parseAppearanceJson } from '@/settings/parse';
import {
  DEFAULT_APPEARANCE,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type AppearanceSettings,
  type MarkdownTextSettings,
  type ThemeId,
} from '@/settings/types';

const STORAGE_KEY = 'silverhand:appearance';

function read(): AppearanceSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_APPEARANCE;
  return parseAppearanceJson(localStorage.getItem(STORAGE_KEY));
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset['theme'] = theme;
}

/** Strip empty / undefined slots so persisted JSON stays minimal and
 *  `prose: undefined` doesn't round-trip into `prose: {}`. */
function pruneOverrides(appearance: AppearanceSettings): AppearanceSettings {
  const next: AppearanceSettings = { theme: appearance.theme };
  if (hasOverride(appearance.prose)) next.prose = appearance.prose;
  if (hasOverride(appearance.code)) next.code = appearance.code;
  return next;
}

function hasOverride(slot: MarkdownTextSettings | undefined): slot is MarkdownTextSettings {
  if (!slot) return false;
  return Boolean(slot.fontFamily) || typeof slot.fontSize === 'number';
}

/** Clamp + round a font-size before persisting so renderer state and
 *  storage stay within the documented range without depending on the
 *  parser to fix it on the next read. */
function clampSize(n: number | undefined): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

export interface UseAppearance {
  appearance: AppearanceSettings;
  setTheme: (theme: ThemeId) => void;
  /** Set or clear a single field on `prose` or `code`. Pass
   *  `undefined` to clear that field; the slot is pruned when both
   *  fields go empty. */
  setMarkdownText: (
    slot: 'prose' | 'code',
    field: 'fontFamily' | 'fontSize',
    value: string | number | undefined,
  ) => void;
  /** Wipe one slot or both slots — falls back to theme defaults. */
  resetMarkdownText: (slot?: 'prose' | 'code') => void;
}

export function useAppearance(): UseAppearance {
  const [appearance, setAppearance] = useState<AppearanceSettings>(read);

  useEffect(() => {
    applyTheme(appearance.theme);
    applyAppearanceOverrides(document.documentElement.style, appearance);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneOverrides(appearance)));
    }
  }, [appearance]);

  return {
    appearance,
    setTheme: theme => setAppearance(prev => ({ ...prev, theme })),
    setMarkdownText: (slot, field, value) =>
      setAppearance(prev => {
        const current = prev[slot] ?? {};
        const nextSlot: MarkdownTextSettings = { ...current };
        if (field === 'fontFamily') {
          const trimmed = typeof value === 'string' ? value.trim() : '';
          if (trimmed) nextSlot.fontFamily = trimmed;
          else delete nextSlot.fontFamily;
        } else {
          const clamped = clampSize(typeof value === 'number' ? value : undefined);
          if (typeof clamped === 'number') nextSlot.fontSize = clamped;
          else delete nextSlot.fontSize;
        }
        const next: AppearanceSettings = { ...prev };
        if (hasOverride(nextSlot)) next[slot] = nextSlot;
        else delete next[slot];
        return next;
      }),
    resetMarkdownText: slot =>
      setAppearance(prev => {
        if (slot) {
          const next: AppearanceSettings = { ...prev };
          delete next[slot];
          return next;
        }
        const next: AppearanceSettings = { theme: prev.theme };
        return next;
      }),
  };
}
