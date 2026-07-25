/**
 * Two-token control border: theme-owned width + ink colour. Layered
 * onto any Button variant without touching fill, text, or hover fill —
 * the underlying variant keeps its action hierarchy.
 */
export const CONTROL_INK_BORDER =
  'border-[length:var(--control-border-width)] border-border-focus';

/**
 * 1px hover lift motion + the transition tuple it needs. Colour
 * neutralization on hover is a per-variant concern that stays at the
 * consumer edge — this constant does not touch fill or text.
 */
export const CONTROL_HOVER_LIFT =
  'transition-[color,background-color,border-color,transform] hover:-translate-y-px';

/**
 * The neutral framed SURFACE of the poster-control family: token frame, the
 * canonical control-hover pair (`--border-control-hover` + `--bg-option-hover`,
 * never `--bg-row-hover` — forza6 paints that magenta), and the 1px lift.
 *
 * One recipe on purpose: the page-footer neutral action and the Cancel peer of a
 * destructive commit must be the same surface, or a dialog answers its trigger
 * in a different visual language (shiki 2026-07-26: "cancel 的样式也需要跟上").
 * Consumers add layout (`w-full`, `gap-2`) and, when it is a Cancel, the
 * `destructiveCancel()` hook that lets a theme finish the sticker.
 */
export const CONTROL_SURFACE_BUTTON = `${CONTROL_INK_BORDER} ${CONTROL_HOVER_LIFT} hover:border-[color:var(--border-control-hover)] hover:bg-[var(--bg-option-hover)]`;
