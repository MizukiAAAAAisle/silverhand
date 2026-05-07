interface VerticalSplitterProps {
  onPointerDown: (e: React.PointerEvent) => void;
  active?: boolean;
}

/**
 * 4px-wide draggable column divider. Hover or active drag tints the
 * track with `--accent`; the actual hit area extends ±6px on either
 * side via an absolutely-positioned child so users don't need
 * pixel-perfect aim.
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
          ? 'bg-accent'
          : 'bg-[var(--splitter-bg,var(--border-subtle))] hover:bg-accent')
      }
    >
      <div className="absolute -inset-x-1.5 inset-y-0" />
    </div>
  );
}
