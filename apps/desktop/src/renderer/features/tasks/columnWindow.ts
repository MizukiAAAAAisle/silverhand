import type { TaskStatus } from '@silverhand/shared';

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
