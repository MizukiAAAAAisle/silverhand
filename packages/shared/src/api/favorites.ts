// Bounded context: favorites (a read-side projection over the `sort` context).
// Re-exported via api/index.ts → @silverhand/shared.
//
// Favorites is the left-rail STARRED section promoted to a GLOBAL favorites
// entry (#task:1252): a viewer-scoped, FLAT list of the viewer's starred
// entities. Its **membership** owns NO storage — it is a pure read projection of
// the single `user_sort_entry.starred_at` fact. Its **ordering**, by contrast,
// DOES live in sort state (`list_key='favorites'`: rank + the list-wide mode) —
// the list is first-class sortable. So: membership = projection, ordering =
// stored. See docs/list-sort-v1.md.
//
// SCOPE — CONSUMER CONTRACT. This endpoint emits `kind` ∈ {'workspace','dm'}
// only: the viewer's stars from the workspace rail (`list_key='workspaces'`) —
// regular workspaces and agent_home DMs. A CHANNEL is NOT a global-Favorites
// member: a channel star is LOCAL, forming the top `starred` section of that
// channel's OWN sidebar (backend `channels:*` sort groups), never hoisted into
// this flat global list. Channels are outside this bounded context.
//
// Each row is id-keyed (`entity_id`); its display identity is server-resolved
// (Activity `preview_sender` precedent) so the renderer does ZERO local
// workspace/agent-cache join — a favorite whose parent context is not currently
// loaded still renders with a name and never a blank subtitle.
//
// Favorites is EXCLUSIVE, not an additive overlay (#task:1252): a starred
// workspace/DM appears here AND is REMOVED from its home rail group — Slack-style
// move, no duplication. The home list excludes a starred workspace/DM by reading
// `starred_at` off its OWN inline `viewer_sort` (single-source — never by joining
// this endpoint), so display and the backend's reorder validation (same
// `starred_at` fact) cannot drift. The backend serves this projection alongside
// the unchanged list endpoints; those still return the FULL visible set (other
// consumers need it), and the rail derives the home exclusion.
import { z } from 'zod';
import { RuntimeKindSchema } from '../db/schema.js';
import { ViewerSortStateDtoSchema } from './sort.js';

/**
 * Which rail-row recipe a favorite uses. Maps the starred entities onto the two
 * rail row shapes:
 *   - 'workspace' — a starred regular workspace (`workspace_kind='regular'`).
 *   - 'dm'        — a starred DM, which at the data layer is an agent's own
 *                   `workspace_kind='agent_home'` workspace; its identity is
 *                   resolved from the bound `owner_agent_id`.
 * A CHANNEL is never a global favorite (its star is local to its own channel
 * sidebar — see the header), so there is no 'channel' kind here.
 * `kind` ALSO selects the unstar endpoint: both 'workspace' and 'dm' →
 * `DELETE /api/workspaces/:entity_id/star`. The list_key is derived server-side
 * by that per-entity route, so the renderer never constructs a storage key.
 */
export const FavoriteKindSchema = z.enum(['workspace', 'dm']);
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
  /** The favorites list's stable sort identity: `<kind>:<entity_id>` (e.g.
   *  `workspace:ws_…`, `dm:ws_…`). This is the renderer's row key / drag key AND
   *  the `entity_id` under which the favorites ordering state lives
   *  (`user_sort_entry.list_key='favorites'`, and the matching
   *  `viewer_sort.entries[].entity_id`). KIND-qualified — never a bare id — so a
   *  DM (kind 'dm') is distinct from a same-id regular workspace (kind
   *  'workspace'). */
  favorite_key: z.string(),
  /** The starred entity's id — `user_sort_entry.entity_id` in its HOME list, and
   *  the unstar path param (the workspace id). NOT the favorites sort key (that
   *  is `favorite_key`). */
  entity_id: z.string(),
  /** Deep-link workspace — always === `entity_id` (a workspace/DM row's entity
   *  IS a workspace). */
  workspace_id: z.string(),
  /** Primary label: the workspace name (workspace rows) or the bound agent's
   *  display name (dm rows). */
  title: z.string(),
  /** Server-resolved icon URL (relative path + `?v=updated_at` cache-buster,
   *  UserDto/AgentDto convention). Non-null ONLY for a dm row whose bound agent
   *  has an avatar. null ⇒ the renderer falls back by kind: regular workspace →
   *  monogram/`W` glyph; dm → runtime badge. Regular workspaces have no icon
   *  storage, so workspace rows are always null here. */
  icon_url: z.string().nullable(),
  /** dm rows only (else null): the bound agent's runtime, used by the renderer's
   *  AgentAvatar fallback badge when `icon_url` is null. */
  runtime: RuntimeKindSchema.nullable(),
  /** The star timestamp (home list's `starred_at`). Display/debug only — the
   *  flat-list ORDER comes from `viewer_sort` (recent → `last_accessed_at`,
   *  manual → `rank`), NOT from this field, and recent's tiebreak is
   *  `created_at` → `favorite_key`, never `starred_at`. Also mirrored into
   *  `viewer_sort.entries[].starred_at` as a home membership/display mirror. */
  starred_at: z.number(),
  /** The entity's creation time (`workspaces.created_at`). The renderer's
   *  `getCreatedAt` — the final STABLE tiebreak for recent mode when
   *  `last_accessed_at` is null/equal, so order never falls back to
   *  insertion/SQL order. */
  created_at: z.number(),
  /** The entity's unread rollup (#task:1254). The starred workspace/DM has
   *  moved out of its home rail group, so this badge is the only place its
   *  unread shows — it is populated server-side from the SAME canonical source
   *  as the home badge (workspace/dm → per-workspace rollup), so STARRED ≡ home,
   *  no drift. 0 when caught up; the renderer shows a badge only for `> 0`.
   *  Nullable is retained for wire back-compat (a client may still guard
   *  `!= null`). */
  unread_count: z.number().nullable(),
  // NO tiered badge field here (#task:1875). The tiered badge — "how loudly
  // should this shout" after the channel tiers and the workspace suppressor —
  // has exactly ONE carrier, `GET /api/attention/badges`, which is also the only
  // read face the `attention_badge_updated` frame keeps fresh. A copy on this
  // row would be a second carrier of the same number on a read face that does
  // not subscribe to that frame. `unread_count` above answers a DIFFERENT
  // question ("how many messages are unread") and stays.
});
export type FavoriteRowDto = z.infer<typeof FavoriteRowDtoSchema>;

/**
 * `GET /api/favorites` response — the viewer's flat favorites plus their
 * favorites ordering state. GLOBAL scope (no workspace filter), mirroring the
 * Activity list: a favorite can point anywhere the viewer has access.
 *
 * SORT MODEL (#task:1252 C). Favorites is a first-class sortable list with its
 * OWN viewer-scoped ordering state under `list_key='favorites'` — a flat, single
 * group, list-wide [recent|manual] toggle + manual drag, reusing the entire
 * `sort` bounded context. It does NOT reuse the rail's old `workspaces`/`starred`
 * scope (that one only ordered workspaces/DMs and made star a rail hard group).
 * The backend does NOT pre-sort `items`; the renderer composes the order with the
 * shared list-sort helper from `viewer_sort`, exactly like the rail / channel
 * sidebar:
 *   - membership / star truth stays single-source: `user_sort_entry.starred_at`
 *     in each entity's HOME list. The `favorites` list_key stores ONLY ordering
 *     (rank + the list-wide mode), never membership.
 *   - `viewer_sort.entries[]` is keyed by `favorite_key` and carries the sort
 *     fields the renderer's `sortEntryLookup` reads: `rank` (from the `favorites`
 *     list_key) + `last_accessed_at` (from the entity's HOME list — recent =
 *     recently-OPENED, never "recently starred"). `starred_at` (home) rides along
 *     as a membership/display mirror — NOT a sort key.
 *   - `recent` orders by `last_accessed_at` DESC (NULLs last → `created_at` →
 *     `favorite_key`); `manual` orders by `rank`.
 *
 * Membership contract (the read-model enforces; written here so it is not
 * hidden in SQL): a row appears IFF the viewer can still access the entity AND
 * it is not archived — i.e. exactly the set the per-entity star endpoints would
 * accept. Concretely: the viewer is a `workspace_users` member and
 * `workspaces.archived_at IS NULL`. A starred entity that becomes inaccessible
 * or archived is HIDDEN, not deleted: its
 * `user_sort_entry.starred_at` row persists, so the favorite reappears if the
 * entity is restored / re-shared. On UNSTAR the `favorites` ordering row is
 * actively deleted (`clearFavoriteRank`), so a re-star re-enters fresh — there
 * is no stale favorites rank to revive. (The entity's HOME rank is the opposite:
 * preserved as an orphan, restored when it returns home.)
 */
export const ListFavoritesDtoSchema = z.object({
  items: z.array(FavoriteRowDtoSchema),
  /** The viewer's favorites ordering state (`list_key='favorites'`): the
   *  list-wide mode (`modes['']`) + per-`favorite_key` entries (rank +
   *  home-derived last_accessed_at/starred_at). Mutated via
   *  `PUT /api/sort/order|mode` with `list_key='favorites'`. */
  viewer_sort: ViewerSortStateDtoSchema,
});
export type ListFavoritesDto = z.infer<typeof ListFavoritesDtoSchema>;
