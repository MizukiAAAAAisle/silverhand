import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type {
  ChannelConversationDto,
  ViewerSortStateDto,
  WorkspaceHumanMemberDto,
  WorkspaceMembersResponse,
} from '@silverhand/shared';
import {
  applyOrderToViewerSort,
  decideViewerSyncInvalidations,
  isViewerWorkspacesChangedPayload,
  patchHumanMemberRole,
  removeHumanMemberFromList,
  setStarredOptimistic,
  sortCacheAdapter,
  sortConversationList,
  type ChannelListItem,
  type ViewerSyncFrame,
} from './hooks';
import { favoritesKey } from '../favorites/hooks';

function channel(
  id: string,
  createdAt: number,
): ChannelConversationDto {
  return {
    id,
    workspace_id: 'w1',
    workspace_path: '/tmp/w1',
    kind: 'channel',
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
  it('orders channels by created_at', () => {
    // Star is no longer a shared field on the conversation (#task:1209), so the
    // base sort is creation-time only. Under the exclusive model (#task:1254) a
    // starred channel is moved to STARRED and excluded from the channel sidebar's
    // single `unstarred` home group (composed in ChannelsSidebar), not here.
    const first = channel('first', 1);
    const second = channel('second', 2);
    const third = channel('third', 3);

    const sorted = sortConversationList([
      third,
      first,
      second,
    ] satisfies ChannelListItem[]);

    expect(sorted.map(item => item.id)).toEqual([
      first.id,
      second.id,
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

  it('workspace/DM star stamps starred_at and PRESERVES the home rank (exclusive move)', () => {
    // Workspace/DM star is an EXCLUSIVE MOVE into the global STARRED list (a
    // different list_key), so the home rank survives as an orphan and unstar
    // restores the original slot. clearRank defaults false.
    const next = setStarredOptimistic(
      vs([{ entity_id: 'a', rank: 3, last_accessed_at: 100, starred_at: null }]),
      'a',
      true,
    );
    expect(next.entries[0]).toMatchObject({
      entity_id: 'a',
      rank: 3,
      last_accessed_at: 100,
    });
    expect(next.entries[0]?.starred_at).not.toBeNull();
  });

  it('workspace/DM unstar nulls starred_at and PRESERVES the home rank (restores original slot)', () => {
    const next = setStarredOptimistic(
      vs([{ entity_id: 'a', rank: 5, last_accessed_at: 7, starred_at: 999 }]),
      'a',
      false,
    );
    expect(next.entries[0]).toEqual({
      entity_id: 'a',
      rank: 5,
      last_accessed_at: 7,
      starred_at: null,
    });
  });

  it('channel star CLEARS the home rank (cross-hard-group move; clearRank=true)', () => {
    // Channel star crosses this sidebar's starred|unstarred hard groups within the
    // SAME list. A single rank is meaningful only inside one group, so it must be
    // cleared — the channel enters the new group unranked (recent/created_at
    // tiebreak) and the user can drag it there (#task:1210 rank P1).
    const next = setStarredOptimistic(
      vs([{ entity_id: 'c', rank: 4, last_accessed_at: 100, starred_at: null }]),
      'c',
      true,
      true,
    );
    expect(next.entries[0]).toMatchObject({
      entity_id: 'c',
      rank: null,
      last_accessed_at: 100,
    });
    expect(next.entries[0]?.starred_at).not.toBeNull();
  });

  it('channel unstar CLEARS the home rank too (crossing back to unstarred)', () => {
    const next = setStarredOptimistic(
      vs([{ entity_id: 'c', rank: 2, last_accessed_at: 7, starred_at: 999 }]),
      'c',
      false,
      true,
    );
    expect(next.entries[0]).toEqual({
      entity_id: 'c',
      rank: null,
      last_accessed_at: 7,
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

describe('Favorites sort cache wiring (#task:1254)', () => {
  // Regression for Cindy's P1: the generic sort mutations resolve a list's cache
  // through `sortCacheAdapter`. Favorites was UNRESOLVED (sortListQueryKey →
  // null), so setMode/reorder wrote the backend but silently no-op'd the local
  // cache — the UI only caught up on a later refetch. The adapter also has to
  // bridge the cache SHAPE: rail/channel caches store `viewerSort` (camelCase);
  // the Favorites cache (ListFavoritesDto) stores `viewer_sort` (snake_case).
  const vs = (
    entries: ViewerSortStateDto['entries'],
    modes: ViewerSortStateDto['modes'] = {},
  ): ViewerSortStateDto => ({ list_key: 'favorites', modes, entries });

  it('resolves favorites to favoritesKey and reads/writes the snake_case viewer_sort field', () => {
    const adapter = sortCacheAdapter('favorites');
    expect(adapter).not.toBeNull();
    expect(adapter!.key).toEqual(favoritesKey);

    const cache = { items: [], viewer_sort: vs([], { '': 'recent' }) };
    expect(adapter!.read(cache)).toEqual(cache.viewer_sort);

    const next = vs([], { '': 'manual' });
    const written = adapter!.write(cache, next) as typeof cache;
    expect(written.viewer_sort).toEqual(next);
    // items preserved; no stray camelCase field leaks into the favorites shape.
    expect(written.items).toBe(cache.items);
    expect('viewerSort' in written).toBe(false);
  });

  it('keeps resolving workspaces/channels to the camelCase viewerSort field (no regression)', () => {
    for (const listKey of ['workspaces', 'channels:w1']) {
      const adapter = sortCacheAdapter(listKey);
      expect(adapter).not.toBeNull();
      const cache = { items: [], viewerSort: vs([], { '': 'recent' }) };
      expect(adapter!.read(cache)).toEqual(cache.viewerSort);
      const next = vs([], { '': 'manual' });
      const written = adapter!.write(cache, next) as typeof cache;
      expect(written.viewerSort).toEqual(next);
      expect('viewer_sort' in written).toBe(false);
    }
    expect(sortCacheAdapter('workspaces')!.key).toEqual(['workspaces']);
    expect(sortCacheAdapter('channels:w1')!.key).toEqual(['workspaces', 'w1', 'channels']);
  });

  it('applyOrderToViewerSort writes dense 0..n ranks and flips the list-wide scope to manual', () => {
    const next = applyOrderToViewerSort(
      vs(
        [
          { entity_id: 'channel:c1', rank: null, last_accessed_at: 5, starred_at: 1 },
          { entity_id: 'workspace:w1', rank: null, last_accessed_at: 9, starred_at: 2 },
        ],
        { '': 'recent' },
      ),
      undefined, // list-wide scope (favorites has no per-group axis)
      ['workspace:w1', 'channel:c1'],
    );
    expect(next.modes['']).toBe('manual');
    const byId = new Map(next.entries.map(e => [e.entity_id, e]));
    expect(byId.get('workspace:w1')?.rank).toBe(0);
    expect(byId.get('channel:c1')?.rank).toBe(1);
    // non-rank fields ride through untouched.
    expect(byId.get('workspace:w1')?.last_accessed_at).toBe(9);
  });

  it('a favorites cache write lands on favoritesKey and never touches workspaces/channels caches', () => {
    const client = new QueryClient();
    const workspacesCache = { items: [], viewerSort: vs([], { regular: 'recent' }) };
    const channelsCache = { items: [], viewerSort: vs([], { '': 'recent' }) };
    client.setQueryData(['workspaces'], workspacesCache);
    client.setQueryData(['workspaces', 'w1', 'channels'], channelsCache);
    client.setQueryData(favoritesKey, {
      items: [],
      viewer_sort: vs(
        [{ entity_id: 'channel:c1', rank: 0, last_accessed_at: 5, starred_at: 1 }],
        { '': 'recent' },
      ),
    });

    // setMode write (mirrors useSetSortMode.onMutate's write body).
    const modeAdapter = sortCacheAdapter('favorites')!;
    const prevMode = client.getQueryData(modeAdapter.key);
    const prevModeVs = modeAdapter.read(prevMode)!;
    client.setQueryData(
      modeAdapter.key,
      modeAdapter.write(prevMode, { ...prevModeVs, modes: { ...prevModeVs.modes, ['']: 'manual' } }),
    );

    // reorder write (mirrors useApplySortOrder).
    const orderAdapter = sortCacheAdapter('favorites')!;
    const prevOrder = client.getQueryData(orderAdapter.key);
    const prevOrderVs = orderAdapter.read(prevOrder)!;
    client.setQueryData(
      orderAdapter.key,
      orderAdapter.write(prevOrder, applyOrderToViewerSort(prevOrderVs, undefined, ['channel:c1'])),
    );

    const favAfter = client.getQueryData<{ viewer_sort: ViewerSortStateDto }>(favoritesKey)!;
    expect(favAfter.viewer_sort.modes['']).toBe('manual');
    expect(favAfter.viewer_sort.entries.find(e => e.entity_id === 'channel:c1')?.rank).toBe(0);

    // Independent axis: the home caches are byte-identical (same object ref) —
    // favorites reorder/mode can't perturb a workspace/channel's home rank.
    expect(client.getQueryData(['workspaces'])).toBe(workspacesCache);
    expect(client.getQueryData(['workspaces', 'w1', 'channels'])).toBe(channelsCache);
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
