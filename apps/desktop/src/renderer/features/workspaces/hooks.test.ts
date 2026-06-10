import { describe, expect, it } from 'vitest';
import type { ChannelConversationDto, ThreadDto } from '@silverhand/shared';
import {
  decideViewerSyncInvalidations,
  isViewerWorkspacesChangedPayload,
  sortConversationList,
  type ChannelListItem,
  type ViewerSyncFrame,
} from './hooks';

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

describe('isViewerWorkspacesChangedPayload', () => {
  it('accepts the three documented change variants with a workspace_id', () => {
    for (const change of ['added', 'removed', 'role_changed'] as const) {
      expect(
        isViewerWorkspacesChangedPayload({ change, workspace_id: 'w-1' }),
      ).toBe(true);
    }
    // role is optional and not required for the guard to pass
    expect(
      isViewerWorkspacesChangedPayload({
        change: 'role_changed',
        workspace_id: 'w-1',
        role: 'admin',
      }),
    ).toBe(true);
  });

  it('rejects unknown change values and missing/typed-wrong workspace_id', () => {
    expect(
      isViewerWorkspacesChangedPayload({ change: 'mutated', workspace_id: 'w-1' }),
    ).toBe(false);
    expect(isViewerWorkspacesChangedPayload({ change: 'added' })).toBe(false);
    expect(
      isViewerWorkspacesChangedPayload({ change: 'added', workspace_id: 42 }),
    ).toBe(false);
  });

  it('rejects non-object payloads (no duck-typing)', () => {
    expect(isViewerWorkspacesChangedPayload(null)).toBe(false);
    expect(isViewerWorkspacesChangedPayload(undefined)).toBe(false);
    expect(isViewerWorkspacesChangedPayload('added')).toBe(false);
    expect(isViewerWorkspacesChangedPayload(123)).toBe(false);
  });
});

describe('decideViewerSyncInvalidations', () => {
  const frame = (over: Partial<ViewerSyncFrame>): ViewerSyncFrame => ({
    type: 'event',
    scope: 'viewer:u-1',
    ...over,
  });

  it('invalidates the workspace list on snapshot_required (replay-gap safety)', () => {
    expect(
      decideViewerSyncInvalidations(frame({ type: 'snapshot_required' })),
    ).toEqual([['workspaces']]);
  });

  it('invalidates only the workspace list on add', () => {
    expect(
      decideViewerSyncInvalidations(
        frame({
          kind: 'viewer_workspaces_changed',
          payload: { change: 'added', workspace_id: 'w-1' },
        }),
      ),
    ).toEqual([['workspaces']]);
  });

  it('invalidates only the workspace list on remove', () => {
    expect(
      decideViewerSyncInvalidations(
        frame({
          kind: 'viewer_workspaces_changed',
          payload: { change: 'removed', workspace_id: 'w-1' },
        }),
      ),
    ).toEqual([['workspaces']]);
  });

  it('also invalidates the members query on role_changed (governance viewerRole source)', () => {
    expect(
      decideViewerSyncInvalidations(
        frame({
          kind: 'viewer_workspaces_changed',
          payload: { change: 'role_changed', workspace_id: 'w-1', role: 'admin' },
        }),
      ),
    ).toEqual([['workspaces'], ['workspaces', 'w-1', 'members']]);
  });

  it('ignores other event kinds and malformed payloads', () => {
    expect(
      decideViewerSyncInvalidations(
        frame({ kind: 'unread_updated', payload: { conversation_id: 'c-1' } }),
      ),
    ).toEqual([]);
    expect(
      decideViewerSyncInvalidations(
        frame({ kind: 'viewer_workspaces_changed', payload: { change: 'nope' } }),
      ),
    ).toEqual([]);
    expect(
      decideViewerSyncInvalidations(
        frame({ kind: 'viewer_workspaces_changed', payload: null }),
      ),
    ).toEqual([]);
  });

  it('ignores frame types that are neither event nor snapshot_required', () => {
    expect(decideViewerSyncInvalidations(frame({ type: 'subscribed' }))).toEqual(
      [],
    );
    expect(decideViewerSyncInvalidations(frame({ type: 'ping' }))).toEqual([]);
  });
});
