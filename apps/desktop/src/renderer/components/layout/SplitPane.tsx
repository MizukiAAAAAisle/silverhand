import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

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

  const ratioRef = useRef(ratio);
  const frameRef = useRef<number | null>(null);

  const persistRatio = useCallback((next: number): void => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* quota or private mode — fall back to in-memory */
    }
  }, [storageKey]);

  useLayoutEffect(() => {
    ratioRef.current = ratio;
    containerRef.current?.style.setProperty(
      '--split-left-width',
      `${ratio * 100}%`,
    );
  }, [ratio]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const scheduleRatio = useCallback((next: number): void => {
    ratioRef.current = next;
    const container = containerRef.current;
    if (!container) return;

    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      container.style.setProperty(
        '--split-left-width',
        `${ratioRef.current * 100}%`,
      );
    });
  }, []);

  const flushRatio = useCallback((): void => {
    const container = containerRef.current;
    if (!container) return;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    container.style.setProperty(
      '--split-left-width',
      `${ratioRef.current * 100}%`,
    );
  }, []);

  const dragging = useRef(false);
  // Mirror dragging-as-state so the divider can paint with the accent
  // colour during the drag (matches the sidebar splitter's `active`
  // affordance via VerticalSplitter). Pointer move stays driven by
  // refs/rAF — the state only flips on down/up, no per-move re-renders.
  const [isDragging, setIsDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    setIsDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
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
      scheduleRatio(clamped);
    },
    [minRatio, maxRatio, scheduleRatio],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      setIsDragging(false);
      flushRatio();
      const next = ratioRef.current;
      setRatio(next);
      persistRatio(next);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    },
    [flushRatio, persistRatio],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full min-w-0 flex-1 overflow-hidden"
      style={{ '--split-left-width': `${ratio * 100}%` } as CSSProperties}
    >
      <div
        style={{ width: 'var(--split-left-width)' }}
        className="flex h-full min-w-0 overflow-hidden"
      >
        {left}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Same paint vocabulary as VerticalSplitter — the track is
        // transparent by default (themes set --splitter-bg: transparent),
        // tints with --accent on hover, and stays accent-coloured for
        // the duration of an active drag. `transition-colors` smooths
        // the hover fade so the divider doesn't pop in/out.
        className={
          'group/split relative w-1 shrink-0 cursor-col-resize transition-colors ' +
          (isDragging
            ? 'bg-accent'
            : 'bg-[var(--splitter-bg,var(--border-subtle))] hover:bg-accent')
        }
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
