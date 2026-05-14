export const THEME_IDS = [
  'warm-coral',
  'paper-ink',
  'warm-script',
] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Override a theme's default markdown font / size. `undefined` means
 *  "inherit from theme". Empty / invalid values are dropped at parse
 *  time, never persisted. */
export interface MarkdownTextSettings {
  fontFamily?: string;
  fontSize?: number;
}

export interface AppearanceSettings {
  theme: ThemeId;
  /** Override for `.markdown-body` prose (paragraphs, headings, lists). */
  prose?: MarkdownTextSettings;
  /** Override for `.markdown-body` inline `code` and fenced `pre`. */
  code?: MarkdownTextSettings;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: 'warm-script',
};

/** Allowed font-size range for prose / code overrides. Out-of-range
 *  values are clamped at parse time. Keep in sync with the SettingsPage
 *  sliders. */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 22;
export const DEFAULT_MARKDOWN_FONT_SIZE = 12;

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
