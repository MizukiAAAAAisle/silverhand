import { describe, expect, it } from 'vitest';
import {
  excludeStarredChannels,
  isStarredAt,
  partitionRailWorkspaces,
} from './home-grouping';

describe('isStarredAt', () => {
  it('treats a timestamp as starred, null/undefined as not', () => {
    expect(isStarredAt(123)).toBe(true);
    expect(isStarredAt(0)).toBe(true); // a real (epoch) timestamp is still starred
    expect(isStarredAt(null)).toBe(false);
    expect(isStarredAt(undefined)).toBe(false);
  });
});

describe('partitionRailWorkspaces (#task:1888 — kind split only; containers have no star, #task:1900)', () => {
  const ws = (
    id: string,
    over: { kind?: 'regular' | 'dm'; archived?: boolean } = {},
  ) => ({ id, kind: over.kind ?? 'regular', archived: over.archived });

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

  it('DROPS archived workspaces entirely (#task:1889 — no ARCHIVED group in the tree)', () => {
    const { regular, dms } = partitionRailWorkspaces([
      ws('a1', { archived: true }),
      ws('a2', { archived: true }),
      ws('ad', { kind: 'dm', archived: true }),
      ws('r1'),
    ]);
    expect(regular.map(w => w.id)).toEqual(['r1']);
    expect(dms).toEqual([]);
  });

  // The scope set for STARRED's freshness subscription (#task:1889). The bug this
  // pins is a WIRING bug, not a decision bug: `useFavorites` used to derive its
  // watched workspaces from the favorites rows it was currently showing, so a
  // parent whose last favorite got hidden dropped out of the set and the restore
  // event had nobody listening. Returning the scope from THIS call — the one place
  // that sees the raw input — is what makes "derived from the projection" not
  // expressible; these cells pin that it is strictly WIDER than the home groups.
  it('returns every raw workspace as the watch scope, including ones the tree drops', () => {
    const { dms, regular, allVisibleIds } = partitionRailWorkspaces([
      ws('r1'),
      ws('a1', { archived: true }),
      ws('d1', { kind: 'dm' }),
    ]);
    // `a1` is archived: not in the tree, still watched — a restore is exactly the
    // event that brings its hidden star back.
    expect(allVisibleIds).toEqual(['r1', 'a1', 'd1']);
    expect([...regular, ...dms].map(w => w.id)).not.toContain('a1');
  });

  it('watches a workspace that contributes NO row at all (zero favorites, zero children)', () => {
    // An empty workspace holds no favorite, so a result-derived scope set excluded
    // it. It must still be watched: that is where a star waits to be restored.
    const { allVisibleIds } = partitionRailWorkspaces([ws('empty')]);
    expect(allVisibleIds).toEqual(['empty']);
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
