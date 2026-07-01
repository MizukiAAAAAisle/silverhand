import { describe, expect, it } from 'vitest';
import { homeChannels, isStarredAt, partitionRailWorkspaces } from './home-grouping';

describe('isStarredAt', () => {
  it('treats a timestamp as starred, null/undefined as not', () => {
    expect(isStarredAt(123)).toBe(true);
    expect(isStarredAt(0)).toBe(true); // a real (epoch) timestamp is still starred
    expect(isStarredAt(null)).toBe(false);
    expect(isStarredAt(undefined)).toBe(false);
  });
});

describe('partitionRailWorkspaces (#task:1254 exclusive home projection)', () => {
  const ws = (
    id: string,
    over: { kind?: 'regular' | 'dm'; archived?: boolean; starred_at?: number | null } = {},
  ) => ({ id, kind: over.kind ?? 'regular', archived: over.archived, starred_at: over.starred_at ?? null });

  it('splits unstarred workspaces by kind and keeps input order within a group', () => {
    const { dms, regular, archived } = partitionRailWorkspaces([
      ws('r1'),
      ws('d1', { kind: 'dm' }),
      ws('r2'),
      ws('d2', { kind: 'dm' }),
    ]);
    expect(regular.map(w => w.id)).toEqual(['r1', 'r2']);
    expect(dms.map(w => w.id)).toEqual(['d1', 'd2']);
    expect(archived).toEqual([]);
  });

  it('EXCLUDES starred entities from the home groups (they live only in STARRED)', () => {
    const input = [
      ws('r1'),
      ws('r2', { starred_at: 1000 }),
      ws('d1', { kind: 'dm', starred_at: 2000 }),
      ws('d2', { kind: 'dm' }),
    ];
    const { dms, regular } = partitionRailWorkspaces(input);
    // Home groups drop the starred ones...
    expect(regular.map(w => w.id)).toEqual(['r1']);
    expect(dms.map(w => w.id)).toEqual(['d2']);
    // ...but the RAW input still carried them (two-layer: source full, home projected).
    expect(input.map(w => w.id)).toEqual(['r1', 'r2', 'd1', 'd2']);
  });

  it('archived takes precedence and is never excluded by star', () => {
    const { archived, regular, dms } = partitionRailWorkspaces([
      ws('a1', { archived: true }),
      ws('a2', { archived: true, starred_at: 5 }),
      ws('r1'),
    ]);
    expect(archived.map(w => w.id)).toEqual(['a1', 'a2']);
    expect(regular.map(w => w.id)).toEqual(['r1']);
    expect(dms).toEqual([]);
  });
});

describe('homeChannels (#task:1254 exclusive channel home list)', () => {
  const node = (
    id: string,
    over: { parent_channel_id?: string | null; starred_at?: number | null } = {},
  ) => ({ id, parent_channel_id: over.parent_channel_id ?? null, starred_at: over.starred_at ?? null });

  it('keeps top-level unstarred channels only', () => {
    const out = homeChannels([
      node('c1'),
      node('c2', { starred_at: 10 }),
      node('c3'),
    ]);
    expect(out.map(c => c.id)).toEqual(['c1', 'c3']);
  });

  it('drops legacy thread fossils (non-null parent) regardless of star', () => {
    const out = homeChannels([
      node('c1'),
      node('t1', { parent_channel_id: 'c1' }),
      node('t2', { parent_channel_id: 'c1', starred_at: 9 }),
    ]);
    expect(out.map(c => c.id)).toEqual(['c1']);
  });

  it('produces a list whose ids carry no starred channel — the reorder ordered_ids source', () => {
    const input = [node('c1', { starred_at: 1 }), node('c2'), node('c3', { starred_at: 2 })];
    const orderedIds = homeChannels(input).map(c => c.id);
    expect(orderedIds).toEqual(['c2']);
    // raw input still has the starred ones (server consumes the full set).
    expect(input).toHaveLength(3);
  });
});
