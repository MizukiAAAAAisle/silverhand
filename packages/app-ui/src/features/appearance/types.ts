export const THEME_IDS = ["glass", "studio-light", "poster", "iris", "slack-dark"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Theme ids that shipped under a previous name, mapped to the id that
 *  replaced them. A user who picked the old theme still has that id in
 *  `localStorage` (`silverhand:appearance`), so `parseAppearance` rewrites
 *  it here BEFORE the enum check — without this the unknown id falls
 *  through `ThemeIdSchema.catch()` and silently resets them to the
 *  default theme. `useAppearance` persists the parsed value back, so a
 *  stored legacy id migrates itself on the next mount.
 *
 *  Entries are append-only: a shipped id can be renamed, but the old
 *  name stays readable forever (old localStorage never expires).
 *
 *  - `warm-script` → `studio-light` (#task:1656): the third slot kept its
 *    role (the calm bright workbench) but replaced the warm/book style.
 *  - `forza6` → `poster` (#task:2735): rename only, same theme. */
export const LEGACY_THEME_IDS: Readonly<Record<string, ThemeId>> = {
  "warm-script": "studio-light",
  forza6: "poster",
};

/** Override a theme's default markdown font family. `undefined` means
 *  "inherit from theme". Empty / invalid values are dropped at parse
 *  time, never persisted. Font size is a single shared knob at the
 *  appearance level ({@link AppearanceSettings.fontSize}) — prose and
 *  code always share one size and only differ in font family. */
export interface MarkdownTextSettings {
  fontFamily?: string;
}

export interface AppearanceSettings {
  theme: ThemeId;
  /** Override for the shared markdown text size, applied to both prose
   *  and code. `undefined` means "inherit from theme". */
  fontSize?: number;
  /** Override for `.markdown-body` prose (paragraphs, headings, lists). */
  prose?: MarkdownTextSettings;
  /** Override for `.markdown-body` inline `code` and fenced `pre`. */
  code?: MarkdownTextSettings;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: "studio-light",
};

/** Allowed font-size range for the shared markdown override. Out-of-range
 *  values are clamped at parse time. Keep in sync with the SettingsPage
 *  slider. */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 22;
export const DEFAULT_MARKDOWN_FONT_SIZE = 14;
