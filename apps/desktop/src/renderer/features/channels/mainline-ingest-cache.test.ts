import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type {
  ConversationMessagesDto,
  MessageDto,
  TaskChangedEvent,
} from '@silverhand/shared';
import {
  applyMainlineMessageToChannelCaches,
  applyTaskChangedToChannelCaches,
  mainlineLiveGapKey,
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

describe('applyTaskChangedToChannelCaches', () => {
  it('patches the inline task chip in the main-stream window', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      messagesKey('c1'),
      tailCache([
        message({ id: 't1', seq: 1, task_number: 7, task_status: 'todo' }),
      ]),
    );

    const ev: TaskChangedEvent = {
      kind: 'status',
      workspace_id: 'w1',
      channel_id: 'c1',
      thread_root_id: null,
      legacy_thread_conversation_id: null,
      thread_id: null,
      conversation_id: 'c1',
      task_number: 7,
      message_id: 't1',
      status: 'in_progress',
      assignee: null,
      title: 'do the thing',
      closed_at: null,
    };
    applyTaskChangedToChannelCaches(qc, 'c1', ev);

    const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
      messagesKey('c1'),
    );
    expect(data?.pages[0]?.messages[0]?.task_status).toBe('in_progress');
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

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm1',
    conversation_id: 'c1',
    from_kind: 'user',
    from_agent_id: null,
    from_user_id: 'u1',
    content: 'body',
    metadata: null,
    attachments: null,
    seq: 1,
    created_at: 0,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
    ...overrides,
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
    stream_head_seq: messages.reduce((max, m) => Math.max(max, m.seq), 0),
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
