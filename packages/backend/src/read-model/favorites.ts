// Read-model for the global Favorites list (#task:1252, docs/list-sort-v1.md).
// Favorites is a read-side projection over the `sort` bounded context: it owns
// NO storage. Every row is projected from the single `user_sort_entry.starred_at`
// fact, UNIONed across every list_key — the workspace rail
// (`list_key = 'workspaces'`) and every channel sidebar
// (`list_key = 'channels:<ws_id>'`). Dependency direction is one-way:
// routes → read-model. Nothing here writes.
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
// entity is restored / re-shared. This mirrors the sort read-model's orphan-hide.
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
} from '@silverhand/shared';

export interface ListFavoritesParams {
  viewerUserId: string;
}

/** A starred workspace-rail entry resolved against `workspaces` (+ the bound
 *  agent for DMs). entity_id is the workspace id. */
interface WorkspaceFavoriteRow {
  entity_id: string;
  starred_at: number;
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
  workspace_id: string;
  title: string;
  parent_workspace_name: string;
}

/**
 * Project the viewer's flat Favorites list. Pure read; returns a DTO the client
 * renders as-is, pre-sorted `starred_at` DESC.
 */
export function listFavorites(
  ctx: BackendContext,
  params: ListFavoritesParams,
): ListFavoritesDto {
  const { viewerUserId } = params;

  // ── workspace + dm favorites (list_key='workspaces') ──────────────────────
  // Visibility = workspace_users membership; archived workspaces are excluded.
  const workspaceRows = ctx.db
    .prepare<{ viewer: string }, WorkspaceFavoriteRow>(
      `SELECT
         use.entity_id        AS entity_id,
         use.starred_at       AS starred_at,
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
         use.entity_id  AS entity_id,
         use.starred_at AS starred_at,
         c.workspace_id AS workspace_id,
         c.title        AS title,
         pw.name        AS parent_workspace_name
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

  const items: FavoriteRowDto[] = [];

  for (const r of workspaceRows) {
    const isDm = r.workspace_kind === 'agent_home';
    // DM identity comes from the bound agent; a regular workspace uses its name
    // and has no icon storage (icon_url stays null → renderer monogram/W glyph).
    const avatarUrl =
      isDm && r.owner_agent_id && r.agent_avatar_key
        ? `${apiPaths.agentAvatar(r.owner_agent_id)}?v=${r.agent_updated_at ?? 0}`
        : null;
    items.push({
      kind: isDm ? 'dm' : 'workspace',
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
      unread_count: null,
    });
  }

  for (const r of channelRows) {
    items.push({
      kind: 'channel',
      entity_id: r.entity_id,
      workspace_id: r.workspace_id,
      channel_id: r.entity_id,
      title: r.title,
      workspace_name: r.parent_workspace_name,
      icon_url: null,
      runtime: null,
      starred_at: r.starred_at,
      unread_count: null,
    });
  }

  // Canonical flat order: most-recently-starred first, with a deterministic
  // entity_id tiebreak so entities starred in the same millisecond keep a stable
  // order across reads / restarts (never falling back to SQL/insertion order).
  items.sort(
    (a, b) =>
      b.starred_at - a.starred_at ||
      (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0),
  );

  return { items };
}
