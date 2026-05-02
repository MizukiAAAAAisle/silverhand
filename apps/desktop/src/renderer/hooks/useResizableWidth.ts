import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Options {
  /** localStorage key the width is persisted under. */
  storageKey: string;
  /** Width used on first render (and when storage holds a bad value). */
  defaultWidth: number;
  min: number;
  max: number;
  /** Optional CSS custom property (e.g. `--sidebar-width`) to mirror
   *  the width into. Set on `document.documentElement` so existing
   *  `var(--name)` styles in unrelated components stay reactive. */
  cssVar?: string;
}

export interface ResizableWidth {
  width: number;
  /** Attach to a 4px splitter element on the column's right edge. */
  startResize: (e: React.PointerEvent) => void;
  isDragging: boolean;
}

/**
 * Persistent column width with a draggable splitter on the right edge.
 * The hook owns the localStorage round-trip and (optionally) mirrors
 * the width into a CSS custom property so existing `w-[var(--…)]`
 * call sites pick up the change without re-plumbing.
 *
 * Drag handling listens on `document` (rather than the splitter
 * element) so the gesture survives the cursor leaving the 4px hit
 * region — important for thin handles.
 */
export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  cssVar,
}: Options): ResizableWidth {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw !== null ? Number(raw) : NaN;
      if (Number.isFinite(n) && n >= min && n <= max) return n;
    } catch {
      /* private mode — fall through to default */
    }
    return defaultWidth;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(width));
    } catch {
      /* quota or private mode — in-memory is fine */
    }
  }, [width, storageKey]);

  useLayoutEffect(() => {
    if (!cssVar) return;
    document.documentElement.style.setProperty(cssVar, `${width}px`);
  }, [width, cssVar]);

  const dragOriginX = useRef(0);
  const dragOriginWidth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragOriginX.current = e.clientX;
      dragOriginWidth.current = width;
      setDragging(true);

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - dragOriginX.current;
        const next = Math.max(
          min,
          Math.min(max, dragOriginWidth.current + dx),
        );
        setWidth(next);
      };
      const onUp = (): void => {
        setDragging(false);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width, min, max],
  );

  return { width, startResize, isDragging: dragging };
}
