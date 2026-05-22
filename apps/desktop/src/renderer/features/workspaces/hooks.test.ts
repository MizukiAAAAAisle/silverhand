import { describe, expect, it } from 'vitest';
import type { ChannelConversationDto, ThreadDto } from '@silverhand/shared';
import { sortConversationList, type ChannelListItem } from './hooks';

function channel(
  id: string,
  createdAt: number,
  pinnedAt: number | null,
): ChannelConversationDto {
  return {
    id,
    workspace_id: 'w1',
    workspace_path: '/tmp/w1',
    kind: 'channel',
    parent_conversation_id: null,
    title: id,
    status: 'idle',
    spawned_by_agent_id: null,
    closed_at: null,
    close_summary: null,
    pinned_at: pinnedAt,
    archived_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function thread(
  id: string,
  parentId: string,
  createdAt: number,
): ThreadDto {
  return {
    id,
    workspace_id: 'w1',
    workspace_path: '/tmp/w1',
    kind: 'thread',
    parent_conversation_id: parentId,
    channel_id: parentId,
    anchor_message_id: null,
    title: id,
    status: 'idle',
    spawned_by_agent_id: null,
    closed_at: null,
    close_summary: null,
    pinned_at: null,
    archived_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('sortConversationList', () => {
  it('puts later pinned top-level channels first and keeps threads under parents', () => {
    const first = channel('first', 1, 10);
    const second = channel('second', 2, 20);
    const third = channel('third', 3, null);
    const child = thread('second-thread', second.id, 4);

    const sorted = sortConversationList([
      third,
      child,
      first,
      second,
    ] satisfies ChannelListItem[]);

    expect(sorted.map(item => item.id)).toEqual([
      second.id,
      child.id,
      first.id,
      third.id,
    ]);
  });
});
