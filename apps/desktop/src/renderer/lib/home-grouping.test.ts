import { describe, expect, it } from 'vitest';
import {
  excludeStarredChannels,
  isStarredAt,
  partitionRailWorkspaces,
  pinStarredFirst,
} from './home-grouping';

describe('isStarredAt', () => {
  it('treats a timestamp as starred, null/undefined as not', () => {
    expect(isStarredAt(123)).toBe(true);
    expect(isStarredAt(0)).toBe(true); // a real (epoch) timestamp is still starred
    expect(isStarredAt(null)).toBe(false);
    expect(isStarredAt(undefined)).toBe(false);
  });
});

describe('partitionRailWorkspaces (#task:1888 — kind split only, star no longer excludes)', () => {
  const ws = (
    id: string,
    over: { kind?: 'regular' | 'dm'; archived?: boolean; starred_at?: number | null } = {},
  ) => ({ id, kind: over.kind ?? 'regular', archived: over.archived, starred_at: over.starred_at ?? null });

  it('splits workspaces by kind and keeps input order within a group', () => {
    const { dms, regular } = partitionRailWorkspaces([
      ws('r1'),
      ws('d1', { kind: 'dm' }),
      ws('r2'),
      ws('d2', { kind: 'dm' }),
    ]);
    expect(regular.map(w => w.id)).toEqual(['r1', 'r2']);
    expect(dms.map(w => w.id)).toEqual(['d1', 'd2']);
  });

  it('KEEPS starred containers in their kind group (#task:1888 — star is a pin, not a move)', () => {
    const { dms, regular } = partitionRailWorkspaces([
      ws('r1'),
      ws('r2', { starred_at: 1000 }),
      ws('d1', { kind: 'dm', starred_at: 2000 }),
      ws('d2', { kind: 'dm' }),
    ]);
    expect(regular.map(w => w.id)).toEqual(['r1', 'r2']);
    expect(dms.map(w => w.id)).toEqual(['d1', 'd2']);
  });

  it('DROPS archived workspaces entirely (#task:1889 — no ARCHIVED group in the tree)', () => {
    const { regular, dms } = partitionRailWorkspaces([
      ws('a1', { archived: true }),
      ws('a2', { archived: true, starred_at: 5 }),
      ws('ad', { kind: 'dm', archived: true }),
      ws('r1'),
    ]);
    expect(regular.map(w => w.id)).toEqual(['r1']);
    expect(dms).toEqual([]);
  });
});

describe('pinStarredFirst (#task:1888 rail pin — ordering, never membership)', () => {
  const ws = (id: string, starred_at: number | null = null) => ({ id, starred_at });

  it('hoists starred to the front, preserving relative order on both sides', () => {
    const out = pinStarredFirst([ws('a'), ws('b', 20), ws('c'), ws('d', 10)]);
    expect(out.map(w => w.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('never adds or drops members — the reordered set is a permutation', () => {
    const input = [ws('a', 1), ws('b'), ws('c', 2)];
    const out = pinStarredFirst(input);
    expect([...out].map(w => w.id).sort()).toEqual(['a', 'b', 'c']);
    expect(input.map(w => w.id)).toEqual(['a', 'b', 'c']); // input untouched
  });

  it('leaves an all-unstarred group in place', () => {
    expect(pinStarredFirst([ws('a'), ws('b')]).map(w => w.id)).toEqual(['a', 'b']);
  });
});

describe('excludeStarredChannels (#task:1888 — starred conversations moved to global STARRED)', () => {
  const node = (id: string, starred_at: number | null = null) => ({ id, starred_at });

  it('drops starred channels from the home list, keeping input order', () => {
    const out = excludeStarredChannels([node('c1'), node('c2', 10), node('c3'), node('c4', 20)]);
    expect(out.map(c => c.id)).toEqual(['c1', 'c3']);
  });

  it('leaves the source list intact (RAW full set still feeds name resolution / Activity)', () => {
    const input = [node('c1', 1), node('c2'), node('c3', 2)];
    expect(excludeStarredChannels(input).map(c => c.id)).toEqual(['c2']);
    expect(input).toHaveLength(3);
  });
});
