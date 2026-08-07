import { describe, expect, it } from 'vitest';
import {
  COLUMN_PAGE_SIZE,
  columnVisibleCount,
  columnWindowCovering,
  FIRST_COLUMN_WINDOW,
  growColumnWindow,
} from './columnWindow';

describe('columnVisibleCount', () => {
  it('starts every column at one page', () => {
    for (const status of [
      'todo',
      'in_progress',
      'in_review',
      'done',
      'closed',
    ] as const) {
      expect(columnVisibleCount(FIRST_COLUMN_WINDOW, status)).toBe(
        COLUMN_PAGE_SIZE,
      );
    }
  });
});

describe('growColumnWindow', () => {
  it('adds one page to the named column only', () => {
    const grown = growColumnWindow(FIRST_COLUMN_WINDOW, 'todo');
    expect(columnVisibleCount(grown, 'todo')).toBe(COLUMN_PAGE_SIZE * 2);
    expect(columnVisibleCount(grown, 'in_progress')).toBe(COLUMN_PAGE_SIZE);
  });

  it('accumulates across calls', () => {
    const grown = growColumnWindow(
      growColumnWindow(FIRST_COLUMN_WINDOW, 'done'),
      'done',
    );
    expect(columnVisibleCount(grown, 'done')).toBe(COLUMN_PAGE_SIZE * 3);
  });
});

describe('columnWindowCovering', () => {
  it('leaves the window untouched — same object — when the row already renders', () => {
    const covered = columnWindowCovering(
      FIRST_COLUMN_WINDOW,
      'todo',
      COLUMN_PAGE_SIZE - 1,
    );
    expect(covered).toBe(FIRST_COLUMN_WINDOW);
  });

  it('widens to the page that holds the row', () => {
    const covered = columnWindowCovering(FIRST_COLUMN_WINDOW, 'todo', 137);
    // 137 sits on page 7 (indices 120..139).
    expect(columnVisibleCount(covered, 'todo')).toBe(COLUMN_PAGE_SIZE * 7);
    expect(covered.todo * COLUMN_PAGE_SIZE).toBeGreaterThan(137);
  });

  it('covers the first row past the window by exactly one more page', () => {
    const covered = columnWindowCovering(
      FIRST_COLUMN_WINDOW,
      'in_review',
      COLUMN_PAGE_SIZE,
    );
    expect(columnVisibleCount(covered, 'in_review')).toBe(COLUMN_PAGE_SIZE * 2);
  });

  it('never shrinks an already wider window', () => {
    const wide = growColumnWindow(
      growColumnWindow(FIRST_COLUMN_WINDOW, 'todo'),
      'todo',
    );
    expect(columnWindowCovering(wide, 'todo', 1)).toBe(wide);
  });

  it('ignores an absent row (index -1) rather than widening', () => {
    expect(columnWindowCovering(FIRST_COLUMN_WINDOW, 'closed', -1)).toBe(
      FIRST_COLUMN_WINDOW,
    );
  });
});
