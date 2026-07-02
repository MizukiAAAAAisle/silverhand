import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { decodeMessageSeq } from '@silverhand/shared';
import type {
  ListChannelThreadsResponse,
  ThreadSummary,
  ThreadSummaryInvariant,
} from '@silverhand/shared';
import {
  channelThreadsKey,
  compareThreadSummary,
  mergeThreadsListEntry,
} from './useChannelThreads';

/** A full ThreadSummary row (what the client holds). */
function row(
  rootId: string,
  lastReplyAt: number,
  rootSeq: number,
  over: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    root_message_id: rootId,
    root_author: { kind: 'human', id: 'u1' },
    root_preview: `root ${rootId}`,
    root_created_at: 0,
    root_seq: decodeMessageSeq(rootSeq),
    reply_count: 1,
    last_reply_at: lastReplyAt,
    last_reply_message_id: `lr-${rootId}-${lastReplyAt}`,
    repliers: [{ kind: 'human', id: 'u1' }],
    replier_total: 1,
    viewer_following: false,
    ...over,
  };
}

/** The viewer-invariant subset a `threads_list_entry` patch carries (no
 *  `viewer_following`). */
function entry(
  rootId: string,
  lastReplyAt: number,
  rootSeq: number,
  over: Partial<ThreadSummaryInvariant> = {},
): ThreadSummaryInvariant {
  const { viewer_following: _drop, ...invariant } = row(rootId, lastReplyAt, rootSeq);
  return { ...invariant, ...over };
}

function seedList(qc: QueryClient, channelId: string, threads: ThreadSummary[]): void {
  qc.setQueryData<ListChannelThreadsResponse>(channelThreadsKey(channelId), {
    threads,
    next_cursor: null,
  });
}
function listRoots(qc: QueryClient, channelId: string): string[] {
  return (
    qc
      .getQueryData<ListChannelThreadsResponse>(channelThreadsKey(channelId))
      ?.threads.map(t => t.root_message_id) ?? []
  );
}

// The SINGLE keyset comparator MUST reproduce the server's total order EXACTLY
// (`message-repo.ts` ORDER BY lr.created_at DESC, root.seq DESC) — Cindy gate ②.
describe('compareThreadSummary — documented keyset (last_reply_at DESC, root_seq DESC)', () => {
  it('orders by last_reply_at DESC primarily', () => {
    const sorted = [row('a', 100, 1), row('b', 300, 2), row('c', 200, 3)].sort(
      compareThreadSummary,
    );
    expect(sorted.map(t => t.root_message_id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a same-millisecond last_reply_at tie by root_seq DESC (== server)', () => {
    // Three roots forced to the SAME last_reply_at — only root_seq resolves them.
    const sorted = [row('a', 500, 10), row('b', 500, 30), row('c', 500, 20)].sort(
      compareThreadSummary,
    );
    expect(sorted.map(t => t.root_message_id)).toEqual(['b', 'c', 'a']);
  });
});

// SOURCE FENCE (#task:1279) — a golden fixture in the EXACT order the server
// returns (`message-repo.ts` listChannelThreads `ORDER BY lr.created_at DESC,
// root.seq DESC`). It locks `compareThreadSummary` to that authoritative order:
// any client-side drift fails here, and the fixture is the canonical example a
// server-side ORDER BY change must be reconciled against (change both together).
describe('SOURCE FENCE — compareThreadSummary reproduces the server total order', () => {
  // Canonical server-ordered page: last_reply_at DESC primary, root_seq DESC to
  // break same-ms ties. Mixes a 3-way tie (500) with distinct buckets (300/100).
  const SERVER_ORDER: ThreadSummary[] = [
    row('a', 500, 30), // last_reply_at 500, highest seq in the tie
    row('b', 500, 20), // 500 tie → seq DESC
    row('c', 500, 10), // 500 tie → seq DESC
    row('d', 300, 99), // next bucket (seq irrelevant across buckets)
    row('e', 100, 5), // oldest activity
  ];
  const GOLDEN = SERVER_ORDER.map(t => t.root_message_id);

  it('recovers the server order from an arbitrary permutation', () => {
    // A fixed non-trivial permutation (not the identity) → sort must restore it.
    const shuffled = [
      SERVER_ORDER[3], // d
      SERVER_ORDER[1], // b
      SERVER_ORDER[4], // e
      SERVER_ORDER[0], // a
      SERVER_ORDER[2], // c
    ] as ThreadSummary[];
    expect(shuffled.sort(compareThreadSummary).map(t => t.root_message_id)).toEqual(
      GOLDEN,
    );
  });

  it('is a total order — reverse input also recovers the golden order', () => {
    const reversed = [...SERVER_ORDER].reverse();
    expect(reversed.sort(compareThreadSummary).map(t => t.root_message_id)).toEqual(
      GOLDEN,
    );
  });
});

describe('mergeThreadsListEntry — in-place merge + resort, no insert (#task:1278)', () => {
  it('cold-absent when no page data is loaded', () => {
    const qc = new QueryClient();
    expect(mergeThreadsListEntry(qc, 'c1', entry('a', 100, 1))).toBe('cold-absent');
  });

  it('off-page when the loaded page does not hold the root (no insert)', () => {
    const qc = new QueryClient();
    seedList(qc, 'c1', [row('a', 100, 1), row('b', 90, 2)]);
    expect(mergeThreadsListEntry(qc, 'c1', entry('z', 999, 9))).toBe('off-page');
    // Page membership unchanged — z was NOT inserted.
    expect(listRoots(qc, 'c1')).toEqual(['a', 'b']);
  });

  it('merges the absolute entry and repositions the row to the top by keyset', () => {
    const qc = new QueryClient();
    // b is bottom; a reply bumps b's last_reply_at above a → b must move to top.
    seedList(qc, 'c1', [row('a', 200, 1), row('b', 100, 2)]);
    const out = mergeThreadsListEntry(
      qc,
      'c1',
      entry('b', 300, 2, { reply_count: 5, last_reply_message_id: 'lr-b-new' }),
    );
    expect(out).toBe('merged');
    expect(listRoots(qc, 'c1')).toEqual(['b', 'a']); // resorted
    const b = qc
      .getQueryData<ListChannelThreadsResponse>(channelThreadsKey('c1'))
      ?.threads.find(t => t.root_message_id === 'b');
    expect(b?.reply_count).toBe(5); // absolute overwrite
    expect(b?.last_reply_at).toBe(300);
  });

  it('KEEPS the local viewer_following (frame carries none — Cindy gate ③)', () => {
    const qc = new QueryClient();
    seedList(qc, 'c1', [row('a', 100, 1, { viewer_following: true })]);
    mergeThreadsListEntry(
      qc,
      'c1',
      entry('a', 200, 1, { reply_count: 3, last_reply_message_id: 'lr-a-new' }),
    );
    const a = qc
      .getQueryData<ListChannelThreadsResponse>(channelThreadsKey('c1'))
      ?.threads.find(t => t.root_message_id === 'a');
    expect(a?.viewer_following).toBe(true); // preserved, not defaulted to false
    expect(a?.reply_count).toBe(3);
  });

  it('is a no-op on exact replay (same last_reply_message_id + reply_count)', () => {
    const qc = new QueryClient();
    seedList(qc, 'c1', [row('a', 100, 1), row('b', 90, 2)]);
    const before = qc.getQueryData<ListChannelThreadsResponse>(
      channelThreadsKey('c1'),
    );
    // Entry equals the held row's reply state → merged but no write (same reference).
    const out = mergeThreadsListEntry(qc, 'c1', entry('a', 100, 1));
    expect(out).toBe('merged');
    expect(qc.getQueryData(channelThreadsKey('c1'))).toBe(before); // identical ref → no re-render
  });
});
