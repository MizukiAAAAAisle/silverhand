/**
 * Convergence contract for a channel self-leave.
 *
 * `applyChannelLeaveToList` is the pure core of `useLeaveChannel`'s success
 * path. Leaving forks on the channel's visibility — the two outcomes are a
 * behavior/structure branch, not cosmetics:
 *   - PRIVATE → the row DROPS from the discovery union (a non-member can't see a
 *     private channel), so the sidebar and any member-scoped projection lose it
 *     immediately, before the refetch lands.
 *   - PUBLIC → the row STAYS (still browsable) with `is_member: false`, so the
 *     open ChannelView collapses to the Join bar — the mirror of join's flip.
 *
 * The FAILURE side is a structural invariant, not a code path: `useLeaveChannel`
 * has NO `onError` handler and calls this only from `onSuccess`, so a failed
 * leave never runs it and the viewer stays a member. These tests lock the
 * per-visibility success semantics + the referential-stability (no-op)
 * guarantees.
 */
import { describe, expect, it } from 'vitest';
import { applyChannelLeaveToList, type ChannelListItem } from './hooks';
import type { ChannelListPayload } from './hooks';

function item(id: string, is_member?: boolean): ChannelListItem {
  return { id, kind: 'channel', is_member } as unknown as ChannelListItem;
}

function payload(items: ChannelListItem[]): ChannelListPayload {
  return { items, viewerSort: { mode: 'recency', entries: [] } as never };
}

describe('applyChannelLeaveToList', () => {
  it('drops ONLY the left channel from a PRIVATE leave, leaving others', () => {
    const before = payload([item('a', true), item('b', true), item('c', false)]);
    const after = applyChannelLeaveToList(before, 'b', 'private');
    expect(after?.items.map(c => c.id)).toEqual(['a', 'c']);
  });

  it('flips ONLY the left channel to is_member=false on a PUBLIC leave, keeping the row', () => {
    const before = payload([item('a', true), item('b', true), item('c', false)]);
    const after = applyChannelLeaveToList(before, 'b', 'public');
    expect(after?.items.map(c => [c.id, c.is_member])).toEqual([
      ['a', true],
      ['b', false], // stays in the list, now browse-and-Join
      ['c', false],
    ]);
  });

  it('is a no-op (same reference) when the left id is absent — either visibility', () => {
    const before = payload([item('a', true)]);
    expect(applyChannelLeaveToList(before, 'zzz', 'private')).toBe(before);
    expect(applyChannelLeaveToList(before, 'zzz', 'public')).toBe(before);
  });

  it('is a no-op (same reference) on a PUBLIC leave when the row is already non-member', () => {
    const before = payload([item('a', false)]);
    expect(applyChannelLeaveToList(before, 'a', 'public')).toBe(before);
  });

  it('passes an unloaded (undefined) cache through untouched', () => {
    expect(applyChannelLeaveToList(undefined, 'a', 'private')).toBeUndefined();
    expect(applyChannelLeaveToList(undefined, 'a', 'public')).toBeUndefined();
  });
});
