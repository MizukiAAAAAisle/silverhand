import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type {
  AddWorkspaceMemberInput,
  AgentCapabilitiesDto,
  AgentCapability,
  AgentDto,
  ArchivedChannelListItemDto,
  ChannelConversationDto,
  ChannelLikeDto,
  CreateConversationChannelInput,
  CreateWorkspaceInput,
  DmChannelDto,
  ThreadDto,
  UpdateAgentCapabilitiesInput,
  UpdateWorkspaceHumanMemberRoleResponse,
  UpdateWorkspaceInput,
  WorkspaceDto,
  WorkspaceHumanMemberDto,
  WorkspaceMembersResponse,
  WorkspaceRole,
  SortGroup,
  SortMode,
  ViewerSortStateDto,
} from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';
import { onWsFrame, subscribeWsScope, subscribeViewerScope, isCurrentViewerScope } from '@/lib/ws-client';

export type WorkspaceListItem = {
  id: string;
  name: string;
  description: string | null;
  kind: 'regular' | 'dm';
  workspace_scope_ids: string[];
  workspace_path: string;
  workspace_host_id: string;
  dm_agent_id: string | null;
  dm_channel_ids: string[];
  pinned_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ChannelListItem = ChannelConversationDto | DmChannelDto | ThreadDto;

const workspacesKey = ['workspaces'] as const;
const channelsKey = (workspaceId: string) => ['workspaces', workspaceId, 'channels'] as const;
const archivedChannelsKey = (workspaceId: string) =>
  ['workspaces', workspaceId, 'channels', 'archived'] as const;
const archivedChannelsIndexKey = (workspaceId: string | null, since: number | null) =>
  ['archived-channels', { workspaceId, since }] as const;
const membersKey = (workspaceId: string) => ['workspaces', workspaceId, 'members'] as const;
const capabilitiesKey = (workspaceId: string, agentId: string) =>
  ['workspaces', workspaceId, 'agents', agentId, 'capabilities'] as const;

/** Human workspace member (canonical shared shape): `UserDto` display
 *  fields PLUS the graded-permissions membership `role`. */
export type WorkspaceHumanMember = WorkspaceHumanMemberDto;

export interface WorkspaceMemberLists {
  agents: AgentDto[];
  humans: WorkspaceHumanMember[];
  /** Current viewer's role in this workspace (request-scoped sugar from the
   *  members endpoint). `null` = not a member → read-only. */
  viewerRole: WorkspaceRole | null;
}

function normalizeWorkspaceMembers(
  response: WorkspaceMembersResponse,
): WorkspaceMemberLists {
  return {
    agents: response.members,
    humans: response.human_members,
    viewerRole: response.viewer_role,
  };
}

function workspaceToListItem(workspace: WorkspaceDto): WorkspaceListItem {
  const isDm = workspace.workspace_kind === 'agent_home';
  return {
    id: workspace.id,
    name: isDm ? `dm-${workspace.name}` : workspace.name,
    description: workspace.description,
    kind: isDm ? 'dm' : 'regular',
    workspace_scope_ids: [workspace.id],
    workspace_path: workspace.workspace_path,
    workspace_host_id: workspace.workspace_host_id,
    dm_agent_id: workspace.owner_agent_id,
    dm_channel_ids:
      workspace.dm_channel_ids ?? (workspace.dm_channel_id ? [workspace.dm_channel_id] : []),
    pinned_at: workspace.pinned_at,
    archived_at: workspace.archived_at,
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

export function sortConversationList(items: ChannelListItem[]): ChannelListItem[] {
  const byId = new Map(items.map(item => [item.id, item] as const));
  const topFor = (item: ChannelListItem): ChannelListItem =>
    item.kind === 'thread' && item.parent_conversation_id
      ? byId.get(item.parent_conversation_id) ?? item
      : item;
  const compareTop = (a: ChannelListItem, b: ChannelListItem): number => {
    const aPinned = a.pinned_at !== null;
    const bPinned = b.pinned_at !== null;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (a.pinned_at !== null && b.pinned_at !== null && a.pinned_at !== b.pinned_at) {
      return b.pinned_at - a.pinned_at;
    }
    return a.created_at - b.created_at;
  };

  return [...items].sort((a, b) => {
    const aTop = topFor(a);
    const bTop = topFor(b);
    if (aTop.id !== bTop.id) return compareTop(aTop, bTop);
    if (a.kind !== b.kind) return a.kind === 'thread' ? 1 : -1;
    return a.created_at - b.created_at;
  });
}

/** The workspace rail list cache now carries the viewer's inline sort state
 *  (#task:1146). Readers default to the items array via `select` (so existing
 *  consumers are untouched); `useWorkspaceSortState` selects `viewerSort` off
 *  the same cache. Writers (e.g. optimistic create) must preserve the shape. */
export interface WorkspaceListPayload {
  items: WorkspaceListItem[];
  viewerSort: ViewerSortStateDto;
}

async function fetchWorkspaces(): Promise<WorkspaceListPayload> {
  const res = await api<{ workspaces: WorkspaceDto[]; viewer_sort: ViewerSortStateDto }>(
    apiPaths.workspaces,
  );
  return { items: res.workspaces.map(workspaceToListItem), viewerSort: res.viewer_sort };
}

export function useWorkspaces() {
  return useQuery({
    queryKey: workspacesKey,
    queryFn: fetchWorkspaces,
    select: r => r.items,
  });
}

/** The viewer's sort state (`mode` + sparse per-entity `entries`) for the
 *  workspace rail, read off the same `useWorkspaces` cache. */
export function useWorkspaceSortState() {
  return useQuery({
    queryKey: workspacesKey,
    queryFn: fetchWorkspaces,
    select: r => r.viewerSort,
  });
}

/**
 * Wire payload for the viewer-scoped `viewer_workspaces_changed` event.
 * Narrowed locally from `unknown` (the bus payload type) — the backend
 * publisher owns the matching shape; the doc is the contract. Following
 * the established renderer pattern (e.g. `isMessageUnreadUpdatedPayload`),
 * we do NOT share this type — the wire stays `unknown` and each side
 * validates independently. See `docs/viewer-visibility-sync-v1.md`.
 */
interface ViewerWorkspacesChangedPayload {
  change: 'added' | 'removed' | 'role_changed';
  workspace_id: string;
  role?: WorkspaceRole;
}

export function isViewerWorkspacesChangedPayload(
  payload: unknown,
): payload is ViewerWorkspacesChangedPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const o = payload as Record<string, unknown>;
  return (
    (o.change === 'added' || o.change === 'removed' || o.change === 'role_changed') &&
    typeof o.workspace_id === 'string'
  );
}

/**
 * Minimal WS frame shape the decision below consumes. Both the live
 * `onWsFrame` listener and the unit test normalize into this so the
 * decision logic can be tested without React or a real socket (mirrors
 * the `decideNextVisible` pattern in `useBackendUnreachableSnitch`).
 */
export interface ViewerSyncFrame {
  type: string;
  scope: string;
  kind?: string;
  payload?: unknown;
}

/**
 * Pure decision: given a viewer-scope frame, return the query keys to
 * invalidate (empty = ignore the frame). The hook and tests share this so
 * the two cannot drift.
 *
 * - `snapshot_required` on the viewer scope → refetch `['workspaces']`
 *   (replay-gap safety, same as the other viewer consumers).
 * - `viewer_workspaces_changed` event → always `['workspaces']`; for
 *   `role_changed` additionally the workspace's members query (governance
 *   `viewerRole` is sourced there, not from the list).
 * - anything else → no invalidation.
 *
 * Caller is responsible for the `isCurrentViewerScope(frame.scope)` gate
 * before calling — kept out of the pure fn so it stays dependency-free.
 */
export function decideViewerSyncInvalidations(
  frame: ViewerSyncFrame,
): readonly (readonly string[])[] {
  if (frame.type === 'snapshot_required') return [workspacesKey];
  if (frame.type !== 'event') return [];
  if (frame.kind !== 'viewer_workspaces_changed') return [];
  if (!isViewerWorkspacesChangedPayload(frame.payload)) return [];
  if (frame.payload.change === 'role_changed') {
    return [workspacesKey, membersKey(frame.payload.workspace_id)];
  }
  return [workspacesKey];
}

/**
 * Live-sync the viewer's workspace list when their cross-workspace
 * membership/role changes from ANY source — added to / removed from a
 * workspace, or role changed. See `docs/viewer-visibility-sync-v1.md`.
 *
 * Carrier is the `viewer:<userId>` scope which — unlike `workspace:<id>` —
 * is subscribable before the viewer belongs to any workspace, so this also
 * catches the "added to your first workspace" bootstrap case (there is no
 * workspace scope to have been listening on).
 *
 * Coarse trigger: any `viewer_workspaces_changed` invalidates
 * `['workspaces']`, and the refetch is the authority (the server returns
 * exactly this viewer's workspaces). The payload is a hint only —
 * `role_changed` additionally invalidates that workspace's members query
 * because the governance `viewerRole` is sourced from the members endpoint
 * (`useWorkspaceMemberLists`), not from the workspace list.
 *
 * Safe-downgrade on removal needs no handling here: App's existing
 * "selected workspace no longer exists → bounce to /chat" effect fires
 * reactively once the refetched list drops the row.
 *
 * Mount ONCE in `RegisteredAppShell`: must be alive post-auth and
 * independent of any workspace selection (the sidebar may not be mounted
 * when the viewer's first workspace arrives).
 */
export function useViewerWorkspacesSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (
        (frame.type !== 'event' && frame.type !== 'snapshot_required') ||
        !isCurrentViewerScope(frame.scope)
      ) {
        return;
      }
      for (const queryKey of decideViewerSyncInvalidations(frame)) {
        void qc.invalidateQueries({ queryKey });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateWorkspaceInput) => {
      const res = await api<{
        workspace: WorkspaceDto;
        onboarding_channel_id: string;
      }>(
        apiPaths.workspaces,
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res;
    },
    onSuccess: async res => {
      const workspace = workspaceToListItem(res.workspace);
      qc.setQueryData<WorkspaceListPayload>(workspacesKey, prev => {
        if (!prev) return prev;
        const cur = prev.items;
        const items = cur.some(c => c.id === workspace.id)
          ? cur.map(c => (c.id === workspace.id ? workspace : c))
          : [...cur, workspace];
        return { ...prev, items };
      });
      await qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api(apiPaths.workspace(id), { method: 'DELETE' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string } & UpdateWorkspaceInput) => {
      const { id, ...body } = vars;
      const res = await api<{ workspace: WorkspaceDto }>(apiPaths.workspace(id), {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      return workspaceToListItem(res.workspace);
    },
    onSuccess: workspace => {
      qc.invalidateQueries({ queryKey: workspacesKey });
      // The workspace name shows up inside channel messages too (e.g.
      // the rename system broadcast we just emitted), so refresh
      // channels for this workspace as well.
      qc.invalidateQueries({ queryKey: channelsKey(workspace.id) });
    },
  });
}

export function useArchiveWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; archived: boolean }) => {
      const res = await api<{ workspace: WorkspaceDto }>(
        `/api/workspaces/${vars.id}/archive`,
        {
          method: 'PATCH',
          body: JSON.stringify({ archived: vars.archived }),
        },
      );
      return workspaceToListItem(res.workspace);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

export function usePinWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, pinned }: { id: string; pinned: boolean }) => {
      const res = await api<{ workspace: WorkspaceDto }>(
        apiPaths.workspacePin(id),
        { method: pinned ? 'POST' : 'DELETE' },
      );
      return workspaceToListItem(res.workspace);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspacesKey });
    },
  });
}

/** Channel sidebar list cache, now carrying the viewer's inline sort state
 *  (#task:1146). Mirrors `WorkspaceListPayload`. */
export interface ChannelListPayload {
  items: ChannelListItem[];
  viewerSort: ViewerSortStateDto;
}

async function fetchWorkspaceChannels(workspaceId: string): Promise<ChannelListPayload> {
  const res = await api<{
    channels: ChannelLikeDto[];
    threads: ThreadDto[];
    viewer_sort: ViewerSortStateDto;
  }>(apiPaths.workspaceChannels(workspaceId));
  return {
    items: sortConversationList([...res.channels, ...res.threads]),
    viewerSort: res.viewer_sort,
  };
}

export function useChannelsForWorkspace(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!workspaceId || workspaceKind === null) return;
    const scope = `workspace:${workspaceId}`;
    const sub = subscribeWsScope(scope);
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.scope !== scope || frame.kind !== 'workspace_channels_changed') return;
        void qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: archivedChannelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      } else if (frame.type === 'snapshot_required' && frame.scope === scope) {
        void qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: archivedChannelsKey(workspaceId) });
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc, workspaceId, workspaceKind]);

  return useQuery({
    queryKey: workspaceId ? channelsKey(workspaceId) : ['workspaces', 'none', 'channels'],
    enabled: !!workspaceId && workspaceKind !== null,
    queryFn: () => fetchWorkspaceChannels(workspaceId!),
    select: r => r.items,
  });
}

/** The viewer's sort state (`mode` + sparse `entries`) for one workspace's
 *  channel sidebar, read off the same `useChannelsForWorkspace` cache. */
export function useChannelSortState(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  return useQuery({
    queryKey: workspaceId ? channelsKey(workspaceId) : ['workspaces', 'none', 'channels'],
    enabled: !!workspaceId && workspaceKind !== null,
    queryFn: () => fetchWorkspaceChannels(workspaceId!),
    select: r => r.viewerSort,
  });
}

/** Whether the archived channel-like query should run for a workspace of
 *  this kind. Enabled for BOTH `regular` (archived `channel`s) and `dm`
 *  (agent_home archived `dm_channel`s) — the backend endpoint is
 *  channel-like since #task:1144. Extracted + exported so a regression test
 *  pins `dm` enabled and this can't silently revert to regular-only
 *  (#task:1145). */
export function archivedChannelsEnabledForKind(
  workspaceKind: 'regular' | 'dm' | null,
): boolean {
  return workspaceKind === 'regular' || workspaceKind === 'dm';
}

/** Archived channel-like conversations (and their threads) for a workspace.
 *  Backed by `GET /api/workspaces/:id/channels/archived`. Enabled for BOTH
 *  regular workspaces (archived `channel`s) and agent_home / DM workspaces
 *  (archived `dm_channel`s) — the backend endpoint is channel-like and
 *  returns archived DMs for agent_home since #task:1144. This union feeds
 *  `channels` in App.tsx, so an archived DM opened from the global Archived
 *  panel resolves to a real `selectedChannel` instead of a blank pane
 *  (#task:1145). WS invalidation lives on `useChannelsForWorkspace` — both
 *  queries share the same trigger. */
export function useArchivedChannelsForWorkspace(
  workspaceId: string | null,
  workspaceKind: 'regular' | 'dm' | null = 'regular',
) {
  return useQuery<ChannelListItem[]>({
    queryKey: workspaceId
      ? archivedChannelsKey(workspaceId)
      : ['workspaces', 'none', 'channels', 'archived'],
    enabled: !!workspaceId && archivedChannelsEnabledForKind(workspaceKind),
    queryFn: async () => {
      const res = await api<{
        channels: ChannelLikeDto[];
        threads: ThreadDto[];
      }>(apiPaths.workspaceArchivedChannels(workspaceId!));
      return sortConversationList([...res.channels, ...res.threads]);
    },
  });
}

/** Active channels (+ threads) for every supplied workspace, fetched in
 *  parallel. Reuses the per-workspace `channelsKey` + queryFn of
 *  `useChannelsForWorkspace`, so results share that hook's cache rather
 *  than duplicating fetches. Returns one query result per input id,
 *  index-aligned with `workspaceIds`. Used by the global Tasks pane, which
 *  spans every member workspace and has no single-workspace channel list.
 *  (Per-workspace WS invalidation is owned by `useChannelsForWorkspace`;
 *  this hook is a read fan-out and intentionally adds no extra subscription.) */
export function useChannelsAcrossWorkspaces(workspaceIds: readonly string[]) {
  return useQueries({
    queries: workspaceIds.map(id => ({
      queryKey: channelsKey(id),
      queryFn: () => fetchWorkspaceChannels(id),
      select: (r: ChannelListPayload) => r.items,
    })),
  });
}

// ---- Per-user list sort mutations (#task:1146 / #task:1147) ----

type SortCachePayload = { items: unknown; viewerSort: ViewerSortStateDto };

function sortListQueryKey(listKey: string): readonly unknown[] | null {
  if (listKey === 'workspaces') return workspacesKey;
  if (listKey.startsWith('channels:')) {
    return channelsKey(listKey.slice('channels:'.length));
  }
  return null;
}

/** Toggle a list's sort mode (recent|manual). Optimistic on the list cache's
 *  inline `viewerSort`, reconciled with the authoritative server state. */
export function useSetSortMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { list_key: string; mode: SortMode }) => {
      const res = await api<{ viewer_sort: ViewerSortStateDto }>(apiPaths.sortMode, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      return res.viewer_sort;
    },
    onMutate: async input => {
      const key = sortListQueryKey(input.list_key);
      if (!key) return undefined;
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<SortCachePayload>(key);
      if (prev) {
        qc.setQueryData<SortCachePayload>(key, {
          ...prev,
          viewerSort: { ...prev.viewerSort, mode: input.mode },
        });
      }
      return { key, prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.key && ctx.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSuccess: (viewerSort, input) => {
      const key = sortListQueryKey(input.list_key);
      if (key) {
        qc.setQueryData<SortCachePayload>(key, prev =>
          prev ? { ...prev, viewerSort } : prev,
        );
      }
    },
  });
}

/** Apply a group's new drag order to the inline viewer-sort cache: dense
 *  0..n ranks for the dragged ids + flip mode to `manual` (mirrors the
 *  backend's atomic `order ⟹ manual`). Pure — returns the next payload. */
function applyOrderToPayload(prev: SortCachePayload, orderedIds: string[]): SortCachePayload {
  const byId = new Map(prev.viewerSort.entries.map(e => [e.entity_id, e] as const));
  orderedIds.forEach((id, rank) => {
    const e = byId.get(id);
    byId.set(id, e ? { ...e, rank } : { entity_id: id, rank, last_accessed_at: null });
  });
  return {
    ...prev,
    viewerSort: { ...prev.viewerSort, mode: 'manual', entries: [...byId.values()] },
  };
}

/** Synchronously apply a drag's new order to the cache. Call this in the drop
 *  handler BEFORE `useReorderSort().mutate`, so React re-renders in the
 *  dropped order in the SAME tick dnd-kit clears the drag transform. Going
 *  through the mutation's `onMutate` instead lands the cache write a microtask
 *  too late, so the row visibly snaps back to its old slot then jumps to the
 *  new one. The mutation then persists + reconciles (onSuccess) / refetches on
 *  error. */
export function useApplySortOrder() {
  const qc = useQueryClient();
  return (listKey: string, orderedIds: string[]): void => {
    const key = sortListQueryKey(listKey);
    if (!key) return;
    const prev = qc.getQueryData<SortCachePayload>(key);
    if (prev) qc.setQueryData<SortCachePayload>(key, applyOrderToPayload(prev, orderedIds));
  };
}

/** Persist a manual drag order for ONE live group. The renderer always sends
 *  the COMPLETE group order (`ordered_ids` set-equal to the live group); the
 *  backend rejects partial/duplicate/cross-group ids and flips mode to manual
 *  atomically (#task:1147). The optimistic cache write happens synchronously
 *  in the drop handler via `useApplySortOrder` and is DETERMINISTIC — identical
 *  to what the backend computes (mode=manual + dense 0..n ranks for the same
 *  ordered_ids). So we intentionally do NOT reconcile the success response onto
 *  the cache: a second `setQueryData` a network-RTT after the drop re-renders
 *  the list (the server's `entries` array order can differ from ours, defeating
 *  structural sharing) and shows as a post-drop flicker. The optimistic state
 *  stands; only errors refetch the authoritative order.
 *
 *  BOUNDARY (Cindy): the no-reconcile shortcut is valid for `order` ONLY,
 *  because its success response is a deterministic function of the request —
 *  the backend validated the complete live group and can only return that same
 *  group's 0..n ranks + mode=manual; there is no server-side sort/normalization
 *  the client must absorb. Do NOT copy this to setMode/touch (or any future
 *  mutation): those touch more than one local group or lack an isomorphic local
 *  truth, so they still need to reconcile. The error path keeps refetching, so
 *  stale/race still recovers. */
export function useReorderSort() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      list_key: string;
      group: SortGroup;
      ordered_ids: string[];
    }) => {
      const res = await api<{ viewer_sort: ViewerSortStateDto }>(apiPaths.sortOrder, {
        method: 'PUT',
        body: JSON.stringify(input),
      });
      return res.viewer_sort;
    },
    onMutate: async input => {
      // Cancel in-flight list refetches so they can't clobber the
      // already-applied synchronous optimistic order.
      const key = sortListQueryKey(input.list_key);
      if (key) await qc.cancelQueries({ queryKey: key });
    },
    onError: (_e, input) => {
      // The optimistic order was applied synchronously and we didn't snapshot
      // the pre-drag state here; refetch the authoritative order instead.
      const key = sortListQueryKey(input.list_key);
      if (key) void qc.invalidateQueries({ queryKey: key });
    },
  });
}

/** Stamp recent-opened on selection. Fire-and-forget, non-blocking; the
 *  reorder applies on the next list fetch (no jump under the cursor). The
 *  caller dedups/throttles per (viewer, target); the upsert is idempotent. */
export function useTouchSort() {
  return useMutation({
    mutationFn: async (input: { list_key: string; entity_id: string }) => {
      await api(apiPaths.sortTouch, { method: 'POST', body: JSON.stringify(input) });
    },
  });
}

export function useArchivedChannelsIndex({
  workspaceId,
  since,
  workspaceScopeIds,
}: {
  workspaceId: string | null;
  since: number | null;
  workspaceScopeIds: string[];
}) {
  const qc = useQueryClient();
  useEffect(() => {
    const scopeIds = workspaceId ? [workspaceId] : workspaceScopeIds;
    if (scopeIds.length === 0) return;
    const subscriptions = scopeIds.map(id => subscribeWsScope(`workspace:${id}`));
    const unsub = onWsFrame(frame => {
      if (frame.type === 'event') {
        if (frame.kind !== 'workspace_channels_changed') return;
        if (!scopeIds.some(id => frame.scope === `workspace:${id}`)) return;
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      } else if (
        frame.type === 'snapshot_required' &&
        scopeIds.some(id => frame.scope === `workspace:${id}`)
      ) {
        void qc.invalidateQueries({ queryKey: ['archived-channels'] });
      }
    });
    return () => {
      for (const sub of subscriptions) sub.unsubscribe();
      unsub();
    };
  }, [qc, workspaceId, workspaceScopeIds]);

  return useQuery<ArchivedChannelListItemDto[]>({
    queryKey: archivedChannelsIndexKey(workspaceId, since),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspace_id', workspaceId);
      if (since !== null) params.set('since', String(since));
      const suffix = params.toString();
      const res = await api<{ channels: ArchivedChannelListItemDto[] }>(
        suffix ? `${apiPaths.archivedChannels}?${suffix}` : apiPaths.archivedChannels,
      );
      return res.channels;
    },
  });
}

export function useCreateChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateConversationChannelInput) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const res = await api<{ channel: ChannelLikeDto }>(
        apiPaths.workspaceChannels(workspaceId),
        { method: 'POST', body: JSON.stringify(input) },
      );
      return res.channel;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
    },
  });
}

export function usePinChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelId, pinned }: { channelId: string; pinned: boolean }) => {
      const res = await api<{ channel: ChannelConversationDto | DmChannelDto }>(
        `/api/channels/${channelId}/pin`,
        { method: pinned ? 'POST' : 'DELETE' },
      );
      return res.channel;
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: channelsKey(workspaceId) });
    },
  });
}

export function useArchiveChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      archived,
    }: {
      channelId: string;
      archived: boolean;
      workspaceId?: string;
    }) => {
      const res = await api<{ channel: ChannelLikeDto }>(
        apiPaths.channelArchive(channelId),
        { method: 'PATCH', body: JSON.stringify({ archived }) },
      );
      return res.channel;
    },
    onSuccess: (channel, vars) => {
      const targetWorkspaceId = vars.workspaceId ?? channel.workspace_id ?? workspaceId;
      // Active and archived lists are disjoint contracts on the server;
      // refresh both so the row leaves one and appears in the other
      // immediately, even before the WS event arrives.
      if (targetWorkspaceId) {
        qc.invalidateQueries({ queryKey: channelsKey(targetWorkspaceId) });
        qc.invalidateQueries({ queryKey: archivedChannelsKey(targetWorkspaceId) });
      }
      qc.invalidateQueries({ queryKey: ['archived-channels'] });
    },
  });
}

export function useRenameChannel(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      channelId,
      title,
    }: {
      channelId: string;
      title: string;
      workspaceId?: string;
    }) => {
      const res = await api<{ channel: ChannelLikeDto }>(
        apiPaths.conversationChannel(channelId),
        { method: 'PATCH', body: JSON.stringify({ title }) },
      );
      return res.channel;
    },
    onSuccess: (channel, vars) => {
      const targetWorkspaceId =
        vars.workspaceId ?? channel.workspace_id ?? workspaceId;
      // Rename keeps the row in place (unlike archive), but the title is
      // mirrored into several read models, so refresh all of them rather
      // than only the active list — a rename on an archived channel (the
      // header settings menu is reachable while archived) or in a foreign
      // secondary pane would otherwise show a stale title until an
      // unrelated WS event happened to refetch:
      //   - active + archived channel lists (sidebar groups)
      //   - the global archived-channels index
      //   - the conversation-ref cache (#conv:<id> chips / secondary pane)
      if (targetWorkspaceId) {
        qc.invalidateQueries({ queryKey: channelsKey(targetWorkspaceId) });
        qc.invalidateQueries({ queryKey: archivedChannelsKey(targetWorkspaceId) });
      }
      qc.invalidateQueries({ queryKey: ['archived-channels'] });
      qc.invalidateQueries({ queryKey: ['conversation-ref', channel.id] });
    },
  });
}

export function useWorkspaceMembers(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? membersKey(workspaceId) : ['workspaces', 'none', 'members'],
    enabled: !!workspaceId,
    queryFn: async () => {
      const res = await api<WorkspaceMembersResponse>(
        apiPaths.workspaceMembers(workspaceId!),
      );
      return res;
    },
    select: res => res.members,
  });
}

export function useWorkspaceMemberLists(workspaceId: string | null) {
  return useQuery({
    queryKey: workspaceId ? membersKey(workspaceId) : ['workspaces', 'none', 'members'],
    enabled: !!workspaceId,
    queryFn: async () =>
      api<WorkspaceMembersResponse>(apiPaths.workspaceMembers(workspaceId!)),
    select: normalizeWorkspaceMembers,
  });
}

export function useAddWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddWorkspaceMemberInput) => {
      if (!workspaceId) throw new Error('no workspace selected');
      // Backend returns `{member, human_member}` for the human branch
      // and `{member}` for both agent shapes (legacy `{agent_id}` and
      // tagged `{kind:'agent', agent_id}`). Renderer doesn't need the
      // exact response — it invalidates the workspace-members query so
      // the next fetch reseats both `agents` and `humans`.
      await api<unknown>(
        apiPaths.workspaceMembers(workspaceId),
        { method: 'POST', body: JSON.stringify(input) },
      );
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

export function useRemoveWorkspaceMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      if (!workspaceId) throw new Error('no workspace selected');
      await api(apiPaths.workspaceMember(workspaceId, agentId), {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** Pure optimistic removal: return a members response with `userId` dropped
 *  from the human list, leaving every other field untouched. Exported for
 *  unit tests. */
export function removeHumanMemberFromList(
  response: WorkspaceMembersResponse,
  userId: string,
): WorkspaceMembersResponse {
  return {
    ...response,
    human_members: response.human_members.filter(h => h.user_id !== userId),
  };
}

/** Remove a human member from a workspace. Owner-only on the backend
 *  (`DELETE …/members/users/:userId`, 204 No Content — no body to parse).
 *  Optimistic: drops the row from the cached members list, restores the
 *  snapshot on error, refetches as the authority. The removed user's OWN
 *  client downgrades via the `removed` viewer event (`useViewerWorkspacesSync`),
 *  not this hook. */
export function useRemoveWorkspaceHumanMember(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      if (!workspaceId) throw new Error('no workspace selected');
      await api(apiPaths.workspaceHumanMember(workspaceId, userId), {
        method: 'DELETE',
      });
    },
    onMutate: async userId => {
      if (!workspaceId) return { previous: undefined };
      const key = membersKey(workspaceId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WorkspaceMembersResponse>(key);
      if (previous) {
        qc.setQueryData<WorkspaceMembersResponse>(
          key,
          removeHumanMemberFromList(previous, userId),
        );
      }
      return { previous };
    },
    onError: (_err, _userId, ctx) => {
      if (workspaceId && ctx?.previous) {
        qc.setQueryData(membersKey(workspaceId), ctx.previous);
      }
    },
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** Pure optimistic patch: return a members response with `userId`'s role set
 *  to `role`, leaving every other member untouched. Owner rows are never a
 *  legal target (the caller only offers admin↔member), but this helper does
 *  not re-enforce that — it just maps by `user_id`. Exported for unit tests. */
export function patchHumanMemberRole(
  response: WorkspaceMembersResponse,
  userId: string,
  role: WorkspaceRole,
): WorkspaceMembersResponse {
  return {
    ...response,
    human_members: response.human_members.map(h =>
      h.user_id === userId ? { ...h, role } : h,
    ),
  };
}

/** Update a human member's workspace role (admin↔member). Owner-only on the
 *  backend (`PATCH …/members/users/:userId/role`); the renderer mirrors that
 *  gate by only mounting the control for owner viewers and never offering
 *  `owner` as a target. Optimistic: patches the member row in the cached
 *  members list, then refetches as the authority. On error the snapshot is
 *  restored and the cache invalidated. Cross-end live sync (a role change
 *  initiated elsewhere) rides `useViewerWorkspacesSync`, not this hook. */
export function useUpdateWorkspaceHumanMemberRole(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      userId: string;
      role: Exclude<WorkspaceRole, 'owner'>;
    }) => {
      if (!workspaceId) throw new Error('no workspace selected');
      return api<UpdateWorkspaceHumanMemberRoleResponse>(
        apiPaths.workspaceHumanMemberRole(workspaceId, vars.userId),
        { method: 'PATCH', body: JSON.stringify({ role: vars.role }) },
      );
    },
    onMutate: async vars => {
      if (!workspaceId) return { previous: undefined };
      const key = membersKey(workspaceId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<WorkspaceMembersResponse>(key);
      if (previous) {
        qc.setQueryData<WorkspaceMembersResponse>(
          key,
          patchHumanMemberRole(previous, vars.userId, vars.role),
        );
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (workspaceId && ctx?.previous) {
        qc.setQueryData(membersKey(workspaceId), ctx.previous);
      }
    },
    onSettled: () => {
      if (workspaceId) qc.invalidateQueries({ queryKey: membersKey(workspaceId) });
    },
  });
}

/** The effective capability set of one agent in one workspace (GET).
 *  Any workspace viewer may read; editing is gated on the human role. */
export function useAgentCapabilities(
  workspaceId: string | null,
  agentId: string | null,
) {
  return useQuery({
    queryKey:
      workspaceId && agentId
        ? capabilitiesKey(workspaceId, agentId)
        : ['workspaces', 'none', 'agents', 'none', 'capabilities'],
    enabled: !!workspaceId && !!agentId,
    queryFn: () =>
      api<AgentCapabilitiesDto>(
        apiPaths.workspaceAgentCapabilities(workspaceId!, agentId!),
      ),
  });
}

/** Replace-set edit of an agent's capabilities (PUT). The caller sends the
 *  FULL desired set; the backend diffs against stored rows. On success the
 *  returned DTO seats the cache; on failure the mutation rejects and the
 *  caller is responsible for rollback + refetch (see `AgentPermissionsPanel`). */
export function useUpdateAgentCapabilities(workspaceId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      agentId: string;
      capabilities: AgentCapability[];
    }) => {
      if (!workspaceId) throw new Error('no workspace selected');
      const body: UpdateAgentCapabilitiesInput = {
        capabilities: vars.capabilities,
      };
      return api<AgentCapabilitiesDto>(
        apiPaths.workspaceAgentCapabilities(workspaceId, vars.agentId),
        { method: 'PUT', body: JSON.stringify(body) },
      );
    },
    onSuccess: (dto, vars) => {
      if (workspaceId) {
        qc.setQueryData(capabilitiesKey(workspaceId, vars.agentId), dto);
      }
    },
  });
}
