import type { AppearanceSettings } from './types';

/** CSS custom property names consumed by `.markdown-body` and its
 *  descendant `code` / `pre`. Each theme defines defaults under its
 *  `[data-theme=…]` block; user overrides land as inline style on the
 *  document root. Removing the inline value falls back to theme. */
export const MD_TOKENS = {
  PROSE_FONT: '--md-prose-font',
  PROSE_SIZE: '--md-prose-size',
  CODE_FONT: '--md-code-font',
  CODE_SIZE: '--md-code-size',
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
  // Shared font size — applied identically to both prose and code so
  // body text and inline / fenced code line up. `undefined` falls back
  // to the per-theme default in CSS.
  const sharedSize = sizePx(appearance.fontSize);

  setOrRemove(target, MD_TOKENS.PROSE_FONT, proseFont);
  setOrRemove(target, MD_TOKENS.PROSE_SIZE, sharedSize);
  setOrRemove(target, MD_TOKENS.CODE_FONT, codeFont);
  setOrRemove(target, MD_TOKENS.CODE_SIZE, sharedSize);
}

function setOrRemove(
  target: AppearanceStyleTarget,
  prop: string,
  value: string | undefined,
): void {
  if (value === undefined) target.removeProperty(prop);
  else target.setProperty(prop, value);
}

function sizePx(n: number | undefined): string | undefined {
  return typeof n === 'number' ? `${n}px` : undefined;
}
