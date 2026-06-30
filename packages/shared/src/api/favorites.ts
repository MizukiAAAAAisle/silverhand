// Bounded context: favorites (a read-side projection over the `sort` context).
// Re-exported via api/index.ts → @silverhand/shared.
//
// Favorites is the left-rail STARRED section promoted to a GLOBAL favorites
// entry (#task:1252): a viewer-scoped, FLAT list that UNIONs the viewer's
// starred entries across EVERY list_key — the workspace rail
// (`user_sort_entry.list_key = 'workspaces'`) and every workspace's channel
// sidebar (`list_key = 'channels:<ws_id>'`). It owns NO storage of its own; it
// is a pure read projection of the single `user_sort_entry.starred_at` fact.
// See docs/list-sort-v1.md.
//
// Each row is id-keyed (`entity_id`); its display identity is server-resolved
// (Activity `preview_sender` precedent) so the renderer does ZERO local
// workspace/agent-cache join — a starred channel whose parent workspace is not
// currently loaded still renders with a name and never a blank subtitle.
//
// Favorites is an ADDITIVE OVERLAY, not a hard partition: a starred entity
// appears here AND still appears in its home list (the WORKSPACES/DMS rail
// groups, the channel sidebar). STARRED is an entry/shortcut layer, not a move —
// it must NOT be implemented by filtering starred entities out of their home
// list (the pre-Favorites rail did that; this supersedes it). The backend is
// orthogonal to that composition: it serves this projection alongside the
// unchanged list endpoints.
import { z } from 'zod';
import { RuntimeKindSchema } from '../db/schema.js';

/**
 * Which rail-row recipe a favorite uses. Maps the heterogeneous starred
 * entities onto the three rail row shapes:
 *   - 'workspace' — a starred regular workspace (`workspace_kind='regular'`).
 *   - 'dm'        — a starred DM, which at the data layer is an agent's own
 *                   `workspace_kind='agent_home'` workspace; its identity is
 *                   resolved from the bound `owner_agent_id`.
 *   - 'channel'   — a starred regular-workspace channel (a `conversation` of
 *                   kind 'channel' under a `workspace_kind='regular'` parent).
 *                   v1 does NOT project DM conversations (`dm_channel`) here: a
 *                   DM surfaces only as a 'dm' row from its agent_home workspace
 *                   star, so it never appears twice.
 * `kind` ALSO selects the unstar endpoint: 'workspace'/'dm' →
 * `DELETE /api/workspaces/:entity_id/star`; 'channel' →
 * `DELETE /api/channels/:entity_id/star`. The list_key is derived server-side
 * by those per-entity routes, so the renderer never constructs a storage key.
 */
export const FavoriteKindSchema = z.enum(['workspace', 'dm', 'channel']);
export type FavoriteKind = z.infer<typeof FavoriteKindSchema>;

/**
 * One favorite row, ready to render. FLAT (not a discriminated union) to match
 * the Activity item DTO and let the renderer map uniformly; per-`kind` field
 * population is contractual (documented per field below), not enforced by the
 * type. Stable identity is ALWAYS `entity_id` — never `title` (names are
 * disambiguated for display only, never used as identity).
 */
export const FavoriteRowDtoSchema = z.object({
  kind: FavoriteKindSchema,
  /** The starred entity's id — `user_sort_entry.entity_id`. React key AND the
   *  unstar path param: workspace/dm → workspace id; channel → conversation id. */
  entity_id: z.string(),
  /** Deep-link workspace. workspace/dm: === `entity_id`. channel: the PARENT
   *  workspace id (target of `toChannel(workspace_id, channel_id)`). */
  workspace_id: z.string(),
  /** channel rows only (else null): the conversation id for the deep link.
   *  Equals `entity_id` for channel rows; null for workspace/dm. */
  channel_id: z.string().nullable(),
  /** Primary label: workspace name / agent display name / channel title. NEVER
   *  carries a leading '#'; the renderer adds the channel glyph. */
  title: z.string(),
  /** channel rows only (else null): the parent workspace name, rendered as a
   *  muted trailing subtitle. Also the same-name disambiguator — regular
   *  workspace names are globally unique (`workspaces_regular_name_unique`), so
   *  the parent name alone separates two same-named channels. */
  workspace_name: z.string().nullable(),
  /** Server-resolved icon URL (relative path + `?v=updated_at` cache-buster,
   *  UserDto/AgentDto convention). Non-null ONLY for a dm row whose bound agent
   *  has an avatar. null ⇒ the renderer falls back by kind: regular workspace →
   *  monogram/`W` glyph; dm → runtime badge; channel → `#` glyph (channels carry
   *  no icon). Regular workspaces have no icon storage, so workspace rows are
   *  always null here. */
  icon_url: z.string().nullable(),
  /** dm rows only (else null): the bound agent's runtime, used by the renderer's
   *  AgentAvatar fallback badge when `icon_url` is null. */
  runtime: RuntimeKindSchema.nullable(),
  /** The star timestamp. The canonical flat-list order is `starred_at` DESC and
   *  the read-model returns rows already in that order; exposed so the renderer
   *  can re-derive or tiebreak. */
  starred_at: z.number(),
  /** Reserved for a future per-favorite unread badge. v1 always null — Favorites
   *  is a pure navigation list. Nullable so adding it later is non-breaking. */
  unread_count: z.number().nullable(),
});
export type FavoriteRowDto = z.infer<typeof FavoriteRowDtoSchema>;

/**
 * `GET /api/favorites` response — the viewer's flat favorites, pre-sorted
 * `starred_at` DESC. GLOBAL scope (no workspace filter), mirroring the Activity
 * list: a favorite can point anywhere the viewer has access.
 *
 * Membership contract (the read-model enforces; written here so it is not
 * hidden in SQL): a row appears IFF the viewer can still access the entity AND
 * it is not archived — i.e. exactly the set the per-entity star endpoints would
 * accept. Concretely: workspace/dm → the viewer is a `workspace_users` member
 * and `workspaces.archived_at IS NULL`; channel → the viewer is a
 * `conversation_users` member, the conversation and its parent workspace are
 * both non-archived. A starred entity that becomes inaccessible or archived is
 * HIDDEN, not deleted: its `user_sort_entry.starred_at` row persists, so the
 * favorite reappears if the entity is restored / re-shared.
 */
export const ListFavoritesDtoSchema = z.object({
  items: z.array(FavoriteRowDtoSchema),
});
export type ListFavoritesDto = z.infer<typeof ListFavoritesDtoSchema>;
