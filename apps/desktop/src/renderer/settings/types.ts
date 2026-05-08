export const THEME_IDS = [
  'warm-coral',
  'paper-ink',
  'warm-script',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface AppearanceSettings {
  theme: ThemeId;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'paper-ink',
};

export interface LayoutSettings {
  workspaceSidebarVisible: boolean;
  channelSidebarVisible: boolean;
}

export const DEFAULT_LAYOUT: LayoutSettings = {
  workspaceSidebarVisible: true,
  channelSidebarVisible: true,
};

export interface AppSettings {
  appearance: AppearanceSettings;
  layout: LayoutSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appearance: DEFAULT_APPEARANCE,
  layout: DEFAULT_LAYOUT,
};
