// Read-model for the global Favorites list (#task:1252, docs/list-sort-v1.md).
// Favorites is a read-side projection over the `sort` bounded context. Its
// MEMBERSHIP owns NO storage: every row is projected from the single
// `user_sort_entry.starred_at` fact. Its ORDERING does live in sort state
// (`list_key='favorites'` — see the ORDERING note below). Dependency direction is
// one-way: routes → read-model. Nothing here writes.
//
// SCOPE: the global Favorites/STARRED list holds WORKSPACE and DM rows only — it
// projects the viewer's stars from the workspace rail (`list_key='workspaces'`:
// regular workspaces → kind 'workspace', agent_home DMs → kind 'dm'). A CHANNEL
// is NOT a global-Favorites member: a channel star is LOCAL to its own channel
// sidebar (it forms that sidebar's top `starred` section — see routes/sort.ts
// `channels:*`), never hoisted into this flat global list. Channels are simply
// outside this bounded context.
//
// ORDERING (#task:1252 C) is the one thing Favorites stores for itself: a
// first-class viewer-scoped sort state under `list_key='favorites'` — a flat,
// single-group, list-wide [recent|manual] toggle + manual drag, reusing the
// `sort` context. It does NOT reuse the rail's old `workspaces`/`starred` scope.
// This read-model SYNTHESIZES the `viewer_sort` the renderer composes from:
//   - keyed by `<kind>:<entity_id>` favorite keys (a bare id could not
//     distinguish a DM from a same-id regular workspace);
//   - each entry carries rank (from the `favorites` list_key) + last_accessed_at
//     (from the entity's HOME list — recent = recently-OPENED, never "recently
//     starred") + starred_at (home — a membership/display mirror, NOT a sort key;
//     recent's tiebreak is the row's created_at → favorite_key).
// The backend does NOT pre-sort `items`; the renderer composes order from
// `viewer_sort` with the shared list-sort helper, exactly like the rail / sidebar.
//
// MEMBERSHIP CONTRACT (enforced below; stated in prose so it is not hidden in
// SQL). A starred workspace/DM appears IFF the viewer can still access it AND it
// is not archived — exactly the set the per-entity star endpoints accept, so
// Favorites membership ≡ the viewer's star-toggleable workspace/DM set (one
// source of truth):
//   - workspace/dm (list_key='workspaces', entity = a workspace):
//       viewer ∈ workspace_users(ws)  AND  ws.archived_at IS NULL.
//       `workspace_kind='regular'` → kind 'workspace'; `'agent_home'` → kind
//       'dm' (a DM is an agent's own home workspace; identity from owner_agent_id).
// An inaccessible / archived favorite is HIDDEN, not deleted: its
// `user_sort_entry.starred_at` row (and any `favorites` ordering row) persists,
// so the favorite reappears with its arranged position if the entity is restored
// / re-shared. This mirrors orphan-hide elsewhere. A deliberate UNSTAR is the
// opposite of an archive-hide: it actively DELETES the `favorites` ordering row
// (`SortRepo.clearFavoriteRank`), so a re-star re-enters fresh — there is no
// stale favorites rank to revive (the entity's HOME rank, by contrast, is
// preserved and restored on unstar; see SortRepo).
//
// Favorites is human viewer-scoped — the only principal kind that stars — so the
// visibility predicate is the canViewWorkspace USER branch (workspace_users
// membership), expressed as SQL joins.
import type { BackendContext } from '../context.js';
import { ConversationReadRepo } from '../repos/conversation-read-repo.js';
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

  // Unread badge (#task:1254). A starred workspace/DM has MOVED out of its home
  // rail group, so its unread signal lives ONLY here — the badge MUST be
  // populated or a starred workspace/DM loses the unread visibility its rail row
  // used to carry. Source is the CANONICAL unread repo (same `ROLLUP_UNREAD`
  // predicate the rail badge uses), so the STARRED badge equals what the rail row
  // would show — single source, no drift: workspace/dm row → the per-workspace
  // rollup (`unreadCountsByWorkspace`), exactly the rail workspace badge.
  const reads = new ConversationReadRepo(ctx.db);
  const unreadByWorkspace = reads.unreadCountsByWorkspace(viewerUserId);
  // NO tiered badge aggregation here (#task:1875). The tiered badge lives on
  // `GET /api/attention/badges` alone — that is the face `attention_badge_updated`
  // keeps fresh, and this read model is not one of its subscribers. Adding a
  // `badge_count` column here would be a second carrier of the same number that
  // nothing refreshes. `unread_count` above is a different question and stays.

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
      title: isDm
        ? r.agent_display_name?.trim()
          ? r.agent_display_name
          : r.agent_name ?? r.workspace_name
        : r.workspace_name,
      icon_url: avatarUrl,
      runtime: isDm ? r.agent_runtime : null,
      starred_at: r.starred_at,
      created_at: r.created_at,
      unread_count: unreadByWorkspace[r.entity_id] ?? 0,
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

