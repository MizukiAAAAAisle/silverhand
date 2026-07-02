import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { decodeMessageSeq } from '@silverhand/shared';
import type { MessageDto, ThreadSummaryInvariant } from '@silverhand/shared';
import { messagesKey, threadRootKey } from '@/features/channels/hooks';
import { channelThreadsKey } from '@/features/channels/useChannelThreads';
import {
  dispositionSettle,
  ingestMessageProjections,
  validateMessageProjections,
  type ProjectionDisposition,
} from './projection-registry';

/** A committed reply MessageDto whose root is `rootId`. */
function replyMsg(rootId: string): MessageDto {
  return {
    id: 'r1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    content: 'body',
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(6),
    created_at: 0,
    thread_root_id: rootId,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
  };
}

/** A committed mainline (non-reply) MessageDto — `thread_root_id === null`. */
function nonReplyMsg(): MessageDto {
  return { ...replyMsg('ignored'), thread_root_id: null };
}

// #task:1277 §7 — the 4-state disposition is the renderer's contribution to the
// message-frame satisfaction join (#1261); `dispositionSettle` maps it onto the
// per-effect promise the ingestor joins with `Promise.allSettled`. The four
// states must NOT flatten (Cindy gate #5): "no target to write" (vacuous) and
// "needs a refetch that hasn't committed" (pending-fallback) are distinct.
describe('dispositionSettle — 4-state → satisfaction promise', () => {
  it('merged → a resolved promise (synchronous settle, advances the floor)', async () => {
    const settle = dispositionSettle({ status: 'merged' });
    expect(settle).not.toBeNull();
    await expect(settle).resolves.toBeUndefined();
  });

  it('cold-absent-vacuous → null (contributes nothing; an all-vacuous frame is vacuously satisfied)', () => {
    expect(dispositionSettle({ status: 'cold-absent-vacuous' })).toBeNull();
  });

  it('pending-fallback → its own refetch promise (floor waits for the commit)', async () => {
    const refetch = Promise.resolve();
    const settle = dispositionSettle({ status: 'pending-fallback', settle: refetch });
    expect(settle).toBe(refetch);
  });

  it('rejected → a rejected promise (pins the floor)', async () => {
    const err = new Error('refetch failed');
    const settle = dispositionSettle({ status: 'rejected', error: err });
    expect(settle).not.toBeNull();
    await expect(settle).rejects.toBe(err);
  });
});

function mountReader(qc: QueryClient, queryKey: readonly unknown[]): () => void {
  const observer = new QueryObserver(qc, {
    queryKey,
    queryFn: () => new Promise<never>(() => {}),
    enabled: false,
  });
  return observer.subscribe(() => {});
}

// The registry dispatch operates on ALREADY-VALIDATED projections (mismatch
// dropping happens upstream in `validateMessageProjections`). A present key is a
// validated patch, routed to its reader, which returns one disposition per
// DISPLAYED surface (empty ⇒ vacuous).
describe('ingestMessageProjections — reply_count reader dispatch (#task:1277)', () => {
  it('no displayed surface → empty dispositions (fully vacuous)', () => {
    const qc = new QueryClient();
    const out = ingestMessageProjections(qc, 'c1', {
      thread_root_reply_count: { root_id: 'root1', reply_count: 1 },
    });
    expect(out).toEqual([]);
  });

  it('open thread-root row with a loaded snapshot → merged (absolute value set)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, threadRootKey('c1', 'root1'));
    qc.setQueryData(threadRootKey('c1', 'root1'), {
      messages: [],
      reply_counts_by_root: { root1: 0 },
      has_more_before: false,
      has_more_after: false,
      stream_head_seq: 1,
    });

    const out = ingestMessageProjections(qc, 'c1', {
      thread_root_reply_count: { root_id: 'root1', reply_count: 5 },
    });

    expect(out).toEqual<ProjectionDisposition[]>([{ status: 'merged' }]);
    expect(
      qc.getQueryData<{ reply_counts_by_root: Record<string, number> }>(
        threadRootKey('c1', 'root1'),
      )?.reply_counts_by_root.root1,
    ).toBe(5);
    unsub();
  });

  it('mounted reader but empty snapshot → cold-absent-vacuous (not pending-fallback)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, threadRootKey('c1', 'root1'));
    const out = ingestMessageProjections(qc, 'c1', {
      thread_root_reply_count: { root_id: 'root1', reply_count: 5 },
    });
    expect(out).toEqual<ProjectionDisposition[]>([{ status: 'cold-absent-vacuous' }]);
    unsub();
  });

  it('open mainline with the root off-window → cold-absent-vacuous (badge not displayed)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, messagesKey('c1'));
    qc.setQueryData(messagesKey('c1'), {
      pages: [
        {
          messages: [],
          reply_counts_by_root: {}, // no key for root1 → off-window
          has_more_before: false,
          has_more_after: false,
          stream_head_seq: 5,
        },
      ],
      pageParams: [undefined],
    });
    const out = ingestMessageProjections(qc, 'c1', {
      thread_root_reply_count: { root_id: 'root1', reply_count: 5 },
    });
    expect(out).toEqual<ProjectionDisposition[]>([{ status: 'cold-absent-vacuous' }]);
    unsub();
  });

  it('dropped key (undefined after validation) → not dispatched', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, threadRootKey('c1', 'rootB'));
    qc.setQueryData(threadRootKey('c1', 'rootB'), {
      messages: [],
      reply_counts_by_root: { rootB: 7 },
      has_more_before: false,
      has_more_after: false,
      stream_head_seq: 1,
    });
    // A validated-projections object whose key was dropped carries `undefined`.
    const out = ingestMessageProjections(qc, 'c1', {
      thread_root_reply_count: undefined,
    });
    expect(out).toEqual([]);
    expect(
      qc.getQueryData<{ reply_counts_by_root: Record<string, number> }>(
        threadRootKey('c1', 'rootB'),
      )?.reply_counts_by_root.rootB,
    ).toBe(7);
    unsub();
  });
});

// The anti-corruption boundary (Cindy #1277 / doc §10 gate #6): single-point
// key-validation. A patch whose root doesn't match the frame's reply root is a
// dirty sidecar and is DROPPED — so the dispatch above can never merge the wrong
// root, and the ingestor keeps the real root's invalidate→refetch fallback.
describe('validateMessageProjections — single-point root-match validation (#task:1277)', () => {
  it('keeps a patch only when it targets THIS reply frame root', () => {
    const patch = { thread_root_reply_count: { root_id: 'rootA', reply_count: 1 } };
    // Match → kept verbatim.
    expect(validateMessageProjections(patch, replyMsg('rootA'))).toEqual(patch);
    // Mismatch → dropped to undefined.
    expect(validateMessageProjections(patch, replyMsg('rootB'))).toEqual({
      thread_root_reply_count: undefined,
    });
    // Non-reply frame (thread_root_id null) → dropped even if root_id happens to match id.
    expect(validateMessageProjections(patch, nonReplyMsg())).toEqual({
      thread_root_reply_count: undefined,
    });
    // Empty sidecar → nothing to keep.
    expect(validateMessageProjections({}, replyMsg('rootA'))).toEqual({
      thread_root_reply_count: undefined,
    });
  });

  it('a mismatched patch, once validated, is dropped so the dispatch merges nothing (dirty-sidecar kill)', () => {
    const qc = new QueryClient();
    // A loaded reader for the patch's (wrong) root, to prove it is left untouched.
    const unsub = mountReader(qc, threadRootKey('c1', 'rootB'));
    qc.setQueryData(threadRootKey('c1', 'rootB'), {
      messages: [],
      reply_counts_by_root: { rootB: 7 },
      has_more_before: false,
      has_more_after: false,
      stream_head_seq: 1,
    });

    // Frame is a reply to rootA, but the sidecar carries rootB → validation drops it.
    const validated = validateMessageProjections(
      { thread_root_reply_count: { root_id: 'rootB', reply_count: 99 } },
      replyMsg('rootA'),
    );
    expect(validated.thread_root_reply_count).toBeUndefined();

    const out = ingestMessageProjections(qc, 'c1', validated);
    expect(out).toEqual([]); // dropped patch → not consumed (ingestor falls back for rootA)
    expect(
      qc.getQueryData<{ reply_counts_by_root: Record<string, number> }>(
        threadRootKey('c1', 'rootB'),
      )?.reply_counts_by_root.rootB,
    ).toBe(7); // wrong root never merged to 99
    unsub();
  });
});

/** A viewer-invariant threads-list entry patch payload for `rootId`. */
function threadEntry(rootId: string, lastReplyAt = 300): ThreadSummaryInvariant {
  return {
    root_message_id: rootId,
    root_author: { kind: 'human', id: 'u1' },
    root_preview: `root ${rootId}`,
    root_created_at: 0,
    root_seq: decodeMessageSeq(2),
    reply_count: 5,
    last_reply_at: lastReplyAt,
    last_reply_message_id: `lr-${rootId}-${lastReplyAt}`,
    repliers: [{ kind: 'human', id: 'u1' }],
    replier_total: 1,
  };
}
function seedThreadsList(qc: QueryClient, rootId: string): void {
  qc.setQueryData(channelThreadsKey('c1'), {
    threads: [
      {
        ...threadEntry(rootId, 100),
        reply_count: 1,
        last_reply_message_id: `lr-${rootId}-100`,
        viewer_following: false,
      },
    ],
    next_cursor: null,
  });
}

// P2 threads_list_entry (#task:1278) — the reader repositions a HELD row in place
// (merged), falls back for an off-page root, and is vacuous when the list isn't
// displayed. Same 4-state disposition model as P1.
describe('ingestMessageProjections — threads_list_entry reader dispatch (#task:1278)', () => {
  it('no threads-list reader → empty dispositions (vacuous)', () => {
    const qc = new QueryClient();
    seedThreadsList(qc, 'root1'); // data present but nobody mounted
    const out = ingestMessageProjections(qc, 'c1', {
      threads_list_entry: { entry: threadEntry('root1') },
    });
    expect(out).toEqual([]);
  });

  it('held row + mounted reader → merged (in-place, no fallback)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, channelThreadsKey('c1'));
    seedThreadsList(qc, 'root1');
    const out = ingestMessageProjections(qc, 'c1', {
      threads_list_entry: { entry: threadEntry('root1', 300) },
    });
    expect(out).toEqual<ProjectionDisposition[]>([{ status: 'merged' }]);
    unsub();
  });

  it('mounted reader but page not loaded → cold-absent-vacuous', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, channelThreadsKey('c1'));
    const out = ingestMessageProjections(qc, 'c1', {
      threads_list_entry: { entry: threadEntry('root1') },
    });
    expect(out).toEqual<ProjectionDisposition[]>([{ status: 'cold-absent-vacuous' }]);
    unsub();
  });

  it('off-page root (page loaded, root absent) → pending-fallback (no insert)', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, channelThreadsKey('c1'));
    seedThreadsList(qc, 'other-root'); // page holds a different root
    const out = ingestMessageProjections(qc, 'c1', {
      threads_list_entry: { entry: threadEntry('root1') },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('pending-fallback');
    unsub();
  });
});

describe('validateMessageProjections — threads_list_entry root-match (#task:1278)', () => {
  it('keeps the entry only when entry.root_message_id === msg.thread_root_id', () => {
    const patch = { threads_list_entry: { entry: threadEntry('rootA') } };
    expect(validateMessageProjections(patch, replyMsg('rootA')).threads_list_entry).toEqual(
      patch.threads_list_entry,
    );
    // Mismatched root → dropped.
    expect(
      validateMessageProjections(patch, replyMsg('rootB')).threads_list_entry,
    ).toBeUndefined();
    // Non-reply frame → dropped.
    expect(
      validateMessageProjections(patch, nonReplyMsg()).threads_list_entry,
    ).toBeUndefined();
  });

  it('a mismatched entry, once validated, is dropped so the dispatch repositions nothing', () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, channelThreadsKey('c1'));
    seedThreadsList(qc, 'rootB'); // held row for the patch's (wrong) root
    const validated = validateMessageProjections(
      { threads_list_entry: { entry: threadEntry('rootB', 999) } },
      replyMsg('rootA'), // frame is a reply to rootA
    );
    expect(validated.threads_list_entry).toBeUndefined();
    expect(ingestMessageProjections(qc, 'c1', validated)).toEqual([]);
    // rootB row untouched (its seeded reply_count stays 1, not 5).
    expect(
      qc
        .getQueryData<{ threads: { reply_count: number }[] }>(channelThreadsKey('c1'))
        ?.threads[0]?.reply_count,
    ).toBe(1);
    unsub();
  });
});
