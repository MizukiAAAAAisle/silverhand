import {
  CONTROL_HOVER_LIFT,
  CONTROL_SURFACE_BUTTON,
} from './ControlInkBorder';

/**
 * The app's ONE destructive-confirm affordance — the button that actually
 * performs a delete / revoke, AND the Cancel that stands beside it. They ship as
 * a PAIR: shiki 2026-07-26, after the commits were unified, "记得再去看下有没有
 * 对应的 cancel,cancel 的样式也需要跟上,比如 Delete agent 的 cancel 样式就没有
 * 匹配" — a red poster sticker next to a bare ghost button reads as one styled
 * button and one unstyled one, not as a decision.
 *
 * shiki 2026-07-26 (earlier): "Delete 这类的红色弹窗,在 forza6 下主要统一一下
 * 设计:让他们都按照底部那个 Delete Computer 一样,即 background 白色,post
 * sticker 是红色的,hover 加上背景色变化,也许是一个 hook?后续可以直接使用." So
 * the red poster sticker — white paper, red frame, red label, hard RED drop
 * shadow, red-tint hover — is the canonical forza6 shape for every destructive
 * commit, and it is reached through one hook instead of being re-derived per
 * dialog.
 *
 * **Division of labour.** The consumer contributes motion, the neutral surface
 * for the Cancel, and the removal of the `danger` variant's opacity fade; the
 * stickers themselves are painted by the theme on
 * `[data-destructive-action='commit'|'cancel']` (see `forza6-components.css`).
 * That is deliberate: outside forza6 a destructive dialog CTA stays the solid
 * `danger` fill, because there a white/red outline would rank equal to its own
 * Cancel peer and the dialog would lose its single primary. forza6 can invert it
 * safely — the red frame + red shadow out-shout an ink-framed Cancel by hue.
 *
 * `hover:opacity-100` cancels `danger`'s `hover:opacity-90`: fading a saturated
 * fill reads as washed / semi-transparent (shiki rejected exactly that on the
 * Delete trigger). The 1px lift here is HALF of forza6's hover signal — the
 * theme grows the hard shadow against it so the sticker peels off the paper.
 * Two red hover GROUNDS were tried and rejected (pastel wash, then solid fill
 * that collapsed into its own frame and shadow); don't reintroduce one here.
 */
const DESTRUCTIVE_COMMIT_CLASS = `${CONTROL_HOVER_LIFT} hover:opacity-100`;

/**
 * Spread onto the destructive commit `Button` — `{...destructiveAction()}`, or
 * `{...destructiveAction('gap-2 w-full')}` to add layout classes.
 *
 * Returned as one props object on purpose: the hook and the class recipe are
 * two halves of one affordance, and a consumer that remembers only the hook
 * would keep the opacity fade while a consumer that remembers only the classes
 * would get no sticker. Layout (width, gap) stays with the consumer — the theme
 * rule paints identity only.
 */
export function destructiveAction(className?: string): {
  'data-destructive-action': 'commit';
  className: string;
} {
  return {
    'data-destructive-action': 'commit',
    className: className
      ? `${DESTRUCTIVE_COMMIT_CLASS} ${className}`
      : DESTRUCTIVE_COMMIT_CLASS,
  };
}

/**
 * Spread onto the Cancel / Dismiss that stands beside a `destructiveAction()`
 * commit — `<Button variant="outline" {...destructiveCancel()}>Cancel</Button>`.
 *
 * It is the neutral framed SURFACE, never a second red: the pair ranks by hue
 * (red commit vs ink cancel), so a Cancel that is merely quiet — `ghost`, no
 * frame — leaves the dialog looking half-designed. Use `variant="outline"` with
 * it; `ghost` has no paper of its own for the frame to sit on.
 */
export function destructiveCancel(className?: string): {
  'data-destructive-action': 'cancel';
  className: string;
} {
  return {
    'data-destructive-action': 'cancel',
    className: className
      ? `${CONTROL_SURFACE_BUTTON} ${className}`
      : CONTROL_SURFACE_BUTTON,
  };
}
