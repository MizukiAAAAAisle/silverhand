import { cn } from '@/lib/cn';

/**
 * Frame identity for a HAND-ROLLED floating list panel — the suggestion
 * dropdown a combobox opens under its input, NOT a Radix `Select` (whose
 * `Select.Content` mounts `role="listbox"` as a direct popper child and is
 * adapted by the theme automatically). Every hand-rolled panel used to spell
 * this className + hook out by hand, and adapting one to a new theme meant
 * remembering to touch the others — the exact drift this centralises.
 *
 * `variant` is the poster/soft decision, not a look this file owns:
 *  - `poster` wires forza6's `data-field-dropdown` hook, which swaps the soft
 *    shadow + 1px border for the theme's ink 2px frame + hard poster shadow
 *    (border-width and radius still come from the element's own tokens). Other
 *    themes have no rule for the hook, so they keep the soft frame below. This
 *    is what the member / model pickers wear.
 *  - `soft` omits the hook, so the panel stays soft in EVERY theme — for a
 *    floating list that is deliberately quiet (shiki's "input effect, not the
 *    list" call: the sticker belongs on the search field, not on its results).
 *
 * Only the visual identity lives here (radius / border / fill / shadow).
 * Position, z-index, max-height, padding and overflow stay with the consumer
 * via `layoutClassName` — they are layout, and a shared hook that also owned
 * layout would mis-fit the next consumer.
 */
export type DropdownPanelVariant = 'poster' | 'soft';

const DROPDOWN_PANEL_FRAME =
  'rounded-[var(--select-content-radius)] border border-border bg-bg-floating shadow-popover';

export function dropdownPanelProps(
  variant: DropdownPanelVariant,
  layoutClassName: string,
): { className: string; 'data-field-dropdown'?: '' } {
  const className = cn(DROPDOWN_PANEL_FRAME, layoutClassName);
  return variant === 'poster'
    ? { className, 'data-field-dropdown': '' }
    : { className };
}
