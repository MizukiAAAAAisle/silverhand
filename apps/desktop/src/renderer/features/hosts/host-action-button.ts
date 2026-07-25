import { CONTROL_SURFACE_BUTTON } from '@/features/common/ControlInkBorder';
import { DESTRUCTIVE_TRIGGER } from '@/features/common/DestructiveAction';

/**
 * #task:1619 — the Computer page's footer action stack: `Copy diagnostics`
 * plus the one terminal verb the computer's provisioning source allows
 * (`Delete` for user-managed, `Revoke` for app-managed — never both).
 *
 * shiki 2026-07-26: both buttons run the full panel width and the divider that
 * used to sit between them is gone, so they read as ONE group of page-level
 * actions rather than two unrelated sections. Full width is also what lets the
 * group carry a poster identity in forza6 — a self-start pill can't be a
 * sticker.
 *
 * Geometry is token-only (`--control-border-width` here, `--control-radius`
 * via the Button primitive), never a framework default. That is the whole
 * reason forza6 can render these as poster stickers (2px ink frame, 0 radius,
 * hard ink drop shadow painted on the `data-host-action` hook in
 * `forza6-components.css`) while warm-script / slack-dark keep their 1px +
 * 6px-radius controls from the same markup.
 *
 * Hover consumes the canonical control-hover pair — `--border-control-hover` +
 * `--bg-option-hover` — instead of the previous fixed `bg-bg-floating`, which
 * was white-on-white paper in forza6 (i.e. no hover at all). In forza6 that
 * pair resolves to pale-lime ground + ink frame, so hover previews the sticker;
 * warm/slack keep their own hover language. Do NOT reach for `--bg-row-hover`
 * here: it is the list-row token and forza6 paints it magenta.
 *
 * `data-host-action` is a theme-neutral hook: it names the DOM role ("a
 * computer action button") and its value names the RANK — `neutral` (framed
 * surface) or `commit` (the brand-filled retry CTA inside a confirm modal) —
 * never a colour or a theme. It stays identity-only — width and spacing live in
 * these class strings and in the group container, never in the theme rule.
 *
 * shiki 2026-07-26 extended the family into the confirm modals ("Delete
 * Computer Modal 的 action button 也加上一样的效果"), so the same hook covers the
 * page footer and both computer dialogs' footers: pressing a poster sticker
 * must not open a dialog whose buttons are flat. The DESTRUCTIVE commits are the
 * one thing this hook does not paint — they consume the app-wide
 * `destructiveAction()` recipe instead, so the red sticker is defined once for
 * every delete confirm rather than per feature.
 */

/** Neutral page-level action (Copy diagnostics). */
export const HOST_ACTION_BUTTON = `w-full ${CONTROL_SURFACE_BUTTON}`;

/**
 * Cancel / Dismiss inside a computer confirm modal (`data-host-action="neutral"`)
 * — the peer of the brand-filled retry. The peer of a DESTRUCTIVE commit uses
 * `destructiveCancel()` instead, so the red-sticker pair is defined once for the
 * whole app.
 *
 * The retry it stands beside has no recipe here: it is an ordinary primary CTA
 * and consumes the app-wide `primaryAction()` hook (#task:1623), the same one the
 * Create / Save family uses. The earlier `HOST_MODAL_BUTTON_COMMIT` +
 * `[data-host-action='commit']` pair was a second copy of "primary by fill + ink
 * frame" and drifted from the first; there is one now.
 */
export const HOST_MODAL_BUTTON = CONTROL_SURFACE_BUTTON;

/**
 * Terminal action (Delete) at the page footer. Same geometry, error hue — and
 * the hue is carried at FULL strength (shiki 2026-07-26). The first cut used
 * `border-error/40` + `hover:bg-error/10`: an alpha-thinned frame on white paper
 * reads as a washed, semi-transparent red rather than a deliberate warning
 * colour, which is worse than either a solid red or no red at all. Alpha belongs
 * to soft tints (`--error-soft`, a per-theme token), never to the structural
 * frame.
 *
 * This is the SHAPE shiki made canonical for every destructive commit in forza6
 * ("让他们都按照底部那个 Delete Computer 一样"), so the trigger no longer owns
 * it: pair this with `destructiveAction()`, which carries the hook the theme
 * paints (white paper, red frame, red hard shadow, and a hover that grows that
 * shadow into a peel) plus the lift. Motion and the hook live there; only
 * width and the cross-theme hue live here.
 *
 * Revoke wears it too (shiki 2026-07-26: "Revoke Computer 按钮也改成这个样式").
 * The earlier cut ranked the two verbs by chrome — ink frame + red label for the
 * reversible one — but they are MUTUALLY EXCLUSIVE (`computerActions` gives a
 * computer one terminal verb, never both), so the quieter frame was ranking
 * against a button the user cannot see. What separates them is the verb and the
 * confirm copy; the footer slot itself always means "this is the terminal action
 * for this computer".
 *
 * The hue itself now lives in `DESTRUCTIVE_TRIGGER` beside the hook it pairs
 * with — Settings' `Log out` and the channel-settings `Leave` confirm wear the
 * same red-on-paper recipe, and this constant is just that recipe at page width.
 */
export const HOST_ACTION_BUTTON_DANGER = `w-full ${DESTRUCTIVE_TRIGGER}`;
