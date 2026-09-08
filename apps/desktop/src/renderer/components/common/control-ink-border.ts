/**
 * Two-token control border: theme-owned width + ink colour. Layered
 * onto any Button variant without touching fill, text, or hover fill —
 * the underlying variant keeps its action hierarchy.
 */
export const CONTROL_INK_BORDER = "border-[length:var(--control-border-width)] border-border-focus";

/**
 * The transition tuple the control family's hover states need, WITHOUT the
 * lift. Split out so a surface that must not move (an inline row confirm —
 * shiki 2026-07-28) drops the motion by not composing it, rather than by
 * fighting `hover:-translate-y-px` with a second translate utility whose
 * winner depends on Tailwind's emit order.
 */
export const CONTROL_HOVER_TRANSITION =
  "transition-[color,background-color,border-color,box-shadow,translate] duration-150 ease-[var(--ease,ease)]";

/**
 * 1px hover lift motion + the transition tuple it needs. Colour
 * neutralization on hover is a per-variant concern that stays at the
 * consumer edge — this constant does not touch fill or text.
 */
export const CONTROL_HOVER_LIFT = `${CONTROL_HOVER_TRANSITION} hover:-translate-y-px`;

/** The hover colour pair of the neutral surface, shared by its lifting and
 *  still variants. */
const CONTROL_SURFACE_HOVER =
  "hover:border-[color:var(--border-control-hover)] hover:bg-[var(--bg-neutral-action-hover,var(--bg-option-hover))]";

/**
 * The neutral framed SURFACE of the poster-control family: token frame, the
 * canonical control-hover pair (`--border-control-hover` + `--bg-option-hover`),
 * and the 1px lift.
 *
 * One recipe on purpose: the page-footer neutral action and the Cancel peer of a
 * destructive commit must be the same surface, or a dialog answers its trigger
 * in a different visual language (shiki 2026-07-26: "cancel 的样式也需要跟上").
 * Consumers add layout (`w-full`, `gap-2`) and, when it is a Cancel, the
 * `destructiveCancel()` hook that lets a theme finish the sticker.
 */
export const CONTROL_SURFACE_BUTTON = `focus-outline ${CONTROL_INK_BORDER} ${CONTROL_HOVER_LIFT} ${CONTROL_SURFACE_HOVER}`;

/** {@link CONTROL_SURFACE_BUTTON} without the lift — same frame, same hover
 *  colours, no motion. For a confirm that sits INSIDE a list row, where a
 *  button that rises pulls the eye off the row it belongs to. */
export const CONTROL_SURFACE_BUTTON_STILL = `focus-outline ${CONTROL_INK_BORDER} ${CONTROL_HOVER_TRANSITION} ${CONTROL_SURFACE_HOVER}`;

/**
 * The framed SEARCH FIELD of the member pickers: token geometry, an ink
 * hairline at rest, and the canonical ink pair for its two states —
 * `--border-control-hover` on hover, `--border-focus` when the input inside
 * takes focus. No fill change, no ring: the field already has a resting
 * border, so focus only changes its colour.
 *
 * Ink on purpose (shiki 2026-07-28: "channel add member popover 中的 search
 * input border 也用 ink"). A search field is utility chrome, so it may not
 * spend a saturated hue — that budget belongs to product semantics. The
 * `--border-focus` token is neutral ink in every theme; the brand-coloured
 * focus is reserved for the one main-stage input (the composer).
 *
 * Shared by both member pickers — the workspace combobox and the channel
 * popover — because they are the same control with the same placeholder, and
 * they had already drifted apart (one ink, one hardcoded 1px `border-subtle`
 * with no hover or focus feedback at all). Consumers add layout and their own
 * disabled treatment.
 */
export const SEARCH_FIELD_FRAME =
  "flex items-center gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2.5 py-1.5 transition-colors hover:border-[color:var(--border-control-hover)] focus-within:border-border-focus";

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
 */
export function neutralAction(className?: string): {
  "data-neutral-action": "true";
  className: string;
} {
  return {
    "data-neutral-action": "true",
    className: className ? `${CONTROL_SURFACE_BUTTON} ${className}` : CONTROL_SURFACE_BUTTON,
  };
}
