/**
 * The app's ONE primary-CTA affordance — the single solid-filled button that
 * commits a dialog or a settings form (Create agent / Create workspace / Create
 * channel / New computer's Finish, every `Save` and `Save xxx`, Switch runtime,
 * the connect / retry gates).
 *
 * shiki 2026-07-26 (#task:1623, right after the avocado-green CTA landed): "注意
 * 如果你修改的时候,遇到这类 button 在 forza6 下没有 post sticker 以及 hover 效果的
 * 一起加上." The green fill alone is not the affordance — in forza6 a flat filled
 * rectangle next to ink-framed poster stickers reads as an unfinished control. So
 * every primary CTA now reaches the poster treatment (2px ink frame, 0 radius,
 * hard ink drop shadow that grows into a peel on hover) through ONE hook instead
 * of per-dialog re-derivation. Before this there were two divergent one-offs —
 * `[data-channel-settings-save]` and `[data-host-action='commit']` — and every
 * other CTA in the app had nothing.
 *
 * **Division of labour** (the same split as `destructiveAction()`): the consumer
 * contributes MOTION and layout, the theme paints IDENTITY on
 * `[data-primary-action]` (see `forza6-components.css`). That is why the hue is
 * NOT here: the fill comes from the Button `default` variant's
 * `--bg-control-primary` cluster, so a theme changes the CTA colour by retuning
 * three tokens and this recipe never mentions green.
 *
 * No frame is added at the consumer edge on purpose. `CONTROL_INK_BORDER`
 * resolves to `--border-focus`, which is ink only in forza6 (slack-dark maps it
 * to brand blue, warm-script to a 25%-alpha brown) — a frame that disagrees with
 * its own fill is the mistake to avoid. The CTA stays PRIMARY BY FILL everywhere;
 * forza6 adds the ink frame itself, where ink agrees with the ink drop shadow.
 *
 * The family has two members, keyed like the destructive one:
 * `data-primary-action="commit"` is the filled CTA, `"cancel"` is its neutral
 * framed peer (`primaryCancel()` below).
 */
import { CONTROL_SURFACE_BUTTON } from './ControlInkBorder';

/**
 * Hover motion, animated. `translate` (not `transform`) is the property Tailwind
 * v4's `-translate-y-px` writes, and it must be named in the transition or the
 * lift snaps; `box-shadow` is named here rather than in the theme rule so the
 * poster peel and the lift share one timing declaration.
 */
const PRIMARY_ACTION_CLASS =
  'transition-[color,background-color,border-color,box-shadow,translate] hover:-translate-y-px';

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
  'data-primary-action': 'commit';
  className: string;
} {
  return {
    'data-primary-action': 'commit',
    className: className
      ? `${PRIMARY_ACTION_CLASS} ${className}`
      : PRIMARY_ACTION_CLASS,
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
  'data-primary-action': 'cancel';
  className: string;
} {
  return {
    'data-primary-action': 'cancel',
    className: className
      ? `${CONTROL_SURFACE_BUTTON} ${className}`
      : CONTROL_SURFACE_BUTTON,
  };
}
