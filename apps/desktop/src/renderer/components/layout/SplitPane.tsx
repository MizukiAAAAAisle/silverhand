import { useCallback, useEffect, useRef, useState } from 'react';

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  /** Initial ratio of the left pane (0..1). Default 0.5. */
  defaultRatio?: number;
  /** localStorage key for persisting the user's drag position. */
  storageKey?: string;
  /** Bounds in absolute ratio. */
  minRatio?: number;
  maxRatio?: number;
}

/**
 * Vertical split pane (two panes side-by-side, draggable divider).
 * Persists the user's drag position to localStorage when `storageKey`
 * is set. The right pane has its own header/composer — this component
 * just owns the divider geometry.
 */
export function SplitPane({
  left,
  right,
  defaultRatio = 0.5,
  storageKey,
  minRatio = 0.25,
  maxRatio = 0.75,
}: SplitPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number>(() => {
    if (!storageKey) return defaultRatio;
    try {
      const v = localStorage.getItem(storageKey);
      const n = v !== null ? Number(v) : NaN;
      if (Number.isFinite(n) && n >= minRatio && n <= maxRatio) return n;
    } catch {
      /* ignore */
    }
    return defaultRatio;
  });

  // Persist on change.
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(ratio));
    } catch {
      /* quota or private mode — fall back to in-memory */
    }
  }, [ratio, storageKey]);

  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = (e.clientX - rect.left) / rect.width;
      const clamped = Math.min(maxRatio, Math.max(minRatio, next));
      setRatio(clamped);
    },
    [minRatio, maxRatio],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  return (
    <div ref={containerRef} className="flex h-full min-w-0 flex-1 overflow-hidden">
      <div style={{ width: `${ratio * 100}%` }} className="flex h-full min-w-0 overflow-hidden">
        {left}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="group/split relative w-1 shrink-0 cursor-col-resize bg-border-subtle hover:bg-accent"
        role="separator"
        aria-orientation="vertical"
      >
        {/* Wider invisible hit-target so users don't need pixel-perfect aim. */}
        <div className="absolute -inset-x-1.5 inset-y-0" />
      </div>
      <div className="flex h-full min-w-0 flex-1 overflow-hidden">{right}</div>
    </div>
  );
}
