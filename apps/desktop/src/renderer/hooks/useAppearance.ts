import { useEffect, useState } from 'react';
import { DEFAULT_APPEARANCE, type AppearanceSettings, type ThemeId } from '@/settings/types';

const STORAGE_KEY = 'silverhand:appearance';

function read(): AppearanceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset['theme'] = theme;
}

export function useAppearance(): {
  appearance: AppearanceSettings;
  setTheme: (theme: ThemeId) => void;
} {
  const [appearance, setAppearance] = useState<AppearanceSettings>(read);

  useEffect(() => {
    applyTheme(appearance.theme);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  }, [appearance]);

  return {
    appearance,
    setTheme: (theme: ThemeId) => setAppearance(prev => ({ ...prev, theme })),
  };
}
