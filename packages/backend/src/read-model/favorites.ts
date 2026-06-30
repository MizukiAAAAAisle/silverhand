// Read-model for the global Favorites list (#task:1252, docs/list-sort-v1.md).
// Favorites is a read-side projection over the `sort` bounded context. Its
// MEMBERSHIP owns NO storage: every row is projected from the single
// `user_sort_entry.starred_at` fact, UNIONed across every HOME list_key — the
// workspace rail (`list_key = 'workspaces'`) and every channel sidebar
// (`list_key = 'channels:<ws_id>'`). Dependency direction is one-way:
// routes → read-model. Nothing here writes.
//
// ORDERING (#task:1252 C) is the one thing Favorites stores for itself: a
// first-class viewer-scoped sort state under `list_key='favorites'` — a flat,
// single-group, list-wide [recent|manual] toggle + manual drag, reusing the
// `sort` context. It does NOT reuse the rail's old `workspaces`/`starred` scope.
// This read-model SYNTHESIZES the `viewer_sort` the renderer composes from:
//   - keyed by `<kind>:<entity_id>` favorite keys (cross-kind flat list — a bare
//     id could collide a workspace and a channel, and would not distinguish a DM
//     from a same-id regular workspace);
//   - each entry carries rank (from the `favorites` list_key) + last_accessed_at
//     (from the entity's HOME list — recent = recently-OPENED, never "recently
//     starred") + starred_at (home — a membership/display mirror, NOT a sort key;
//     recent's tiebreak is the row's created_at → favorite_key).
// The backend does NOT pre-sort `items`; the renderer composes order from
// `viewer_sort` with the shared list-sort helper, exactly like the rail / sidebar.
//
// MEMBERSHIP CONTRACT (enforced below; stated in prose so it is not hidden in
// SQL). A starred entity appears IFF the viewer can still access it AND it is
// not archived — exactly the set the per-entity star endpoints accept, so
// Favorites membership ≡ the viewer's star-toggleable set (one source of truth):
//   - workspace/dm  (list_key='workspaces', entity = a workspace):
//       viewer ∈ workspace_users(ws)  AND  ws.archived_at IS NULL.
//       `workspace_kind='regular'` → kind 'workspace'; `'agent_home'` → kind
//       'dm' (a DM is an agent's own home workspace; identity from owner_agent_id).
//   - channel (list_key='channels:%', entity = a conversation):
//       viewer ∈ conversation_users(c)  AND  viewer ∈ workspace_users(parent)
//       AND  c.archived_at IS NULL  AND  parent.archived_at IS NULL.
// An inaccessible / archived favorite is HIDDEN, not deleted: its
// `user_sort_entry.starred_at` row persists, so the favorite reappears if the
// entity is restored / re-shared. A leftover `favorites` ordering row for an
// unstarred entity is likewise a harmless orphan — unprojected while not a
// member, its rank restored if re-starred. This mirrors orphan-hide elsewhere.
//
// Favorites is human viewer-scoped — the only principal kind that stars — so the
// visibility predicate is the canViewWorkspace/canViewConversation USER branch
// (workspace_users / conversation_users membership), expressed as SQL joins.
import type { BackendContext } from '../context.js';
import {
  apiPaths,
  type FavoriteRowDto,
  type ListFavoritesDto,
  type RuntimeKind,
  type SortMode,
  type ViewerSortEntryDto,
} from '@silverhand/shared';

export interface ListFavoritesParams {
  viewerUserId: string;
}

/** A starred workspace-rail entry resolved against `workspaces` (+ the bound
 *  agent for DMs). entity_id is the workspace id. */
interface WorkspaceFavoriteRow {
  entity_id: string;
  starred_at: number;
  last_accessed_at: number | null;
  created_at: number;
  workspace_kind: 'regular' | 'agent_home';
  workspace_name: string;
  owner_agent_id: string | null;
  agent_display_name: string | null;
  agent_name: string | null;
  agent_runtime: RuntimeKind | null;
  agent_avatar_key: string | null;
  agent_updated_at: number | null;
}

/** A starred channel-sidebar entry resolved against `conversations` (+ parent
 *  workspace). entity_id is the conversation id. */
interface ChannelFavoriteRow {
  entity_id: string;
  starred_at: number;
  last_accessed_at: number | null;
  created_at: number;
  workspace_id: string;
  title: string;
  parent_workspace_name: string;
}

/** The kind-qualified favorites sort key — the renderer row/drag key AND the
 *  `entity_id` under `user_sort_entry.list_key='favorites'`. */
export function favoriteKey(kind: FavoriteRowDto['kind'], entityId: string): string {
  return `${kind}:${entityId}`;
}

/**
 * Project the viewer's flat Favorites list plus its ordering state. Pure read.
 * `items` carry display identity + the favorite_key/created_at the renderer
 * needs; `viewer_sort` (list_key='favorites') carries the per-favorite_key sort
 * triple the renderer composes order from. The backend does not pre-sort.
 */
export function listFavorites(
  ctx: BackendContext,
  params: ListFavoritesParams,
): ListFavoritesDto {
  const { viewerUserId } = params;

  // ── workspace + dm favorites (list_key='workspaces') ──────────────────────
  // Visibility = workspace_users membership; archived workspaces are excluded.
  // `last_accessed_at` is the HOME-list recent-opened stamp — recent mode reads
  // it so "recent" means recently-OPENED (from anywhere), not recently-starred.
  const workspaceRows = ctx.db
    .prepare<{ viewer: string }, WorkspaceFavoriteRow>(
      `SELECT
         use.entity_id        AS entity_id,
         use.starred_at       AS starred_at,
         use.last_accessed_at AS last_accessed_at,
         w.created_at         AS created_at,
         w.workspace_kind     AS workspace_kind,
         w.name               AS workspace_name,
         w.owner_agent_id     AS owner_agent_id,
         a.display_name       AS agent_display_name,
         a.name               AS agent_name,
         a.runtime            AS agent_runtime,
         a.avatar_storage_key AS agent_avatar_key,
         a.updated_at         AS agent_updated_at
       FROM user_sort_entry use
       JOIN workspaces w ON w.id = use.entity_id
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.user_id = @viewer
       LEFT JOIN agents a ON a.id = w.owner_agent_id
       WHERE use.user_id = @viewer
         AND use.list_key = 'workspaces'
         AND use.starred_at IS NOT NULL
         AND w.archived_at IS NULL`,
    )
    .all({ viewer: viewerUserId });

  // ── channel favorites (list_key='channels:<ws_id>') ───────────────────────
  // Visibility = conversation_users ∩ workspace_users membership; both the
  // conversation and its parent workspace must be non-archived.
  //
  // v1 narrows to `conversations.kind='channel'` under a `workspace_kind='regular'`
  // parent (#task:1252). A DM surfaces ONLY as a `kind='dm'` row from its
  // agent_home workspace star — so a `dm_channel` star (or any star under an
  // agent_home parent) is HIDDEN here, never deleted. This avoids a DM appearing
  // twice (as both a dm row and a channel row) and a channel row whose subtitle
  // would be an agent_home workspace name. Mapping a DM *conversation* to a
  // favorite is a separate future decision, not folded into `channel`.
  const channelRows = ctx.db
    .prepare<{ viewer: string }, ChannelFavoriteRow>(
      `SELECT
         use.entity_id        AS entity_id,
         use.starred_at       AS starred_at,
         use.last_accessed_at AS last_accessed_at,
         c.created_at         AS created_at,
         c.workspace_id       AS workspace_id,
         c.title              AS title,
         pw.name              AS parent_workspace_name
       FROM user_sort_entry use
       JOIN conversations c ON c.id = use.entity_id
       JOIN conversation_users cu
         ON cu.conversation_id = c.id AND cu.user_id = @viewer
       JOIN workspaces pw ON pw.id = c.workspace_id
       JOIN workspace_users wu
         ON wu.workspace_id = pw.id AND wu.user_id = @viewer
       WHERE use.user_id = @viewer
         AND use.list_key LIKE 'channels:%'
         -- Bind the row's list_key to the channel's ACTUAL parent workspace.
         -- A malformed/orphan row (list_key 'channels:<wsA>' but the channel
         -- really lives in wsB) is dropped: projecting it would emit an identity
         -- (workspace_id = the real wsB) that the unstar route -- which clears
         -- 'channels:<real ws>' -- could never reconcile with the stored
         -- 'channels:<wsA>' row, leaving an undeletable favorite. This keeps
         -- Favorites row identity closed with the per-entity unstar route.
         AND use.list_key = 'channels:' || c.workspace_id
         AND use.starred_at IS NOT NULL
         AND c.kind = 'channel'
         AND pw.workspace_kind = 'regular'
         AND c.archived_at IS NULL
         AND pw.archived_at IS NULL`,
    )
    .all({ viewer: viewerUserId });

  // ── favorites ordering state (list_key='favorites') ───────────────────────
  // Manual rank per favorite_key + the list-wide mode. These are the ONLY thing
  // Favorites stores for itself; membership above is the single source of truth.
  const rankByKey = new Map<string, number>();
  for (const r of ctx.db
    .prepare<{ viewer: string }, { entity_id: string; rank: number }>(
      `SELECT entity_id, rank FROM user_sort_entry
       WHERE user_id = @viewer AND list_key = 'favorites' AND rank IS NOT NULL`,
    )
    .all({ viewer: viewerUserId })) {
    rankByKey.set(r.entity_id, r.rank);
  }
  const modes: Record<string, SortMode> = {};
  for (const r of ctx.db
    .prepare<{ viewer: string }, { scope: string; mode: SortMode }>(
      `SELECT scope, mode FROM user_list_sort_mode
       WHERE user_id = @viewer AND list_key = 'favorites'`,
    )
    .all({ viewer: viewerUserId })) {
    modes[r.scope] = r.mode;
  }

  const items: FavoriteRowDto[] = [];
  const entries: ViewerSortEntryDto[] = [];
  const pushEntry = (
    key: string,
    starredAt: number,
    lastAccessedAt: number | null,
  ) => {
    entries.push({
      entity_id: key,
      rank: rankByKey.get(key) ?? null,
      last_accessed_at: lastAccessedAt,
      starred_at: starredAt,
    });
  };

  for (const r of workspaceRows) {
    const isDm = r.workspace_kind === 'agent_home';
    const kind = isDm ? 'dm' : 'workspace';
    const key = favoriteKey(kind, r.entity_id);
    // DM identity comes from the bound agent; a regular workspace uses its name
    // and has no icon storage (icon_url stays null → renderer monogram/W glyph).
    const avatarUrl =
      isDm && r.owner_agent_id && r.agent_avatar_key
        ? `${apiPaths.agentAvatar(r.owner_agent_id)}?v=${r.agent_updated_at ?? 0}`
        : null;
    items.push({
      kind,
      favorite_key: key,
      entity_id: r.entity_id,
      workspace_id: r.entity_id,
      channel_id: null,
      title: isDm
        ? r.agent_display_name?.trim()
          ? r.agent_display_name
          : r.agent_name ?? r.workspace_name
        : r.workspace_name,
      workspace_name: null,
      icon_url: avatarUrl,
      runtime: isDm ? r.agent_runtime : null,
      starred_at: r.starred_at,
      created_at: r.created_at,
      unread_count: null,
    });
    pushEntry(key, r.starred_at, r.last_accessed_at);
  }

  for (const r of channelRows) {
    const key = favoriteKey('channel', r.entity_id);
    items.push({
      kind: 'channel',
      favorite_key: key,
      entity_id: r.entity_id,
      workspace_id: r.workspace_id,
      channel_id: r.entity_id,
      title: r.title,
      workspace_name: r.parent_workspace_name,
      icon_url: null,
      runtime: null,
      starred_at: r.starred_at,
      created_at: r.created_at,
      unread_count: null,
    });
    pushEntry(key, r.starred_at, r.last_accessed_at);
  }

  // Stable default array order (most-recently-starred first, entity_id tiebreak)
  // so an unsorted client / a test reading items raw sees a deterministic order.
  // The authoritative display order is composed by the renderer from viewer_sort
  // (recent → last_accessed_at / manual → rank); this is only the fallback.
  items.sort(
    (a, b) =>
      b.starred_at - a.starred_at ||
      (a.favorite_key < b.favorite_key
        ? -1
        : a.favorite_key > b.favorite_key
          ? 1
          : 0),
  );

  return { items, viewer_sort: { list_key: 'favorites', modes, entries } };
}

