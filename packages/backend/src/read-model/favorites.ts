// Read-model for the global Favorites list (#task:1252, re-scoped to
// conversations by #task:1888; docs/list-sort-v1.md). Favorites is a read-side
// projection over the `sort` bounded context. Its MEMBERSHIP owns NO storage:
// every row is projected from the single `user_sort_entry.starred_at` fact. Its
// ORDERING does live in sort state (`list_key='favorites'` — see the ORDERING
// note below). Dependency direction is one-way: routes → read-model. Nothing
// here writes.
//
// SCOPE: the global Favorites/STARRED list holds CONVERSATION rows only — it
// projects the viewer's stars from the per-workspace conversation lists
// (`list_key='channels:<ws_id>'`), i.e. `kind='channel'` and `kind='dm_channel'`
// (the latter covers an agent home's DM stream, its Onboarding thread and its
// Mentions inbox — "Mentions" is a dm_channel, not a kind of its own). A
// WORKSPACE / DM container is NOT a global-Favorites member: starring one PINS it
// at the top of its own rail kind group (an ordering marker read off the rail's
// own `viewer_sort.starred_at`), never hoisted into this flat global list.
// Containers are simply outside this bounded context.
//
// ORDERING (#task:1252 C) is the one thing Favorites stores for itself: a
// first-class viewer-scoped sort state under `list_key='favorites'` — a flat,
// single-group, list-wide [recent|manual] toggle + manual drag, reusing the
// `sort` context. This read-model SYNTHESIZES the `viewer_sort` the renderer
// composes from:
//   - keyed by `<kind>:<entity_id>` favorite keys;
//   - each entry carries rank (from the `favorites` list_key) + last_accessed_at
//     (from the conversation's HOME list — recent = recently-OPENED, never
//     "recently starred"; opening a conversation already stamps that list) +
//     starred_at (home — a membership/display mirror, NOT a sort key; recent's
//     tiebreak is the row's created_at → favorite_key).
// The backend does NOT pre-sort `items`; the renderer composes order from
// `viewer_sort` with the shared list-sort helper, exactly like the rail / sidebar.
//
// MEMBERSHIP CONTRACT (enforced below; stated in prose so it is not hidden in
// SQL). A starred conversation appears IFF the viewer can still reach it AND
// neither it nor its workspace is archived — the reachability arms are the SAME
// ones the channel star endpoint accepts, so Favorites membership is the viewer's
// star-toggleable conversation set INTERSECTED with "not archived" (the star
// endpoint itself does not look at the parent's archive state). Archive is a
// display hide, never an unstar:
//   - the star row lives in the conversation's OWN home list
//     (`list_key = 'channels:' || c.workspace_id`) with `starred_at IS NOT NULL`;
//   - viewer ∈ workspace_users(parent)  AND  parent.archived_at IS NULL;
//   - conversation.archived_at IS NULL;
//   - viewer ∈ conversation_users(conv)  OR  (kind='channel' AND public) — the
//     UNION of the two arms the star endpoint's own set is built from:
//     `listActiveChannelsForViewer` (joined ∪ browseable public) for a regular
//     workspace and the strictly membership-filtered DM query for an agent home.
//     The public arm is kind-qualified so the DM side cannot be widened by a
//     stray `visibility` value — the equality holds structurally, without leaning
//     on the dm_channel visibility CHECK.
// An inaccessible / archived favorite is HIDDEN, not deleted: its
// `user_sort_entry.starred_at` row (and any `favorites` ordering row) persists,
// so the favorite reappears with its arranged position if it is restored /
// re-shared. This mirrors orphan-hide elsewhere. A deliberate UNSTAR is the
// opposite of an archive-hide: it actively DELETES the `favorites` ordering row
// (`SortRepo.clearFavoriteRank`), so a re-star re-enters fresh — there is no
// stale favorites rank to revive (the conversation's HOME rank, by contrast, is
// preserved and restored on unstar; see SortRepo).
//
// Pre-#1888 `favorites` ordering rows are keyed `workspace:<ws>` / `dm:<ws>`.
// Those keys can no longer be projected by any member, so they are unreachable
// orphans — deliberately NOT migrated or deleted (nothing reads them, and the
// list's whole population changed, so an old arrangement of containers has no
// meaning to preserve).
//
// Favorites is human viewer-scoped — the only principal kind that stars — so the
// visibility predicate is the canViewWorkspace USER branch (workspace_users
// membership) plus the conversation-level reachability above, expressed as SQL.
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

/** A starred conversation resolved against `conversations` + its parent
 *  workspace (+ the bound agent when the parent is an agent home).
 *  entity_id is the conversation id. */
interface ConversationFavoriteRow {
  entity_id: string;
  starred_at: number;
  last_accessed_at: number | null;
  created_at: number;
  kind: 'channel' | 'dm_channel';
  title: string;
  workspace_id: string;
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
 * `items` carry display identity (own + PARENT) + the favorite_key/created_at the
 * renderer needs; `viewer_sort` (list_key='favorites') carries the
 * per-favorite_key sort triple the renderer composes order from. The backend does
 * not pre-sort.
 */
export function listFavorites(
  ctx: BackendContext,
  params: ListFavoritesParams,
): ListFavoritesDto {
  const { viewerUserId } = params;

  // ── conversation favorites (list_key='channels:<ws_id>') ──────────────────
  // The star row is keyed to the conversation's OWN home list, so the list_key
  // is derived from the joined row rather than passed in — a star recorded under
  // any other list cannot leak in. Visibility = workspace membership + the
  // conversation-level reachability from the header; archived conversations and
  // archived workspaces are excluded. `last_accessed_at` is the HOME-list
  // recent-opened stamp, so "recent" means recently-OPENED (from anywhere).
  const conversationRows = ctx.db
    .prepare<{ viewer: string }, ConversationFavoriteRow>(
      `SELECT
         use.entity_id        AS entity_id,
         use.starred_at       AS starred_at,
         use.last_accessed_at AS last_accessed_at,
         c.created_at         AS created_at,
         c.kind               AS kind,
         c.title              AS title,
         c.workspace_id       AS workspace_id,
         w.name               AS workspace_name,
         w.owner_agent_id     AS owner_agent_id,
         a.display_name       AS agent_display_name,
         a.name               AS agent_name,
         a.runtime            AS agent_runtime,
         a.avatar_storage_key AS agent_avatar_key,
         a.updated_at         AS agent_updated_at
       FROM user_sort_entry use
       JOIN conversations c ON c.id = use.entity_id
       JOIN workspaces w ON w.id = c.workspace_id
       JOIN workspace_users wu
         ON wu.workspace_id = w.id AND wu.user_id = @viewer
       LEFT JOIN agents a ON a.id = w.owner_agent_id
       WHERE use.user_id = @viewer
         AND use.list_key = 'channels:' || c.workspace_id
         AND use.starred_at IS NOT NULL
         AND c.kind IN ('channel', 'dm_channel')
         AND c.archived_at IS NULL
         AND w.archived_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM conversation_users cu
              WHERE cu.conversation_id = c.id AND cu.user_id = @viewer
           )
           OR (c.kind = 'channel' AND c.visibility = 'public')
         )`,
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

  // Unread badge (#task:1254, re-sourced by #task:1875 / #task:1888). A starred
  // conversation has MOVED out of its parent's children, and that parent may be
  // collapsed and fetching nothing, so the row must carry its own unread or the
  // signal is simply lost. Source is the CANONICAL unread repo (the same
  // `ROLLUP_UNREAD` predicate an in-tree conversation row uses), so the STARRED
  // badge equals what the in-tree row would show — single source, no drift.
  const reads = new ConversationReadRepo(ctx.db);
  const unreadByConversation = reads.unreadCountsByConversation(viewerUserId);
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

  for (const r of conversationRows) {
    const key = favoriteKey(r.kind, r.entity_id);
    // PARENT identity. An agent-home parent is identified by its bound agent
    // (avatar + runtime + display name); a regular workspace has no icon storage
    // (parent_icon_url stays null → renderer monogram) and no runtime. The glyph
    // recipe is chosen from these fields, never inferred from `kind`.
    const parentAvatarUrl =
      r.owner_agent_id && r.agent_avatar_key
        ? `${apiPaths.agentAvatar(r.owner_agent_id)}?v=${r.agent_updated_at ?? 0}`
        : null;
    const parentTitle = r.owner_agent_id
      ? r.agent_display_name?.trim()
        ? r.agent_display_name
        : r.agent_name ?? r.workspace_name
      : r.workspace_name;
    items.push({
      kind: r.kind,
      favorite_key: key,
      entity_id: r.entity_id,
      workspace_id: r.workspace_id,
      title: r.title,
      parent_title: parentTitle,
      parent_icon_url: parentAvatarUrl,
      parent_runtime: r.owner_agent_id ? r.agent_runtime : null,
      starred_at: r.starred_at,
      created_at: r.created_at,
      unread_count: unreadByConversation[r.entity_id] ?? 0,
    });
    pushEntry(key, r.starred_at, r.last_accessed_at);
  }

  // Stable default array order (most-recently-starred first, favorite_key
  // tiebreak) so an unsorted client / a test reading items raw sees a
  // deterministic order. The authoritative display order is composed by the
  // renderer from viewer_sort (recent → last_accessed_at / manual → rank); this
  // is only the fallback.
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
