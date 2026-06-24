import { describe, expect, it } from 'vitest';
import type {
  ChannelConversationDto,
  ThreadDto,
  ViewerSortStateDto,
  WorkspaceHumanMemberDto,
  WorkspaceMembersResponse,
} from '@silverhand/shared';
import {
  decideViewerSyncInvalidations,
  isViewerWorkspacesChangedPayload,
  patchHumanMemberRole,
  removeHumanMemberFromList,
  setStarredOptimistic,
  sortConversationList,
  type ChannelListItem,
  type ViewerSyncFrame,
} from './hooks';

function channel(
  id: string,
  createdAt: number,
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
    archived_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

describe('sortConversationList', () => {
  it('orders top-level channels by created_at and keeps threads under parents', () => {
    // Star is no longer a shared field on the conversation (#task:1209), so the
    // base sort is creation-time only; starred grouping is composed in
    // ChannelsSidebar against the viewer's sort state, not here.
    const first = channel('first', 1);
    const second = channel('second', 2);
    const third = channel('third', 3);
    const child = thread('second-thread', second.id, 4);

    const sorted = sortConversationList([
      third,
      child,
      first,
      second,
    ] satisfies ChannelListItem[]);

    expect(sorted.map(item => item.id)).toEqual([
      first.id,
      second.id,
      child.id,
      third.id,
    ]);
  });
});

describe('setStarredOptimistic', () => {
  const vs = (entries: ViewerSortStateDto['entries']): ViewerSortStateDto => ({
    list_key: 'workspaces',
    modes: {},
    entries,
  });

  it('stars an entity and clears its manual rank (mirrors backend setStarred)', () => {
    // A ranked row that gets starred must drop its old-group rank in the SAME
    // optimistic write, or it would land by its stale rank for one frame then
    // snap to the manual tail when the server reconciles (the double jump Cindy
    // flagged). starred_at becomes non-null; rank → null; last_accessed_at kept.
    const next = setStarredOptimistic(
      vs([{ entity_id: 'a', rank: 3, last_accessed_at: 100, starred_at: null }]),
      'a',
      true,
    );
    expect(next.entries[0]).toMatchObject({
      entity_id: 'a',
      rank: null,
      last_accessed_at: 100,
    });
    expect(next.entries[0]?.starred_at).not.toBeNull();
  });

  it('unstars an entity and also clears its manual rank', () => {
    const next = setStarredOptimistic(
      vs([{ entity_id: 'a', rank: 2, last_accessed_at: null, starred_at: 999 }]),
      'a',
      false,
    );
    expect(next.entries[0]).toEqual({
      entity_id: 'a',
      rank: null,
      last_accessed_at: null,
      starred_at: null,
    });
  });

  it('creates a rank-null entry when the viewer had no prior state', () => {
    const next = setStarredOptimistic(vs([]), 'b', true);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({
      entity_id: 'b',
      rank: null,
      last_accessed_at: null,
    });
    expect(next.entries[0]?.starred_at).not.toBeNull();
  });

  it('leaves other entries untouched', () => {
    const next = setStarredOptimistic(
      vs([
        { entity_id: 'a', rank: 1, last_accessed_at: null, starred_at: null },
        { entity_id: 'b', rank: 2, last_accessed_at: null, starred_at: null },
      ]),
      'a',
      true,
    );
    expect(next.entries[1]).toEqual({
      entity_id: 'b',
      rank: 2,
      last_accessed_at: null,
      starred_at: null,
    });
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

describe('patchHumanMemberRole', () => {
  const human = (
    userId: string,
    role: WorkspaceHumanMemberDto['role'],
  ): WorkspaceHumanMemberDto => ({
    id: userId,
    name: userId,
    display_name: userId,
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    workspace_id: 'w-1',
    user_id: userId,
    joined_at: 0,
    role,
  });

  const base: WorkspaceMembersResponse = {
    members: [],
    human_members: [human('u-owner', 'owner'), human('u-a', 'member')],
    viewer_role: 'owner',
  };

  it('sets only the targeted member role and leaves the rest untouched', () => {
    const next = patchHumanMemberRole(base, 'u-a', 'admin');
    expect(next.human_members.map(h => [h.user_id, h.role])).toEqual([
      ['u-owner', 'owner'],
      ['u-a', 'admin'],
    ]);
  });

  it('does not mutate the input (new objects for changed rows)', () => {
    const next = patchHumanMemberRole(base, 'u-a', 'admin');
    expect(base.human_members[1]?.role).toBe('member');
    expect(next).not.toBe(base);
    expect(next.human_members[1]).not.toBe(base.human_members[1]);
    // Unchanged row keeps its identity (cheap referential equality).
    expect(next.human_members[0]).toBe(base.human_members[0]);
  });

  it('is a no-op shape when the userId is not present', () => {
    const next = patchHumanMemberRole(base, 'nobody', 'admin');
    expect(next.human_members).toEqual(base.human_members);
  });
});

describe('removeHumanMemberFromList', () => {
  const human = (userId: string): WorkspaceHumanMemberDto => ({
    id: userId,
    name: userId,
    display_name: userId,
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    workspace_id: 'w-1',
    user_id: userId,
    joined_at: 0,
    role: 'member',
  });

  const base: WorkspaceMembersResponse = {
    members: [],
    human_members: [human('u-owner'), human('u-a'), human('u-b')],
    viewer_role: 'owner',
  };

  it('drops only the targeted human and keeps the rest', () => {
    const next = removeHumanMemberFromList(base, 'u-a');
    expect(next.human_members.map(h => h.user_id)).toEqual(['u-owner', 'u-b']);
  });

  it('does not mutate the input', () => {
    const next = removeHumanMemberFromList(base, 'u-a');
    expect(base.human_members).toHaveLength(3);
    expect(next).not.toBe(base);
    expect(next.human_members).not.toBe(base.human_members);
  });

  it('is a no-op shape when the userId is not present', () => {
    const next = removeHumanMemberFromList(base, 'nobody');
    expect(next.human_members.map(h => h.user_id)).toEqual([
      'u-owner',
      'u-a',
      'u-b',
    ]);
  });
});
