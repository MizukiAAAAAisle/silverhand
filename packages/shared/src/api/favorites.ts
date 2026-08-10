// Bounded context: favorites (a read-side projection over the `sort` context).
// Re-exported via api/index.ts → @silverhand/shared.
//
// Favorites is the sidebar's STARRED section as a GLOBAL list (#task:1252,
// re-scoped by #task:1888): a viewer-scoped, FLAT list of the viewer's starred
// entities. Its **membership** owns NO storage — it is a pure read projection of
// the single `user_sort_entry.starred_at` fact. Its **ordering**, by contrast,
// DOES live in sort state (`list_key='favorites'`: rank + the list-wide mode) —
// the list is first-class sortable. So: membership = projection, ordering =
// stored. See docs/list-sort-v1.md.
//
// SCOPE — CONSUMER CONTRACT. This endpoint emits CONVERSATIONS only: `kind` ∈
// {'channel','dm_channel'}, i.e. the viewer's stars from a conversation list
// (`list_key='channels:<ws_id>'`). A WORKSPACE / DM container is NOT a
// global-Favorites member, and since #task:1899 is not starrable at all. Mixing
// granularities would put parents in a short list whose row count then grows with
// their children; the single-column sidebar therefore stars leaves only. Note
// there is no separate "Mentions" kind: a Mentions inbox is a `dm_channel` in the
// agent's own home workspace, so it is covered by `kind='dm_channel'`.
//
// Each row is id-keyed (`entity_id`); its display identity is server-resolved
// (Activity `preview_sender` precedent) so the renderer does ZERO local
// workspace/agent-cache join — a favorite whose PARENT context is not currently
// loaded (a collapsed, never-opened workspace) still renders with a title and a
// parent name, never a blank subtitle.
//
// Favorites is EXCLUSIVE, not an additive overlay (#task:1252): a starred
// conversation appears here AND is REMOVED from its parent's children — Slack-style
// move, no duplication. The parent's list excludes it by reading `starred_at` off
// its OWN inline `viewer_sort` (single-source — never by joining this endpoint),
// so display and the backend's reorder validation (same `starred_at` fact) cannot
// drift. The backend serves this projection alongside the unchanged list
// endpoints; those still return the FULL visible set (other consumers need it),
// and the sidebar derives the parent-side exclusion.
import { z } from 'zod';
import { ConversationKindSchema, ConversationVisibilitySchema } from '../db/schema.js';
import { ViewerSortStateDtoSchema } from './sort.js';

/**
 * Which conversation a favorite is. This is the conversation's own kind — the
 * favorites list adds no kind of its own:
 *   - 'channel'     — a regular channel in a regular workspace.
 *   - 'dm_channel'  — a conversation in an agent's own home workspace (the DM
 *                     stream, its Onboarding thread, its Mentions inbox).
 * A WORKSPACE / DM container is never a global favorite — since #task:1899 it
 * cannot be starred at all — so there is no 'workspace' / 'dm' kind.
 * `kind` does NOT select the unstar endpoint: every row unstars through
 * `DELETE /api/channels/:entity_id/star`, which derives the storage list_key
 * server-side, so the renderer never constructs one.
 */
export const FavoriteKindSchema = ConversationKindSchema;
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
   *  `channel:c_…`, `dm_channel:c_…`). This is the renderer's row key / drag key
   *  AND the `entity_id` under which the favorites ordering state lives
   *  (`user_sort_entry.list_key='favorites'`, and the matching
   *  `viewer_sort.entries[].entity_id`). KIND-qualified — never a bare id — so the
   *  key stays self-describing and cannot collide with another kind's id space. */
  favorite_key: z.string(),
  /** The starred conversation's id — `user_sort_entry.entity_id` in its HOME list
   *  (`channels:<workspace_id>`), the star/unstar path param, and the navigation
   *  target. NOT the favorites sort key (that is `favorite_key`). */
  entity_id: z.string(),
  /** The PARENT workspace id: the conversation's container, used for the deep
   *  link and as the parent's stable identity. Since #task:1888 this is NOT
   *  `entity_id` (it was, while favorites held workspaces). */
  workspace_id: z.string(),
  /** Primary label: the conversation's own title. Bare — no `#` sigil and no
   *  parent prefix; the renderer composes those from the fields below. */
  title: z.string(),
  /** The PARENT's label, always populated: the workspace name for a 'channel'
   *  row; the bound agent's display name (falling back to its handle, then the
   *  workspace name) for a 'dm_channel' row. The STARRED list is global and this
   *  product has duplicate channel names by design (several workspaces each with
   *  a `#general`), so this is the row's disambiguator. Its contractual weight is
   *  TOOLTIP DISAMBIGUATION (shiki, 2026-08-08 「接受同名」): two same-named rows
   *  are allowed to look identical at rest, and the parent is what tells them
   *  apart on hover. There is deliberately NO parent glyph/runtime field — an
   *  image-based source cue was tried and removed (every regular parent rendered
   *  the same `W`), so the parent reaches the user as TEXT or not at all. */
  parent_title: z.string(),
  /** The star timestamp (home list's `starred_at`). Display/debug only — the
   *  flat-list ORDER comes from `viewer_sort` (recent → `last_accessed_at`,
   *  manual → `rank`), NOT from this field, and recent's tiebreak is
   *  `created_at` → `favorite_key`, never `starred_at`. Also mirrored into
   *  `viewer_sort.entries[].starred_at` as a home membership/display mirror. */
  starred_at: z.number(),
  /** The conversation's creation time (`conversations.created_at`). The renderer's
   *  `getCreatedAt` — the final STABLE tiebreak for recent mode when
   *  `last_accessed_at` is null/equal, so order never falls back to
   *  insertion/SQL order. */
  created_at: z.number(),
  /** The conversation's unread rollup (#task:1254, re-sourced by #task:1888). The
   *  starred conversation has moved out of its parent's children, so this badge is
   *  the only place its unread shows — and its parent may be collapsed and thus
   *  fetching nothing, so the row must carry the number rather than send the
   *  client to the per-workspace unread face for every parent that happens to own
   *  a starred row. Populated server-side from the SAME canonical rollup predicate
   *  a channel row uses (`ROLLUP_UNREAD`: mainline + followed threads), so STARRED
   *  ≡ in-tree, no drift. 0 when caught up; the renderer shows a badge only for
   *  `> 0`. Patched in place from `unread_updated`'s MESSAGE variant
   *  `conversation_unread_count` (NOT `workspace_unread_count` — that fed the old
   *  workspace-row projection). Nullable is retained for wire back-compat (a
   *  client may still guard `!= null`). */
  unread_count: z.number().nullable(),
  // NO tiered badge field here (#task:1875). The tiered badge — "how loudly
  // should this shout" after the channel tiers and the workspace suppressor —
  // has exactly ONE carrier, `GET /api/attention/badges`, which is also the only
  // read face the `attention_badge_updated` frame keeps fresh. A copy on this
  // row would be a second carrier of the same number on a read face that does
  // not subscribe to that frame. `unread_count` above answers a DIFFERENT
  // question ("how many messages are unread") and stays.
  /** The conversation's STORED visibility (`conversations.visibility`) — the same
   *  identity-level fact `ConversationDto` carries, populated for BOTH kinds
   *  because it is the row's own stored value, not a favorites-specific
   *  derivation. It exists so a STARRED row can draw the channel's glyph from the
   *  same axis its in-tree row does: a private channel wears a `Lock`, a public
   *  one the canonical `#` (#task:1954 — STARRED drew a constant `#` because this
   *  projection had no visibility to hand `ChannelIcon`). The "which kinds get a
   *  Lock" rule is NOT encoded here: exactly as in `WorkspaceChannels`, the
   *  renderer passes this to `ChannelIcon` only for `kind === 'channel'`, so a
   *  `dm_channel` (stored `private` by its CHECK) keeps the `#`. One rule, one
   *  place — this field stays the raw stored fact.
   *  Deliberately NOT joined client-side off the parent's channel list: a starred
   *  conversation is MOVED out of that list and its parent may be collapsed and
   *  fetching nothing, so a client join would make the glyph depend on whether an
   *  unrelated query happened to be warm. */
  visibility: ConversationVisibilitySchema,
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
 * `sort` bounded context. The backend does NOT pre-sort `items`; the renderer
 * composes the order with the shared list-sort helper from `viewer_sort`, exactly
 * like the rail / conversation list:
 *   - membership / star truth stays single-source: `user_sort_entry.starred_at`
 *     in each conversation's HOME list (`channels:<workspace_id>`). The
 *     `favorites` list_key stores ONLY ordering (rank + the list-wide mode),
 *     never membership.
 *   - `viewer_sort.entries[]` is keyed by `favorite_key` and carries the sort
 *     fields the renderer's `sortEntryLookup` reads: `rank` (from the `favorites`
 *     list_key) + `last_accessed_at` (from the conversation's HOME list — recent =
 *     recently-OPENED, never "recently starred"; opening a conversation already
 *     stamps that list, so favorites needs no touch of its own). `starred_at`
 *     (home) rides along as a membership/display mirror — NOT a sort key.
 *   - `recent` orders by `last_accessed_at` DESC (NULLs last → `created_at` →
 *     `favorite_key`); `manual` orders by `rank`.
 *
 * Membership contract (the read-model enforces; written here so it is not
 * hidden in SQL): a row appears IFF the viewer can still reach the conversation
 * AND neither it nor its workspace is archived — the star endpoint's own
 * reachability arms, intersected with "not archived". Concretely: the viewer is a
 * `workspace_users` member of the parent, the conversation is live
 * (`archived_at IS NULL`), the workspace is not archived, and the viewer either
 * belongs to the conversation or it is a public CHANNEL (the same
 * membership-∪-public-discovery set that workspace's own list serves; the public
 * arm never applies to a `dm_channel`). A starred
 * conversation that becomes inaccessible or archived is HIDDEN, not deleted: its
 * `user_sort_entry.starred_at` row persists, so the favorite reappears if it is
 * restored / re-shared. On UNSTAR the `favorites` ordering row is actively
 * deleted (`clearFavoriteRank`), so a re-star re-enters fresh — there is no stale
 * favorites rank to revive. (The conversation's HOME rank is the opposite:
 * preserved as an orphan, restored when it returns to its parent.)
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
