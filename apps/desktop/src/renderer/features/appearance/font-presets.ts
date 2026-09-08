/** Quick-fill suggestions for the SettingsPage font inputs. Clicking
 *  one fills the input verbatim — these are not validated against the
 *  user's installed fonts, the browser falls back gracefully. */

export interface FontPreset {
  /** Display label in the chip. */
  label: string;
  /** Value pasted into the font-family input. Empty string = "use
   *  theme default" (clears the override). */
  value: string;
}

export const PROSE_FONT_PRESETS: ReadonlyArray<FontPreset> = [
  { label: "Theme default", value: "" },
  { label: "System", value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "LXGW WenKai", value: '"LXGW WenKai", "LXGW WenKai Screen", serif' },
  { label: "Songti SC", value: '"Songti SC", SimSun, serif' },
];

export const CODE_FONT_PRESETS: ReadonlyArray<FontPreset> = [
  { label: "Theme default", value: "" },
  { label: "Menlo", value: "Menlo, Consolas, monospace" },
  { label: "SF Mono", value: '"SF Mono", "SFMono-Regular", Menlo, monospace' },
  { label: "JetBrains Mono", value: '"JetBrains Mono", Menlo, monospace' },
  { label: "Fira Code", value: '"Fira Code", Menlo, monospace' },
];
