/**
 * Primary and Cancel share action motion. Themes paint their identity through
 * the data hooks; consumers own layout. Primary fill remains separate from
 * the neutral frame so each theme preserves the action hierarchy.
 */
import { CONTROL_HOVER_LIFT, CONTROL_SURFACE_BUTTON } from "./ControlInkBorder";

/**
 * Hover motion, animated. `translate` (not `transform`) is the property Tailwind
 * v4's `-translate-y-px` writes, and it must be named in the transition or the
 * lift snaps; `box-shadow` is named here rather than in the theme rule so the
 * poster peel and the lift share one timing declaration.
 */
const PRIMARY_ACTION_CLASS = `focus-outline ${CONTROL_HOVER_LIFT} hover:bg-[var(--bg-primary-action-hover,var(--bg-control-primary-hover))]`;

/**
 * Spread onto the primary `Button` — `{...primaryAction()}`, or
 * `{...primaryAction('gap-2 w-full')}` to add layout classes.
 *
 * Returned as one props object for the same reason as `destructiveAction()`: the
 * hook and the motion are two halves of one affordance, and a consumer that
 * remembers only the hook gets a sticker that peels without lifting. Width, gap
 * and alignment stay with the consumer — the theme rule paints identity only, so
 * an xs toolbar Save and a full-width gate CTA can share it.
 */
export function primaryAction(className?: string): {
  "data-primary-action": "commit";
  className: string;
} {
  return {
    "data-primary-action": "commit",
    className: className ? `${PRIMARY_ACTION_CLASS} ${className}` : PRIMARY_ACTION_CLASS,
  };
}

/**
 * Spread onto the Cancel / Dismiss that stands beside a `primaryAction()` commit
 * — `<Button variant="outline" {...primaryCancel()}>Cancel</Button>`.
 *
 * shiki 2026-07-26: the ghost Cancel next to a green sticker was the last
 * half-designed footer ("第五点你说的对,一起改掉"). A commit that carries a frame,
 * a fill and a drop shadow next to a button with no paper at all reads as one
 * button plus one label, not as a decision with two answers — the same defect
 * already fixed for the destructive pair. So the primary pair ships together too:
 * the commit ranks by FILL, the Cancel is the same poster shape in ink with no
 * fill. Use `variant="outline"`; `ghost` has no paper of its own for the frame.
 *
 * The recipe is `CONTROL_SURFACE_BUTTON` — the app's one neutral framed surface,
 * shared verbatim with `destructiveCancel()`. A Cancel answers a green Create and
 * a red Delete with the SAME surface on purpose: what changes between those two
 * dialogs is which commit shouts, never how the way out looks.
 */
export function primaryCancel(className?: string): {
  "data-primary-action": "cancel";
  className: string;
} {
  return {
    "data-primary-action": "cancel",
    className: className ? `${CONTROL_SURFACE_BUTTON} ${className}` : CONTROL_SURFACE_BUTTON,
  };
}
