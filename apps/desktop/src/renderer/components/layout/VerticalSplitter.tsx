interface VerticalSplitterProps {
  onPointerDown: (e: React.PointerEvent) => void;
  active?: boolean;
}

/**
 * 4px-wide draggable column divider. Hover or active drag tints the track with
 * `--splitter-hover-bg` — a neutral ink every theme sets (fence-enforced in
 * appearance.test.ts, since forza6 declares it). The `var(--border)` fallback is
 * a neutral safety net: a divider is a utility signal, so it must never fall back
 * to `--accent` — a saturated accent on a 4px separator reads as "look at this!"
 * and steals the accent budget (v6.9.6 #task:917: forza6's fallback used to map
 * to hot brand pink). Same pattern in SplitPane.tsx's divider.
 *
 * GEOMETRY (#task:1965 review round 1). The track is a flex item, so without
 * help it would add its own 4px column ON TOP of the sheet's `--pane-gap`,
 * pushing the panes `gap + 4 + gap` apart. The negative inline margin pulls it
 * back so the VISIBLE distance between panes stays exactly `--pane-gap` with the
 * track centred in it. This used to be a per-theme `--splitter-offset` token
 * holding a hand-written `calc((var(--frame-padding) + 4px) / -2)` in every
 * theme file — derived here instead, because a theme that changes its gap and
 * forgets the offset gets a silently wrong seam (exactly what happened when
 * iris took the gap to 0).
 *
 * At `--pane-gap: 0` the track straddles the seam (±2px into each pane), which
 * is why it needs `zIndex`: both panes are positioned, so a later sibling would
 * otherwise paint its background over the track's right half — the centre
 * hairline a theme may draw on it would render at half width, and the hover
 * tint would only show on the left. For gapped themes the track sits inside the
 * empty gutter, so the stacking order is a no-op there.
 */
export function VerticalSplitter({
  onPointerDown,
  active = false,
}: VerticalSplitterProps): JSX.Element {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      style={{
        marginInline:
          'calc((var(--pane-gap, var(--frame-padding, 0px)) + 4px) / -2)',
        zIndex: 1,
      }}
      className={
        'relative w-1 shrink-0 cursor-col-resize transition-colors ' +
        (active
          ? 'bg-[var(--splitter-hover-bg,var(--border))]'
          : 'bg-[var(--splitter-bg,var(--border-subtle))] hover:bg-[var(--splitter-hover-bg,var(--border))]')
      }
    >
      <div className="absolute -inset-x-1.5 inset-y-0" />
    </div>
  );
}
