import { describe, expect, it, vi } from 'vitest';
import type { ConversationRef, NotificationDto } from '@silverhand/shared';
import { resolveNotificationJumpTarget } from './hooks';

function makeNotification(overrides: Partial<NotificationDto>): NotificationDto {
  return {
    id: 'notif_1',
    kind: 'mention_self',
    user_id: null,
    agent_id: null,
    workspace_id: 'ws_a',
    conversation_id: 'conv_a',
    message_id: 'msg_a',
    source_workspace_id: 'ws_a',
    source_conversation_id: 'conv_a',
    source_message_id: 'msg_a',
    payload: null,
    read_at: null,
    created_at: 0,
    ...overrides,
  };
}

function makeChannelRef(overrides: Partial<ConversationRef> = {}): ConversationRef {
  return {
    id: 'conv_a',
    kind: 'channel',
    title: 'general',
    workspace_id: 'ws_a',
    workspace_kind: 'regular',
    workspace_path: '/tmp/ws_a',
    parent_channel_id: null,
    parent_title: null,
    closed_at: null,
    archived_at: null,
    ...overrides,
  };
}

function makeThreadRef(overrides: Partial<ConversationRef> = {}): ConversationRef {
  return {
    id: 'thread_a',
    kind: 'thread',
    title: 'rfc-thread',
    workspace_id: 'ws_a',
    workspace_kind: 'regular',
    workspace_path: '/tmp/ws_a',
    parent_channel_id: 'conv_a',
    parent_title: 'general',
    closed_at: null,
    archived_at: null,
    ...overrides,
  };
}

/**
 * `resolveNotificationJumpTarget` calls `qc.fetchQuery` to resolve the
 * conversation ref. We mock that method directly — the hook only ever
 * uses `fetchQuery`, so a minimal mock keeps the test isolated from
 * React Query internals.
 */
function mockQc(refByConvId: Record<string, ConversationRef | Error>) {
  const fetchQuery = vi.fn(async (opts: { queryKey: readonly unknown[] }) => {
    const id = opts.queryKey[1] as string;
    const hit = refByConvId[id];
    if (!hit) throw new Error(`no mock for ${id}`);
    if (hit instanceof Error) throw hit;
    return { ref: hit };
  });
  return { fetchQuery } as unknown as Parameters<
    typeof resolveNotificationJumpTarget
  >[1];
}

describe('resolveNotificationJumpTarget', () => {
  it('returns null for agent_start_failed (intentionally inert)', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({ kind: 'agent_start_failed', message_id: null }),
      mockQc({}),
    );
    expect(r).toBeNull();
  });

  it('returns null when mention_self is missing message_id', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({ kind: 'mention_self', message_id: null }),
      mockQc({}),
    );
    expect(r).toBeNull();
  });

  it('returns null when mention_external has no local conversation_id and no source_* fallback', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({
        kind: 'mention_external',
        conversation_id: null,
        message_id: null,
        source_workspace_id: null,
        source_conversation_id: null,
        source_message_id: null,
      }),
      mockQc({}),
    );
    expect(r).toBeNull();
  });

  it('mention_self on a channel: returns {channelId, threadId: null}', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({ kind: 'mention_self', conversation_id: 'conv_a' }),
      mockQc({ conv_a: makeChannelRef() }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_a',
      channelId: 'conv_a',
      threadId: null,
      messageId: 'msg_a',
    });
  });

  it('mention_self on a thread: lifts channelId to parent_channel_id, sets threadId', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({
        kind: 'mention_self',
        conversation_id: 'thread_a',
        message_id: 'msg_x',
      }),
      mockQc({ thread_a: makeThreadRef() }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_a',
      channelId: 'conv_a',
      threadId: 'thread_a',
      messageId: 'msg_x',
    });
  });

  it('mention_external jumps to the local Mentions DM at the wrapped message (not source)', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({
        kind: 'mention_external',
        // Local conversation = the synthesized DM Mentions channel.
        // After D-flip this is the primary jump target — that's where
        // the agent will reply and where the user's continued
        // conversation lives.
        workspace_id: 'ws_dm_agent',
        conversation_id: 'dm_mentions',
        message_id: 'wrap_msg',
        source_workspace_id: 'ws_remote',
        source_conversation_id: 'conv_remote',
        source_message_id: 'msg_remote',
      }),
      mockQc({
        dm_mentions: makeChannelRef({
          id: 'dm_mentions',
          kind: 'dm_channel',
          workspace_id: 'ws_dm_agent',
        }),
      }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_dm_agent',
      channelId: 'dm_mentions',
      threadId: null,
      messageId: 'wrap_msg',
    });
  });

  it('mention_external falls back to source coords for legacy rows missing local conversation_id', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({
        kind: 'mention_external',
        // Pre-flip artifact rows: conversation_id/message_id may be
        // null if the wrapped message insert never happened (drop path)
        // or if the row predates the local-DM wiring entirely.
        workspace_id: null,
        conversation_id: null,
        message_id: null,
        source_workspace_id: 'ws_remote',
        source_conversation_id: 'conv_remote',
        source_message_id: 'msg_remote',
      }),
      mockQc({
        conv_remote: makeChannelRef({
          id: 'conv_remote',
          workspace_id: 'ws_remote',
        }),
      }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_remote',
      channelId: 'conv_remote',
      threadId: null,
      messageId: 'msg_remote',
    });
  });

  it('mention_external on a foreign thread (legacy fallback): lifts to source workspace parent', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({
        kind: 'mention_external',
        workspace_id: null,
        conversation_id: null,
        message_id: null,
        source_workspace_id: 'ws_remote',
        source_conversation_id: 'thread_remote',
        source_message_id: 'msg_remote',
      }),
      mockQc({
        thread_remote: makeThreadRef({
          id: 'thread_remote',
          parent_channel_id: 'parent_remote',
          workspace_id: 'ws_remote',
        }),
      }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_remote',
      channelId: 'parent_remote',
      threadId: 'thread_remote',
      messageId: 'msg_remote',
    });
  });

  it('falls back to top-level channelId when conversation-ref fetch fails', async () => {
    const r = await resolveNotificationJumpTarget(
      makeNotification({ kind: 'mention_self', conversation_id: 'conv_a' }),
      mockQc({ conv_a: new Error('500 Internal') }),
    );
    expect(r).toEqual({
      workspaceId: 'ws_a',
      channelId: 'conv_a',
      threadId: null,
      messageId: 'msg_a',
    });
  });
});
