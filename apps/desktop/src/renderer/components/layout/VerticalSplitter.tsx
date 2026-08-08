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
        marginInline: 'var(--splitter-offset, 0)',
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
