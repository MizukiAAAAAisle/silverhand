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
