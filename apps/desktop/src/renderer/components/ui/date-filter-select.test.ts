import { describe, expect, it } from 'vitest';
import { DATE_FILTER_OPTIONS, dateFilterSince } from './date-filter-select';

/**
 * The recency-filter order is ONE global source (global contract): Attachments,
 * Saved, and Archived all consume `DATE_FILTER_OPTIONS` — there is no
 * per-instance override — so a reorder here silently flips every surface. This
 * test pins the agreed near→far order so an accidental edit can't drift it
 * back without a red test.
 */
describe('DATE_FILTER_OPTIONS — canonical near→far order', () => {
  it('is exactly all → 7d → 14d → 30d', () => {
    expect(DATE_FILTER_OPTIONS.map(o => o.value)).toEqual([
      'all',
      '7d',
      '14d',
      '30d',
    ]);
  });
});

describe('dateFilterSince — cutoff resolves against an injected clock', () => {
  const NOW = 1_000 * 60 * 60 * 24 * 100; // an arbitrary fixed epoch-ms

  it('"all" has no lower bound', () => {
    expect(dateFilterSince('all', NOW)).toBeNull();
  });

  it('each preset subtracts its own span from the injected now', () => {
    const day = 1_000 * 60 * 60 * 24;
    expect(dateFilterSince('7d', NOW)).toBe(NOW - 7 * day);
    expect(dateFilterSince('14d', NOW)).toBe(NOW - 14 * day);
    expect(dateFilterSince('30d', NOW)).toBe(NOW - 30 * day);
  });
});
