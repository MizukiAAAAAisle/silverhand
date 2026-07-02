import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { ConversationMessagesDto, MessageDto } from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  applyClusterMessageToCaches,
  applyThreadFollowersMessage,
  applyThreadRootReplyBump,
  clusterLiveGapKey,
  clusterMessagesKey,
  threadRootKey,
} from './hooks';

// #task:1255 Stage-2 P1b — move of the useThreadCluster / useThreadRoot /
// useThreadFollowers `onEvent` cache writes into helpers the central ingestor
// calls. Cluster filter + tail/gap/dedup and the follower invalidation filter
// are a verbatim P1 prep move; the root reply-count is now an AUTHORITATIVE
// recovery/invalidate (#1263 (c)) — no optimistic +1, replay-safe.

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

describe('applyThreadRootReplyBump — #1263 (c)', () => {
  it('recovers the count AUTHORITATIVELY (invalidate) for non-system replies — no +1', () => {
    const qc = new QueryClient();
    qc.setQueryData(threadRootKey('c1', 'root1'), rootDto('root1', 4));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const eff = applyThreadRootReplyBump(
      qc,
      'c1',
      'root1',
      message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
    );

    const data = qc.getQueryData<ConversationMessagesDto>(
      threadRootKey('c1', 'root1'),
    );
    expect(data?.reply_counts_by_root.root1).toBe(4); // no blind +1
    expect(spy).toHaveBeenCalledWith({ queryKey: threadRootKey('c1', 'root1') });
    expect(eff).not.toBeNull(); // a satisfaction promise (settles on refetch)
  });

  it('is null (no invalidate) for system replies and rows for other roots', () => {
    const qc = new QueryClient();
    qc.setQueryData(threadRootKey('c1', 'root1'), rootDto('root1', 4));
    const spy = vi.spyOn(qc, 'invalidateQueries');

    expect(
      applyThreadRootReplyBump(
        qc,
        'c1',
        'root1',
        message({ id: 's1', seq: 2, thread_root_id: 'root1', from_kind: 'system' }),
      ),
    ).toBeNull();
    expect(
      applyThreadRootReplyBump(
        qc,
        'c1',
        'root1',
        message({ id: 'r2', seq: 3, thread_root_id: 'root2' }),
      ),
    ).toBeNull();

    expect(spy).not.toHaveBeenCalled();
    const data = qc.getQueryData<ConversationMessagesDto>(
      threadRootKey('c1', 'root1'),
    );
    expect(data?.reply_counts_by_root.root1).toBe(4); // unchanged
  });

  it('is null when the root row is not cached (authoritative on its own fetch)', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    expect(
      applyThreadRootReplyBump(
        qc,
        'c1',
        'root1',
        message({ id: 'r1', seq: 2, thread_root_id: 'root1' }),
      ),
    ).toBeNull();
    expect(spy).not.toHaveBeenCalled();
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
    content: 'body',
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq ?? 1),
    created_at: 0,
    thread_root_id: null,
    task_number: null,
    task_status: null,
    task_title: null,
    task_workspace_id: null,
    task_closed_at: null,
    task_assignee: null,
    reactions: null,
    ...rest,
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
    stream_head_seq: decodeMessageSeq(
      messages.reduce((max, m) => Math.max(max, m.seq), 0),
    ),
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
    stream_head_seq: decodeMessageSeq(1),
  };
}
