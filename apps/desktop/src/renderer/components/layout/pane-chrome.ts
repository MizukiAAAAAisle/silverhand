/**
 * Pane chrome — the one source for a pane's *identity* paint (#task:1969).
 *
 * A "pane" is a top-level column inside a section sheet: the browse sidebar,
 * the page beside it, the thread pane, the settings nav. Card themes give each
 * one a rounded, lifted surface; the flat themes (and iris, which puts the
 * radius on the sheet instead) resolve the same tokens to `0` / `none`, so a
 * pane reads as a plain region there. Both fallbacks matter: `--pane-radius`
 * and `--pane-shadow` are the narrow, pane-only knobs, falling back to the
 * generic `--card-*` pair a theme may already declare.
 *
 * This is a style object, not a `<Pane>` component, on purpose: the 27 call
 * sites are `aside` / `main` / `div` / `section` with their own layout classes,
 * refs and data hooks. Wrapping them would either need a polymorphic `as` prop
 * (all the cost of a component, none of the benefit) or an extra div —
 * and `SectionLayer` is `display: contents` precisely so panes stay direct
 * flex children of the sheet row.
 *
 * `overflow` is deliberately NOT part of the recipe. It genuinely varies —
 * `hidden` on most panes, `y-auto` on the scrolling detail views, and absent
 * on the two that let a child own the scroll container. Folding it in would
 * silently clip or unclip those. Same rule as the shared `data-*` hooks:
 * identity here, layout/spacing with the consumer.
 */
export const PANE_RADIUS = 'var(--pane-radius, var(--card-radius, 0))';
export const PANE_SHADOW = 'var(--pane-shadow, var(--card-shadow, none))';

/** Spread into a pane's inline `style`; add layout/overflow alongside it. */
export const paneChrome = {
  borderRadius: PANE_RADIUS,
  boxShadow: PANE_SHADOW,
} as const;
