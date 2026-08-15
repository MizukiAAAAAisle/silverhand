/**
 * Convergence contract for a channel self-join.
 *
 * `applyChannelJoinToList` is the pure core of `useJoinChannel`'s success path:
 * it flips the JOINED channel's list carrier to `is_member: true` from the
 * authoritative 200 so membership resolves to `member` immediately — before the
 * list refetch lands. `deriveChannelMembership` prefers the carrier, so without
 * this in-place convergence the row (and any ChannelView reading it) would stay
 * `nonmember` until the refetch, and a slow/failed refetch would strand it.
 *
 * The FAILURE side is a structural invariant, not a code path: `useJoinChannel`
 * has NO `onError` handler and calls this only from `onSuccess`, so a failed
 * join never runs it and every carrier stays `nonmember`. These tests lock the
 * success semantics + the referential-stability (no-op) guarantees that keep a
 * failed/absent case from mutating the cache.
 */
import { describe, expect, it } from 'vitest';
import { applyChannelJoinToList, type ChannelListItem } from './hooks';
import type { ChannelListPayload } from './hooks';

function item(id: string, is_member?: boolean): ChannelListItem {
  return { id, placement_kind: 'workspace', roster_policy: 'open', is_member } as unknown as ChannelListItem;
}

function payload(items: ChannelListItem[]): ChannelListPayload {
  return { items, viewerSort: { mode: 'recency', entries: [] } as never };
}

describe('applyChannelJoinToList', () => {
  it('flips ONLY the joined channel to is_member=true, leaving others untouched', () => {
    const before = payload([
      item('a', false), // the one we join
      item('b', false), // another unjoined public — must NOT flip
      item('c', true), // already a member
    ]);
    const after = applyChannelJoinToList(before, 'a');
    expect(after?.items.map(c => [c.id, c.is_member])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('is a no-op (same reference) when the channel is already a member', () => {
    const before = payload([item('a', true)]);
    expect(applyChannelJoinToList(before, 'a')).toBe(before);
  });

  it('is a no-op (same reference) when the joined id is absent from the loaded list', () => {
    // A deep-link to a channel the workspace list has not fetched: nothing to
    // converge here (the detail cache carries the authoritative membership).
    const before = payload([item('a', false)]);
    expect(applyChannelJoinToList(before, 'zzz')).toBe(before);
  });

  it('passes an unloaded (undefined) cache through untouched', () => {
    expect(applyChannelJoinToList(undefined, 'a')).toBeUndefined();
  });
});
