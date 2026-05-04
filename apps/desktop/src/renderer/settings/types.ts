export const THEME_IDS = [
  'warm-coral',
  'paper-ink',
  'porcelain-verdigris',
  'warm-script',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface AppearanceSettings {
  theme: ThemeId;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'paper-ink',
};

export interface AppSettings {
  appearance: AppearanceSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
};
