/**
 * Two-token control border: theme-owned width + ink colour. Layered
 * onto a Button variant without touching fill, text, or hover fill —
 * the variant keeps its action hierarchy.
 */
export const CONTROL_INK_BORDER =
  "border-[length:var(--control-border-width)] border-border-control";

/**
 * The transition tuple the control family's hover states need. Named so a
 * lifting hover animates `translate` + `box-shadow` together rather than
 * fighting a `transition-colors` from elsewhere.
 */
const CONTROL_HOVER_TRANSITION =
  "transition-[color,background-color,border-color,box-shadow,translate] duration-150 ease-[var(--ease,ease)]";

/**
 * 1px hover lift motion + the transition tuple it needs. Colour is a
 * per-consumer concern — this constant does not touch fill or text.
 */
export const CONTROL_HOVER_LIFT = `${CONTROL_HOVER_TRANSITION} hover:-translate-y-px`;

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
 * popover — because they are the same control with the same placeholder.
 * Consumers add layout and their own disabled treatment.
 */
export const SEARCH_FIELD_FRAME =
  "flex items-center gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2.5 py-1.5 transition-colors hover:border-[color:var(--border-control-hover)] focus-within:border-border-focus";
