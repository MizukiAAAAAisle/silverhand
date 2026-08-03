import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type {
  ConversationMessagesDto,
  MessageDto,
  ThreadReplyPreviewRow,
} from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  applyMainlineMessageToChannelCaches,
  applyTaskChangedToMessage,
  mainlineLiveGapKey,
  mergeMainlineReplyPreview,
  messagesKey,
  reconcileChannelMainlineOnSnapshotRequired,
} from './hooks';

// #task:1255 Stage-2 P1a — these cache writers used to live inside
// `useChannelMessages.onEvent`; the central conversation ingestor now drives
// them. The behavior must be a VERBATIM move (P1 = prep, not a semantic
// change), so this exercises the three mainline branches + cross-channel
// isolation + id-dedup against a real `QueryClient`.

function gap(qc: QueryClient, channelId: string): boolean {
  return qc.getQueryData<boolean>(mainlineLiveGapKey(channelId)) ?? false;
}

function cachedIds(qc: QueryClient, channelId: string): string[] {
  const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
    messagesKey(channelId),
  );
  return (data?.pages ?? []).flatMap(p => p.messages.map(m => m.id));
}

describe('applyMainlineMessageToChannelCaches — mainline row', () => {
  it('appends at tail (window reaches the conversation head)', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), tailCache([message({ id: 'm1', seq: 1 })]));

    applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({ id: 'm2', seq: 2 }),
    );

    expect(cachedIds(qc, 'c1')).toEqual(['m1', 'm2']);
    expect(gap(qc, 'c1')).toBe(false);
  });

  it('sets the live-gap fact instead of appending when NOT at tail', () => {
    const qc = new QueryClient();
    // A mid-history window: `has_more_after` true → the cached tail is not the
    // conversation tail, so a live row must not be appended (it would lie about
    // an ordered, contiguous window).
    qc.setQueryData(
      messagesKey('c1'),
      midHistoryCache([message({ id: 'm1', seq: 1 })]),
    );

    applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({ id: 'm2', seq: 9 }),
    );

    expect(cachedIds(qc, 'c1')).toEqual(['m1']); // no append
    expect(gap(qc, 'c1')).toBe(true);
  });

  it('de-dupes by id on overlapping replay (no double-insert)', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), tailCache([message({ id: 'm1', seq: 1 })]));

    applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({ id: 'm1', seq: 1 }),
    );

    expect(cachedIds(qc, 'c1')).toEqual(['m1']);
  });

  it('isolates channels — a c1 frame never touches c2', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), tailCache([message({ id: 'm1', seq: 1 })]));
    qc.setQueryData(messagesKey('c2'), tailCache([message({ id: 'n1', seq: 1 })]));

    applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({ id: 'm2', seq: 2 }),
    );

    expect(cachedIds(qc, 'c1')).toEqual(['m1', 'm2']);
    expect(cachedIds(qc, 'c2')).toEqual(['n1']); // untouched
  });
});

describe('applyMainlineMessageToChannelCaches — reply (thread_root_id set), #1263 (c)', () => {
  it('recovers the badge AUTHORITATIVELY (invalidate) — no optimistic +1 — and never enters the stream', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      tailCache([message({ id: 'root1', seq: 1 })], { root1: 0 }),
    );
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const eff = applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({ id: 'reply1', seq: 2, thread_root_id: 'root1' }),
    );

    // (c): the count is NOT locally bumped — it refetches authoritatively (the
    // old blind +1 was non-idempotent and double-counted on replay).
    const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
      messagesKey('c1'),
    );
    expect(data?.pages[0]?.reply_counts_by_root.root1).toBe(0); // no +1
    expect(spy).toHaveBeenCalledWith({ queryKey: messagesKey('c1') });
    expect(eff).not.toBeNull(); // a satisfaction promise (settles on refetch)
    // ...and the reply never enters the main stream.
    expect(cachedIds(qc, 'c1')).toEqual(['root1']);
  });

  it('is a no-op (null, no invalidate) for a reply to an OFF-window root', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), tailCache([message({ id: 'root1', seq: 1 })]));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const eff = applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      // rootX is not on any loaded page → the badge isn't displayed; a fresh
      // count arrives when the window paginates to it.
      message({ id: 'reply1', seq: 2, thread_root_id: 'rootX' }),
    );

    expect(eff).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips the badge recovery for system replies (null, no invalidate)', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      tailCache([message({ id: 'root1', seq: 1 })], { root1: 3 }),
    );
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const eff = applyMainlineMessageToChannelCaches(
      qc,
      'c1',
      message({
        id: 'sys1',
        seq: 2,
        thread_root_id: 'root1',
        from_kind: 'system',
      }),
    );

    expect(eff).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
      messagesKey('c1'),
    );
    expect(data?.pages[0]?.reply_counts_by_root.root1).toBe(3); // unchanged
  });
});

describe('applyTaskChangedToMessage (the one task-chip merge helper)', () => {
  it('sets an absolute linked_task snapshot on the source message from the event', () => {
    // The projection fan-out that used to live in `applyTaskChangedToChannelCaches`
    // / `applyClusterTaskChangedToCaches` moved into the message-row patch seam
    // (`patchMessageInActiveProjections`, #task:1270); its event×projection×reader
    // coverage lives in the ingestor's "message-row patch seam" matrix. This keeps
    // the ONE merge helper the seam carries as its `patchRow`. The snapshot is
    // ABSOLUTE (build-from-null, replay-idempotent), not a delta over the prior chip.
    const out = applyTaskChangedToMessage(
      message({
        id: 't1',
        seq: 1,
        linked_task: {
          task_id: 'task-7',
          task_number: 7,
          title: 'old',
          status: 'todo',
          assignee: null,
        },
      }),
      {
        kind: 'status',
        workspace_id: 'w1',
        channel_id: 'c1',
        thread_root_id: null,
        conversation_id: 'c1',
        task_number: 7,
        task_id: 'task-7',
        source_message_id: 't1',
        status: 'in_progress',
        assignee: null,
        title: 'do the thing',
        closed_at: null,
      },
    );
    expect(out.linked_task).toEqual({
      task_id: 'task-7',
      task_number: 7,
      title: 'do the thing',
      status: 'in_progress',
      assignee: null,
    });
  });
});

describe('mergeMainlineReplyPreview — inline reply-preview tail (#task:1745)', () => {
  /** A tail window that already carries `rootId`'s displayed preview tail. */
  function cacheWithPreviewTail(rows: ThreadReplyPreviewRow[]) {
    const page: ConversationMessagesDto = {
      ...windowDto([message({ id: 'root1', seq: 1 })], { root1: rows.length }, false),
      reply_previews_by_root: { root1: rows },
    };
    return { pages: [page], pageParams: [undefined] };
  }

  /** A tail window whose read model PROJECTS previews (the object is present)
   *  but where `root1` has no key yet — the authoritative "no eligible reply
   *  yet" state, because the read model builds the map over every non-system
   *  top-level message on the page, not only the ones with replies. */
  function cacheProjectingPreviews(rows: MessageDto[] = [message({ id: 'root1', seq: 1 })]) {
    const page: ConversationMessagesDto = {
      ...windowDto(rows, {}, false),
      reply_previews_by_root: {},
    };
    return { pages: [page], pageParams: [undefined] };
  }

  function tailOf(qc: QueryClient): ThreadReplyPreviewRow[] | undefined {
    return qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
      messagesKey('c1'),
    )?.pages[0]?.reply_previews_by_root?.root1;
  }

  const existing: ThreadReplyPreviewRow = {
    message_id: 'reply1',
    seq: decodeMessageSeq(2),
    author: {
      status: 'active',
      kind: 'user',
      id: 'u1',
      name: 'User',
      display_name: 'User',
      avatar_url: null,
      runtime: null,
    },
    preview: 'first',
    attachment_count: 0,
    first_attachment_label: null,
  };

  const row = (messageId: string, seq: number): ThreadReplyPreviewRow => ({
    ...existing,
    message_id: messageId,
    seq: decodeMessageSeq(seq),
  });

  it('appends the frame’s own row when the root has a displayed tail', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cacheWithPreviewTail([existing]));

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({
        id: 'reply2',
        seq: 3,
        thread_root_id: 'root1',
        from_kind: 'agent',
        from_agent_id: 'a1',
        from_user_id: null,
        author: {
          status: 'active',
          kind: 'agent',
          id: 'a1',
          name: 'Agent',
          display_name: 'Agent',
          avatar_url: null,
          runtime: 'claude',
        },
        content: '  second\n\nreply  ',
      }),
    );

    expect(merged).toBe(true);
    expect(tailOf(qc)).toEqual([
      existing,
      {
        message_id: 'reply2',
        seq: decodeMessageSeq(3),
        // The preview row carries the reply frame's server-authoritative author
        // DTO verbatim (#task:1792) — the same resolved identity the byline uses.
        author: {
          status: 'active',
          kind: 'agent',
          id: 'a1',
          name: 'Agent',
          display_name: 'Agent',
          avatar_url: null,
          runtime: 'claude',
        },
        // Whitespace-compacted + trimmed, mirroring the read model.
        preview: 'second reply',
        attachment_count: 0,
        first_attachment_label: null,
      },
    ]);
  });

  it('is a no-op when the read model projects NO previews at all', () => {
    const qc = new QueryClient();
    // The window holds the root and its count but carries no
    // `reply_previews_by_root` object — nothing can be displayed for any root
    // here, so a live frame has nothing to patch and a refetch would not help.
    qc.setQueryData(messagesKey('c1'), tailCache([message({ id: 'root1', seq: 1 })], { root1: 1 }));

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({ id: 'reply1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(merged).toBe(false);
    expect(tailOf(qc)).toBeUndefined();
  });

  it('seeds the FIRST row when the page projects previews but this root has none', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cacheProjectingPreviews());

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({ id: 'reply1', seq: 2, thread_root_id: 'root1' }),
    );

    // The 0→1 reply is the most common case: the count patch suppresses the
    // window refetch, so without this the badge would say "1 reply" over an
    // empty block until something else happened to refetch.
    expect(merged).toBe(true);
    expect(tailOf(qc)?.map(r => r.message_id)).toEqual(['reply1']);
  });

  it('does NOT seed a root the page does not display as an eligible root', () => {
    const qc = new QueryClient();
    // Previews are projected, but `rootX` is on no loaded page — the read model
    // never spoke about it, so its tail is unknown rather than empty.
    qc.setQueryData(messagesKey('c1'), cacheProjectingPreviews());

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'rootX',
      message({ id: 'reply1', seq: 2, thread_root_id: 'rootX' }),
    );

    expect(merged).toBe(false);
    expect(
      qc.getQueryData<{ pages: ConversationMessagesDto[] }>(messagesKey('c1'))
        ?.pages[0]?.reply_previews_by_root,
    ).toEqual({});
  });

  it('does NOT seed a SYSTEM root — it mirrors the read model’s own filter', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      // A system message can be a top-level row, but the read model excludes it
      // from `rootIds`, so it displays neither a badge nor a tail; seeding one
      // would show lines that the next fetch removes (a row-height jump).
      cacheProjectingPreviews([
        message({ id: 'root1', seq: 1, from_kind: 'system', from_user_id: null }),
      ]),
    );

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({ id: 'reply1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(merged).toBe(false);
    expect(tailOf(qc)).toBeUndefined();
  });

  it('stays BOUNDED at three rows — the oldest leaves as a new reply lands', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      cacheWithPreviewTail([
        row('reply1', 2),
        row('reply2', 3),
        row('reply3', 4),
      ]),
    );

    for (const seq of [5, 6]) {
      mergeMainlineReplyPreview(
        qc,
        'c1',
        'root1',
        message({ id: `reply${seq}`, seq, thread_root_id: 'root1' }),
      );
    }

    // The cache — not just the reader — holds exactly what a fetch would return.
    expect(tailOf(qc)?.map(r => r.message_id)).toEqual([
      'reply3',
      'reply5',
      'reply6',
    ]);
  });

  it('orders an out-of-order frame by seq, and drops it when it is older than the tail', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      cacheWithPreviewTail([row('reply2', 3), row('reply4', 5)]),
    );

    // Arrives late but belongs in the middle: `seq` is immutable insert order,
    // so it is placed by seq rather than at the end.
    mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({ id: 'reply3', seq: 4, thread_root_id: 'root1' }),
    );
    // Older than all three → converging keeps the three most recent.
    mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({ id: 'reply1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(tailOf(qc)?.map(r => r.message_id)).toEqual([
      'reply2',
      'reply3',
      'reply4',
    ]);
  });

  it('is idempotent on replay (same message_id is not appended twice)', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cacheWithPreviewTail([existing]));
    const frame = message({ id: 'reply2', seq: 3, thread_root_id: 'root1' });

    mergeMainlineReplyPreview(qc, 'c1', 'root1', frame);
    mergeMainlineReplyPreview(qc, 'c1', 'root1', frame);

    expect(tailOf(qc)?.map(r => r.message_id)).toEqual(['reply1', 'reply2']);
  });

  it('skips system replies — eligibility mirrors the reply count', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cacheWithPreviewTail([existing]));

    const merged = mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({
        id: 'sys1',
        seq: 3,
        thread_root_id: 'root1',
        from_kind: 'system',
        from_user_id: null,
      }),
    );

    expect(merged).toBe(false);
    expect(tailOf(qc)).toEqual([existing]);
  });

  it('labels the first attachment through the shared canonical resolver', () => {
    const qc = new QueryClient();
    qc.setQueryData(messagesKey('c1'), cacheWithPreviewTail([existing]));

    mergeMainlineReplyPreview(
      qc,
      'c1',
      'root1',
      message({
        id: 'reply2',
        seq: 3,
        thread_root_id: 'root1',
        content: '',
        attachments: [
          {
            id: 'att1',
            filename: 'shot.png',
            content_type: 'image/png',
            size: 10,
          },
          {
            id: 'att2',
            filename: 'notes.pdf',
            content_type: 'application/pdf',
            size: 20,
          },
        ],
      }),
    );

    const appended = tailOf(qc)?.[1];
    expect(appended?.attachment_count).toBe(2);
    // Canonical label of the FIRST attachment, resolved over the whole list —
    // the same string the message body references, never the filename.
    expect(appended?.first_attachment_label).toBe('Image #1');
  });
});

describe('reconcileChannelMainlineOnSnapshotRequired', () => {
  it('clears the live-gap fact (window will be re-fetched from latest)', () => {
    const qc = new QueryClient();
    qc.setQueryData(mainlineLiveGapKey('c1'), true);

    reconcileChannelMainlineOnSnapshotRequired(qc, 'c1');

    expect(gap(qc, 'c1')).toBe(false);
  });
});

function message(
  overrides: Partial<Omit<MessageDto, 'seq'>> & { seq?: number } = {},
): MessageDto {
  const { seq, ...rest } = overrides;
  return {
    id: 'm1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    author: {
      status: 'active',
      kind: 'user',
      id: 'u1',
      name: 'User',
      display_name: 'User',
      avatar_url: null,
      runtime: null,
    },
    content: 'body',
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq ?? 1),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
    ...rest,
  };
}

function windowDto(
  messages: MessageDto[],
  replyCounts: Record<string, number>,
  hasMoreAfter: boolean,
): ConversationMessagesDto {
  return {
    messages,
    reply_counts_by_root: replyCounts,
    has_more_before: false,
    has_more_after: hasMoreAfter,
    // Tail head = latest seq; the actual value only matters relative to
    // `has_more_after`, which is what `lastPageIsTail` keys off.
    stream_head_seq: decodeMessageSeq(
      messages.reduce((max, m) => Math.max(max, m.seq), 0),
    ),
  };
}

/** A window that reaches the conversation tail (`has_more_after: false`). */
function tailCache(
  messages: MessageDto[],
  replyCounts: Record<string, number> = {},
) {
  return {
    pages: [windowDto(messages, replyCounts, false)],
    pageParams: [undefined],
  };
}

/** A mid-history window (`has_more_after: true`) — not at the tail. */
function midHistoryCache(
  messages: MessageDto[],
  replyCounts: Record<string, number> = {},
) {
  return {
    pages: [windowDto(messages, replyCounts, true)],
    pageParams: [undefined],
  };
}
