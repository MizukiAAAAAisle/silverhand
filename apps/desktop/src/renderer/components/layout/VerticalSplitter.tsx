interface VerticalSplitterProps {
  onPointerDown: (e: React.PointerEvent) => void;
  active?: boolean;
}

/**
 * 4px-wide draggable column divider. Hover or active drag tints the
 * track with `--splitter-hover-bg` (falls through to `--accent` so
 * existing themes keep their current colour); the actual hit area
 * extends ±6px on either side via an absolutely-positioned child so
 * users don't need pixel-perfect aim.
 *
 * v6.9.6 #task:917 (shiki "拖拽的 resize handler 颜色, 在 forza6 下
 * 现在是节日粉"): the `bg-accent` fallback maps to `--forza6-pink-
 * deep` (`#B3186A`) in forza6 — a hot brand hue used as chrome for
 * a structural separator, which reads as "look at this divider!"
 * when it should fade into the column geometry. The new
 * `--splitter-hover-bg` token lets forza6 swap to a neutral ink
 * (matching warm-script's near-black accent, which read fine
 * because it WAS ink) without touching warm-script / slack-dark
 * (no token set → fallback to `var(--accent)` keeps their tuned
 * colour). Same pattern in SplitPane.tsx's divider.
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
          ? 'bg-[var(--splitter-hover-bg,var(--accent))]'
          : 'bg-[var(--splitter-bg,var(--border-subtle))] hover:bg-[var(--splitter-hover-bg,var(--accent))]')
      }
    >
      <div className="absolute -inset-x-1.5 inset-y-0" />
    </div>
  );
}
