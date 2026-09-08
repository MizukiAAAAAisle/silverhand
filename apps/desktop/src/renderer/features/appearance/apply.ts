import type { AppearanceSettings } from "./types";

/** CSS custom property names that hold user Appearance overrides.
 *
 *  Tokens here are write-only by Appearance and read with a theme
 *  primitive as the fallback. Themes define their canonical values
 *  on `--font-sans` / `--font-mono` (fonts) and `--md-prose-size` /
 *  `--md-code-size` (sizes); consumer rules read e.g.
 *  `var(--appearance-code-font, var(--font-mono))` so the override
 *  token's role (override slot) is never confused with the theme
 *  primitive's role (canonical default). Removing the inline value
 *  from the document root falls back to the theme primitive.
 *
 *  Size is intentionally a single shared slot because the Settings UI
 *  exposes one slider for both prose and code (the per-side `--md-*-size`
 *  tokens still let each theme set divergent defaults, but the user
 *  override applies to both at once). */
export const APPEARANCE_TOKENS = {
  PROSE_FONT: "--appearance-prose-font",
  CODE_FONT: "--appearance-code-font",
  MARKDOWN_FONT_SIZE: "--appearance-markdown-font-size",
} as const;

/** Minimum surface needed to apply / clear CSS custom properties.
 *  Both `HTMLElement.style` and a plain test stub satisfy this. */
export interface AppearanceStyleTarget {
  setProperty(property: string, value: string | null, priority?: string): void;
  removeProperty(property: string): string;
}

/** Apply (or clear) prose / code overrides on the given style target,
 *  typically `document.documentElement.style`. Pure: same input →
 *  same calls. Always emits a full set/clear pair for every token so
 *  the result does not depend on prior state. */
export function applyAppearanceOverrides(
  target: AppearanceStyleTarget,
  appearance: AppearanceSettings,
): void {
  const proseFont = appearance.prose?.fontFamily;
  const codeFont = appearance.code?.fontFamily;
  // Shared font size — applied to a single token so body text and inline
  // / fenced code line up. `undefined` falls back to the per-theme
  // default in CSS (`--md-prose-size` / `--md-code-size`).
  const sharedSize = sizePx(appearance.fontSize);

  setOrRemove(target, APPEARANCE_TOKENS.PROSE_FONT, proseFont);
  setOrRemove(target, APPEARANCE_TOKENS.CODE_FONT, codeFont);
  setOrRemove(target, APPEARANCE_TOKENS.MARKDOWN_FONT_SIZE, sharedSize);
}

function setOrRemove(target: AppearanceStyleTarget, prop: string, value: string | undefined): void {
  if (value === undefined) target.removeProperty(prop);
  else target.setProperty(prop, value);
}

function sizePx(n: number | undefined): string | undefined {
  return typeof n === "number" ? `${n}px` : undefined;
}
