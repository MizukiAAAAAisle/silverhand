import { Hono } from 'hono';
import {
  apiPaths,
  SetSortModeInputSchema,
  SortReorderInputSchema,
  SortTouchInputSchema,
  type SortGroup,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { SortRepo } from '../repos/sort-repo.js';
import { type AppContext, getUserPrincipal } from '../auth/principal.js';
import { canViewWorkspace } from '../permissions.js';

export interface SortRouteDeps {
  ctx: BackendContext;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  sort: SortRepo;
}

/**
 * Per-user (viewer-scoped) list sort mutations (#task:1147). The backend
 * persists preferences only; the renderer composes the final order. Group
 * membership for a reorder is validated against LIVE pin/kind state — the
 * backend rejects cross-group / unknown ids rather than guessing.
 *
 * Read state is carried inline on the list responses (see workspaces route),
 * so there is no GET here.
 */
export function createSortApp(deps: SortRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, workspaces, conversations, sort } = deps;

  /** The legal hard groups for a list kind — rail vs channel sidebar. The
   *  workspace rail partitions by KIND only (`dm` / `regular`); star is NOT a
   *  rail group — it is the global Favorites overlay (#task:1252,
   *  docs/list-sort-v1.md), so a starred workspace/DM stays in its kind group.
   *  The channel sidebar still hard-partitions by star (`starred` / `unstarred`). */
  function legalGroups(listKey: string): SortGroup[] {
    return listKey === 'workspaces'
      ? ['dm', 'regular']
      : ['starred', 'unstarred'];
  }

  /**
   * The mode SCOPE a (list, group) pair toggles. The rail's mode is per
   * section, so each hard group is its own scope; the channel sidebar is
   * list-wide, so every group resolves to the sentinel scope ''. This is the
   * single source for both `setMode` and `reorder` (order ⟹ manual) so the
   * mode a drag flips matches the mode a menu sets — and it mirrors the
   * renderer's `modeScopeOf`, so optimistic write and server agree. Pass a
   * group already validated as legal for the list.
   */
  function modeScopeOf(listKey: string, group: SortGroup): string {
    return listKey === 'workspaces' ? group : '';
  }

  /**
   * Resolve the live, viewer-visible entities of a list to their hard group.
   * Returns null for not-found / forbidden (caller renders the error). Used
   * to validate reorder/touch ids — archived entities are excluded (not in
   * the sorting scope).
   */
  function resolveListGroups(
    c: AppContext,
    listKey: string,
  ): { ok: true; groups: Map<string, SortGroup> } | { ok: false; status: 404 | 403 } {
    const principal = getUserPrincipal(c);
    const groups = new Map<string, SortGroup>();
    if (listKey === 'workspaces') {
      // Workspace rail partitions by KIND only (#task:1252): star is the global
      // Favorites overlay, not a rail group, so a starred workspace/DM stays in
      // its kind group (`dm` / `regular`) and is reorderable there.
      for (const ws of workspaces.list()) {
        if (ws.archived_at != null) continue;
        if (!canViewWorkspace(ctx, principal, ws.id)) continue;
        if (ws.workspace_kind === 'agent_home') {
          groups.set(ws.id, 'dm');
        } else if (ws.workspace_kind === 'regular') {
          groups.set(ws.id, 'regular');
        }
      }
      return { ok: true, groups };
    }
    // 'channels:<ws_id>' — the channel sidebar still hard-partitions by THIS
    // viewer's star set (#task:1209): a star crosses `unstarred ↔ starred`.
    const starred = new Set(sort.listStarredEntityIds(principal.userId, listKey));
    const wsId = listKey.slice('channels:'.length);
    const workspace = workspaces.get(wsId);
    if (!workspace) return { ok: false, status: 404 };
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return { ok: false, status: 403 };
    }
    const forUserId = principal.kind === 'user' ? principal.userId : undefined;
    const channels =
      workspace.workspace_kind === 'regular'
        ? conversations.listActiveChannelsForWorkspace(workspace.id, { forUserId })
        : conversations.listActiveDmChannelsForWorkspace(workspace.id, { forUserId });
    for (const ch of channels) {
      groups.set(ch.id, starred.has(ch.id) ? 'starred' : 'unstarred');
    }
    return { ok: true, groups };
  }

  app.put(apiPaths.sortMode, async c => {
    const principal = getUserPrincipal(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = SetSortModeInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // Validate list scope (existence + visibility) — same gate as order/touch,
    // so a viewer can't persist a preference for a non-existent / forbidden list.
    const resolved = resolveListGroups(c, parsed.data.list_key);
    if (!resolved.ok) {
      return c.json(
        { error: resolved.status === 404 ? 'list not found' : 'forbidden' },
        resolved.status,
      );
    }
    // Resolve the mode scope from list_key + group, and reject a group/list
    // mismatch (don't guess): the rail requires a section group, the channel
    // sidebar is list-wide and must not carry one.
    const { list_key: listKey, group, mode } = parsed.data;
    if (listKey === 'workspaces') {
      if (group === undefined || !legalGroups(listKey).includes(group)) {
        return c.json(
          { error: 'group is required and must be valid for this list', group },
          400,
        );
      }
    } else if (group !== undefined) {
      return c.json(
        { error: 'group is not supported for this list (list-wide mode)', group },
        400,
      );
    }
    const scope = group !== undefined ? modeScopeOf(listKey, group) : '';
    sort.setMode(principal.userId, listKey, scope, mode);
    return c.json({
      viewer_sort: sort.getState(
        principal.userId,
        listKey,
        resolved.groups.keys(),
      ),
    });
  });

  app.put(apiPaths.sortOrder, async c => {
    const principal = getUserPrincipal(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = SortReorderInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { list_key: listKey, group, ordered_ids: orderedIds } = parsed.data;
    // The group must be a legal hard group for THIS list kind (e.g. 'pinned'
    // is not a workspace-rail group). Catches a malformed client even when
    // ordered_ids is empty (which would otherwise no-op through as 200).
    if (!legalGroups(listKey).includes(group)) {
      return c.json({ error: 'group is not valid for this list', group }, 400);
    }
    const resolved = resolveListGroups(c, listKey);
    if (!resolved.ok) {
      return c.json(
        { error: resolved.status === 404 ? 'list not found' : 'forbidden' },
        resolved.status,
      );
    }
    // Reject unknown / cross-group ids — don't guess. Every id must be a live,
    // viewer-visible entity of this list that currently sits in `group`.
    for (const id of orderedIds) {
      if (resolved.groups.get(id) !== group) {
        return c.json(
          { error: 'ordered_ids contains an id not in the declared group', id },
          400,
        );
      }
    }
    // Enforce the whole-group contract: ordered_ids must be EXACTLY the live
    // members of `group` (any order, no missing / extra / duplicate). A partial
    // submission (stale client or race) would leave other members' ranks stale
    // and collide within the group, so it's rejected — the client refetches.
    const liveGroupIds = [...resolved.groups.entries()]
      .filter(([, g]) => g === group)
      .map(([id]) => id);
    const uniqueOrdered = new Set(orderedIds);
    if (
      uniqueOrdered.size !== orderedIds.length
      || orderedIds.length !== liveGroupIds.length
    ) {
      return c.json(
        {
          error: 'ordered_ids must be exactly the live members of the group',
          expected_count: liveGroupIds.length,
        },
        400,
      );
    }
    sort.reorder(
      principal.userId,
      listKey,
      modeScopeOf(listKey, group),
      orderedIds,
    );
    return c.json({
      viewer_sort: sort.getState(principal.userId, listKey, resolved.groups.keys()),
    });
  });

  app.post(apiPaths.sortTouch, async c => {
    const principal = getUserPrincipal(c);
    const body = await c.req.json().catch(() => ({}));
    const parsed = SortTouchInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { list_key: listKey, entity_id: entityId } = parsed.data;
    const resolved = resolveListGroups(c, listKey);
    if (!resolved.ok) {
      return c.json(
        { error: resolved.status === 404 ? 'list not found' : 'forbidden' },
        resolved.status,
      );
    }
    // Only stamp a real, viewer-visible entity of this list.
    if (!resolved.groups.has(entityId)) {
      return c.json({ error: 'unknown entity_id for this list' }, 400);
    }
    sort.touch(principal.userId, listKey, entityId);
    return c.json({ ok: true });
  });

  /**
   * Personal ⭐ star toggle (#task:1209). Star is per-viewer sort state, so it
   * lives in the sort bounded context (not on the entity aggregate). The gate
   * is can-view of the entity — reused from `resolveListGroups`, whose live
   * visible set IS the can-view + non-archived + sortable check: a target not
   * in the set is 404 / 403. The response is the FULL `viewer_sort` for the
   * list (same shape mode/order return) so the renderer reconciles star
   * alongside rank/mode in one state — never a single entry.
   */
  function starResponse(
    c: AppContext,
    listKey: string,
    entityId: string,
    starred: boolean,
  ) {
    const principal = getUserPrincipal(c);
    const resolved = resolveListGroups(c, listKey);
    if (!resolved.ok) {
      return c.json(
        { error: resolved.status === 404 ? 'not found' : 'forbidden' },
        resolved.status,
      );
    }
    if (!resolved.groups.has(entityId)) {
      // Not a live, viewer-visible, non-archived entity of this list.
      return c.json({ error: 'not found' }, 404);
    }
    sort.setStarred(principal.userId, listKey, entityId, starred);
    return c.json({
      viewer_sort: sort.getState(principal.userId, listKey, resolved.groups.keys()),
    });
  }

  function workspaceStar(c: AppContext, starred: boolean) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    return starResponse(c, 'workspaces', id, starred);
  }

  function channelStar(c: AppContext, starred: boolean) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    // Resolve the channel's workspace to build its sidebar list_key; the
    // can-view gate then runs through resolveListGroups on that list.
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return starResponse(c, `channels:${channel.workspace_id}`, id, starred);
  }

  app.post(apiPaths.workspaceStar(':id'), c => workspaceStar(c, true));
  app.delete(apiPaths.workspaceStar(':id'), c => workspaceStar(c, false));
  app.post(apiPaths.channelStar(':id'), c => channelStar(c, true));
  app.delete(apiPaths.channelStar(':id'), c => channelStar(c, false));

  return app;
}
