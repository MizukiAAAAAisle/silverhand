import type { TaskStatus } from '@silverhand/shared';

/**
 * Per-column render window for the task boards (#task:1885, parent #task:1883).
 *
 * The board's cost is `columns × rows`, and the surfaces render the SAME
 * population: the `/tasks` section and the per-conversation inline Tasks tab share
 * one query cache. At 500 tasks a single unbounded mount constructed thousands of
 * cards (#task:1882 measurements).
 *
 * The bound is a WINDOW, not a virtualizer: each column renders a prefix of its
 * own list — `pages × COLUMN_PAGE_SIZE` rows — and grows one page at a time when
 * the reader reaches the end of that column. Card height is content-dependent
 * (title wraps), so a prefix window needs no measured row height, no absolute
 * positioning, and no scroll-anchor maths; the column keeps its ordinary
 * `overflow-y-auto` body and its ordinary DOM order (drag/drop and keyboard order
 * all keep working unchanged).
 *
 * The window is SURFACE-LOCAL on purpose. Pages live in the shared query cache,
 * so one surface that scrolled to page 5 leaves 5 pages cached; another must not
 * inherit that as a render bound — otherwise one surface's scrolling silently
 * re-inflates the other's mount cost, which is the exact defect this window exists
 * to remove. Growth is therefore per surface.
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
