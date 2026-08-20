/**
 * The in-prose reference chip family's HOVER recipe — one string so the mention,
 * channel, conversation and locator chips cannot drift apart.
 *
 * shiki, 2026-08-21 (#task:2120): hover stops painting a background and only
 * darkens the ink, `--accent` → `--accent-hover`. That is the move a plain prose
 * link has always made here (`global.css`: `.markdown-body a:hover { color:
 * var(--accent-hover) }`), so the family now agrees with the links it sits
 * between instead of lighting a pill under one word of a sentence — the loudest
 * thing in the paragraph, for an event as cheap as "the pointer is here". The
 * pointer already carries the position; colour only has to say "this is live".
 *
 * FOCUS IS NOT HOVER, and each component keeps the focus signal it shipped with
 * (`focus-visible:bg-accent-soft` on the mention button, the shared
 * `focus-outline` utility on the ref chips). These chips are borderless: a
 * keyboard user has no pointer to say WHICH chip is focused, so colour alone
 * would be the sole carrier of that state. This constant governs the resting →
 * hover transition and nothing else.
 *
 * The TASK chip is deliberately outside this family. In an activity cluster it
 * fills solid on hover (`global.css` `.system-activity-cluster
 * [data-task-ref]:hover`, with forza6 overriding the fill again) and in prose it
 * is a borderless link with a hover underline (#task:1725) — both settled on
 * their own surfaces, neither of them a colour swap.
 */
export const INLINE_REF_HOVER_CLASS = 'transition-colors hover:text-accent-hover';
