import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TaskStatus } from '@silverhand/shared';
import {
  columnWindowCovering,
  FIRST_COLUMN_WINDOW,
  growColumnWindow,
  type ColumnWindow,
} from './columnWindow';

/**
 * Surface-local render window for one task board (see `columnWindow.ts` for the
 * model and why the bound is per surface).
 *
 * There is deliberately NO automatic reset key here. Resetting is owned by
 * whoever changes what the columns hold: a filter change, a drawer's baseline
 * re-anchor, a reveal that widens the view. A derived key looks tidier but
 * breaks the one case that matters — a reveal writes the filter reset and the
 * window coverage in the SAME commit, and a window keyed on the filters would
 * file that coverage under the outgoing key and drop it. So the surface calls
 * `reset()` next to its own `setFilters`, and both writes land together.
 */
export function useColumnWindow(): {
  columnWindow: ColumnWindow;
  /** Render one more page of a column (end of column reached). */
  grow: (status: TaskStatus) => void;
  /** Back to the first page of every column. */
  reset: () => void;
  /** Widen a column so the row at `index` renders (reveal). */
  coverIndex: (status: TaskStatus, index: number) => void;
} {
  const [columnWindow, setColumnWindow] =
    useState<ColumnWindow>(FIRST_COLUMN_WINDOW);

  const grow = useCallback((status: TaskStatus) => {
    setColumnWindow(prev => growColumnWindow(prev, status));
  }, []);

  const reset = useCallback(() => {
    setColumnWindow(prev =>
      prev === FIRST_COLUMN_WINDOW ? prev : FIRST_COLUMN_WINDOW,
    );
  }, []);

  const coverIndex = useCallback((status: TaskStatus, index: number) => {
    setColumnWindow(prev => columnWindowCovering(prev, status, index));
  }, []);

  return { columnWindow, grow, reset, coverIndex };
}

/**
 * Grow a column when its tail comes into view. Same idiom as the threads
 * panel's infinite scroll (`ChannelThreadsPanel`): a sentinel at the tail of the
 * column body, observed with the COLUMN as the intersection root — never the
 * viewport, which would mis-fire for a row scrolled out of an ancestor's clip.
 *
 * An observer (rather than an `onScroll` threshold) also answers the case a
 * scroll handler cannot: a tall column whose first page does not fill it emits
 * no scroll event at all, so the rows past the window would be unreachable. The
 * sentinel is simply already visible there, and the window grows until the
 * column is full.
 *
 * `onReachEnd` is read through a ref so an inline closure does not resubscribe
 * the observer every render; the subscription itself is renewed when the
 * rendered length changes, so a freshly grown window that still leaves the
 * sentinel in view chains the next page.
 */
export function useColumnEndSentinel(args: {
  rootRef: RefObject<HTMLElement | null>;
  sentinelRef: RefObject<HTMLElement | null>;
  /** Whether anything remains past the window (no sentinel, no observer). */
  hasMore: boolean;
  /** Number of rows currently rendered — resubscribe trigger. */
  renderedCount: number;
  onReachEnd: () => void;
}): void {
  const { rootRef, sentinelRef, hasMore, renderedCount } = args;
  const onReachEndRef = useRef(args.onReachEnd);
  onReachEndRef.current = args.onReachEnd;
  useEffect(() => {
    if (!hasMore) return;
    const root = rootRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel) return;
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) onReachEndRef.current();
      },
      { root, rootMargin: '120px' },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, renderedCount, rootRef, sentinelRef]);
}
