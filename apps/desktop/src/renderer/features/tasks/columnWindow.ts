import type { TaskStatus } from '@silverhand/shared';

/**
 * Per-column render window for the task boards (#task:1885, parent #task:1883).
 *
 * The board's cost is `columns × rows`, and both task surfaces render the SAME
 * population: the `/tasks` pane and the titlebar drawer share one query cache,
 * and the drawer is mounted (translated off-screen) for the whole time a channel
 * is open. At 500 tasks that made a single Chat mount construct thousands of
 * cards for a board nobody was looking at (#task:1882 measurements).
 *
 * The bound is a WINDOW, not a virtualizer: each column renders a prefix of its
 * own list — `pages × COLUMN_PAGE_SIZE` rows — and grows one page at a time when
 * the reader reaches the end of that column. Card height is content-dependent
 * (title wraps), so a prefix window needs no measured row height, no absolute
 * positioning, and no scroll-anchor maths; the column keeps its ordinary
 * `overflow-y-auto` body and its ordinary DOM order (drag/drop, reveal and
 * keyboard order all keep working unchanged).
 *
 * The window is SURFACE-LOCAL on purpose. Pages live in the shared query cache,
 * so a drawer session that scrolled to page 5 leaves 5 pages cached; the pane
 * must not inherit that as a render bound (and vice versa) — otherwise one
 * surface's scrolling silently re-inflates the other's mount cost, which is the
 * exact defect this window exists to remove. Growth is therefore per surface,
 * and the closed drawer pins back to the first page.
 *
 * This module is the whole decision layer: how many rows a column renders, and
 * what forces it to render more. `useColumnWindow` is the React state for it.
 */

/**
 * Rows per page. Matches the authority read face's page size (#task:1884) so a
 * locally-grown window and a fetched page advance in the same steps: growing the
 * window by one page consumes exactly one cached page.
 */
export const COLUMN_PAGE_SIZE = 20;

/** Visible page count per status column. Never below 1 — a column always shows
 *  its first page (an empty column then renders its empty state, not nothing). */
export type ColumnWindow = Readonly<Record<TaskStatus, number>>;

export const FIRST_COLUMN_WINDOW: ColumnWindow = {
  todo: 1,
  in_progress: 1,
  in_review: 1,
  done: 1,
  closed: 1,
};

/** How many rows this column may render. */
export function columnVisibleCount(
  window: ColumnWindow,
  status: TaskStatus,
): number {
  return window[status] * COLUMN_PAGE_SIZE;
}

/** Reveal one more page of ONE column. */
export function growColumnWindow(
  window: ColumnWindow,
  status: TaskStatus,
): ColumnWindow {
  return { ...window, [status]: window[status] + 1 };
}

/**
 * Widen ONE column just enough to render the row at `index` (0-based, in that
 * column's own order). Returns the same object when the window already covers
 * it, so a caller can hand the result straight to `setState` without forcing a
 * render.
 *
 * This is what makes a reveal work against a bounded window: "View in Tasks" can
 * target a task at index 137, and a row outside the window has no
 * `[data-task-id]` element to scroll to. Coverage is STICKY (it goes into the
 * window state, not a derived bound) — the row must stay rendered after the
 * pulse expires, not vanish under the reader.
 */
export function columnWindowCovering(
  window: ColumnWindow,
  status: TaskStatus,
  index: number,
): ColumnWindow {
  if (index < 0) return window;
  const pages = Math.floor(index / COLUMN_PAGE_SIZE) + 1;
  return pages <= window[status] ? window : { ...window, [status]: pages };
}
