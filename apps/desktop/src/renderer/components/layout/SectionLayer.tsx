import type { ReactNode } from "react";

/**
 * Visibility wrapper for a top-level NavRail section (chat / tasks / members /
 * computers / settings) in App.tsx.
 *
 * WHY THIS EXISTS — read before "simplifying" it away (#task:1170):
 *
 * The top-level sections are rendered as independent conditional siblings whose
 * **mount/unmount is driven by `deferredSection`** (the low-priority deferred
 * value) while their **visibility is driven by `appSection`** (the urgent value
 * the rail click updates synchronously). Those two values intentionally diverge
 * for the one render step between a rail click and React's deferred re-render —
 * see App.tsx's section block for the full rationale.
 *
 * During that step the OUTGOING section must stay mounted (so its expensive
 * teardown — notably TasksSection's 274-card dnd-kit cleanup — lands on the
 * deferred commit, NOT the urgent click commit that paints the rail highlight)
 * yet must NOT be visible (we show the incoming chat shell instead, never the
 * stale previous board). This wrapper is what reconciles "mounted but not
 * shown":
 *
 *  - `visible` → `display: contents`: the wrapper generates no box of its own,
 *    so its children remain direct flex participants of App's frame row exactly
 *    as if the wrapper weren't there (gap / flex-basis / the sidebar-slot
 *    margin hacks all keep working). Do NOT swap this for a plain `<div>` — that
 *    would inject a flex item and break the frame layout.
 *  - hidden → `display: none`: the subtree is removed from layout, paint, focus
 *    order, and the a11y tree, but stays MOUNTED — so no teardown runs on this
 *    commit. The teardown happens later when `deferredSection` moves off this
 *    section and the sibling condition unmounts the layer, i.e. on the deferred
 *    commit, off the click critical path.
 *
 * Toggling only `display` never moves a child in the tree, so React preserves
 * the section's component instances (no remount, no lost scroll/state) across
 * the show↔hide flip.
 *
 * The `data-section-layer` hook is how `global.css` §App frame corners finds
 * the frame's right edge: this wrapper's `:last-child` IS the card sitting in
 * the app window's bottom-right corner, whichever section is mounted. Keep the
 * attribute if you touch this component.
 */
export function SectionLayer({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div data-section-layer="" style={{ display: visible ? "contents" : "none" }}>
      {children}
    </div>
  );
}
