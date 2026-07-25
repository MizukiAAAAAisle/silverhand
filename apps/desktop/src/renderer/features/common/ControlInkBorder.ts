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

/**
 * Spread onto a NEUTRAL action — the third rank of the poster-action family,
 * beside `primaryAction()` (filled commit) and `destructiveAction()` (red).
 * `<Button variant="outline" {...neutralAction()}>Archive</Button>`.
 *
 * shiki 2026-07-26: "Workspace Settings 中的 Archive 按钮也需要看下 这个好像没改."
 * Archive is neither the dialog's primary (that's `Save`) nor destructive (that's
 * `Delete workspace`) — it is a reversible state change, so it must NOT take a
 * fill. What it was missing is the family's SHAPE: sitting between a green
 * sticker and a red one, a plain `outline` button was the only element in the
 * dialog with no frame token, no lift, and in forza6 no drop shadow.
 *
 * Same division of labour as the other two: this ships the neutral framed
 * surface + motion, the theme paints the sticker on `[data-neutral-action]` (in
 * forza6, the ink shadow shared verbatim with the Cancel ranks). Layout stays
 * with the consumer.
 *
 * One older hook names the SAME rank for its own surface —
 * `[data-host-action='neutral']` (Computer page). It resolves pixel-identically;
 * this is the one to consume for anything new, and that alias is the last one to
 * fold in when the Computer page is next touched. The channel-settings modal's
 * `[data-channel-settings-action]` was the other one and is already folded in
 * (its Visibility / Archive / Leave rows call this function).
 */
export function neutralAction(className?: string): {
  'data-neutral-action': 'true';
  className: string;
} {
  return {
    'data-neutral-action': 'true',
    className: className
      ? `${CONTROL_SURFACE_BUTTON} ${className}`
      : CONTROL_SURFACE_BUTTON,
  };
}
