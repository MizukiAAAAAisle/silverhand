import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type {
  ConversationMessagesDto,
  MessageDto,
  TaskChangedEvent,
} from '@silverhand/shared';
import {
  applyClusterMessageToCaches,
  applyClusterTaskChangedToCaches,
  applyThreadFollowersMessage,
  applyThreadRootReplyBump,
  clusterLiveGapKey,
  clusterMessagesKey,
  threadRootKey,
} from './hooks';

// #task:1255 Stage-2 P1b — verbatim move of the useThreadCluster /
// useThreadRoot / useThreadFollowers `onEvent` cache writes into helpers the
// central ingestor calls. P1 = prep, so behavior is preserved exactly: cluster
// filter + tail/gap/dedup, root reply-count bump (cut3-6 semantics), follower
// invalidation filter.

function clusterGap(qc: QueryClient, cid: string, root: string): boolean {
  return qc.getQueryData<boolean>(clusterLiveGapKey(cid, root)) ?? false;
}

function clusterIds(qc: QueryClient, cid: string, root: string): string[] {
  const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
    clusterMessagesKey(cid, root),
  );
  return (data?.pages ?? []).flatMap(p => p.messages.map(m => m.id));
}

describe('applyClusterMessageToCaches', () => {
  it('appends a reply to this cluster at tail', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      tailCache([message({ id: 'root1', seq: 1 })]),
    );

    applyClusterMessageToCaches(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(clusterIds(qc, 'c1', 'root1')).toEqual(['root1', 'r1']);
    expect(clusterGap(qc, 'c1', 'root1')).toBe(false);
  });

  it('ignores a row that is not part of this cluster', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      tailCache([message({ id: 'root1', seq: 1 })]),
    );

    applyClusterMessageToCaches(
      qc,
      'c1',
      'root1',
      message({ id: 'r2', seq: 2, thread_root_id: 'root2' }),
    );

    expect(clusterIds(qc, 'c1', 'root1')).toEqual(['root1']);
  });

  it('sets the cluster live-gap instead of appending when not at tail', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      midHistoryCache([message({ id: 'root1', seq: 1 })]),
    );

    applyClusterMessageToCaches(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 9, thread_root_id: 'root1' }),
    );

    expect(clusterIds(qc, 'c1', 'root1')).toEqual(['root1']); // no append
    expect(clusterGap(qc, 'c1', 'root1')).toBe(true);
  });

  it('de-dupes by id on overlapping replay', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      tailCache([
        message({ id: 'root1', seq: 1 }),
        message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
      ]),
    );

    applyClusterMessageToCaches(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(clusterIds(qc, 'c1', 'root1')).toEqual(['root1', 'r1']);
  });
});

describe('applyClusterTaskChangedToCaches', () => {
  it('patches the inline task chip in the cluster window', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      clusterMessagesKey('c1', 'root1'),
      tailCache([
        message({
          id: 't1',
          seq: 2,
          thread_root_id: 'root1',
          task_number: 7,
          task_status: 'todo',
        }),
      ]),
    );

    applyClusterTaskChangedToCaches(qc, 'c1', 'root1', taskEvent('t1'));

    const data = qc.getQueryData<{ pages: ConversationMessagesDto[] }>(
      clusterMessagesKey('c1', 'root1'),
    );
    expect(data?.pages[0]?.messages[0]?.task_status).toBe('in_progress');
  });
});

describe('applyThreadRootReplyBump', () => {
  it('bumps the authoritative reply count for non-system replies', () => {
    const qc = new QueryClient();
    qc.setQueryData(threadRootKey('c1', 'root1'), rootDto('root1', 4));

    applyThreadRootReplyBump(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );

    const data = qc.getQueryData<ConversationMessagesDto>(
      threadRootKey('c1', 'root1'),
    );
    expect(data?.reply_counts_by_root.root1).toBe(5);
  });

  it('skips system replies and rows for other roots', () => {
    const qc = new QueryClient();
    qc.setQueryData(threadRootKey('c1', 'root1'), rootDto('root1', 4));

    applyThreadRootReplyBump(
      qc,
      'c1',
      'root1',
      message({ id: 's1', seq: 2, thread_root_id: 'root1', from_kind: 'system' }),
    );
    applyThreadRootReplyBump(
      qc,
      'c1',
      'root1',
      message({ id: 'r2', seq: 3, thread_root_id: 'root2' }),
    );

    const data = qc.getQueryData<ConversationMessagesDto>(
      threadRootKey('c1', 'root1'),
    );
    expect(data?.reply_counts_by_root.root1).toBe(4); // unchanged
  });

  it('no-ops when the root row is not cached', () => {
    const qc = new QueryClient();
    applyThreadRootReplyBump(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );
    expect(qc.getQueryData(threadRootKey('c1', 'root1'))).toBeUndefined();
  });
});

describe('applyThreadFollowersMessage', () => {
  it('invalidates the follower snapshot for a reply to this root', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    applyThreadFollowersMessage(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );

    expect(spy).toHaveBeenCalledWith({
      queryKey: ['channels', 'c1', 'thread-followers', 'root1'],
    });
  });

  it('does not invalidate for an unrelated row', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    applyThreadFollowersMessage(
      qc,
      'c1',
      'root1',
      message({ id: 'r2', seq: 2, thread_root_id: 'root2' }),
    );

    expect(spy).not.toHaveBeenCalled();
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
  hasMoreAfter: boolean,
): ConversationMessagesDto {
  return {
    messages,
    reply_counts_by_root: {},
    has_more_before: false,
    has_more_after: hasMoreAfter,
    stream_head_seq: messages.reduce((max, m) => Math.max(max, m.seq), 0),
  };
}

function tailCache(messages: MessageDto[]) {
  return { pages: [windowDto(messages, false)], pageParams: [undefined] };
}

function midHistoryCache(messages: MessageDto[]) {
  return { pages: [windowDto(messages, true)], pageParams: [undefined] };
}

function rootDto(rootId: string, count: number): ConversationMessagesDto {
  return {
    messages: [
      {
        ...message({ id: rootId, seq: 1 }),
      },
    ],
    reply_counts_by_root: { [rootId]: count },
    has_more_before: false,
    has_more_after: false,
    stream_head_seq: 1,
  };
}

function taskEvent(messageId: string): TaskChangedEvent {
  return {
    kind: 'status',
    workspace_id: 'w1',
    channel_id: 'c1',
    thread_root_id: 'root1',
    legacy_thread_conversation_id: null,
    thread_id: null,
    conversation_id: 'c1',
    task_number: 7,
    message_id: messageId,
    status: 'in_progress',
    assignee: null,
    title: 'do the thing',
    closed_at: null,
  };
}
