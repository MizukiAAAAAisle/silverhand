// Per-user (viewer-scoped) list sort state — workspace rail + channel sidebar
// ordering (#task:1146 / #task:1147). Bounded context: sort. Re-exported via
// api/index.ts → @silverhand/shared.
//
// This is personal VIEW STATE, not an aggregate field. The backend persists
// preferences and exposes them; the renderer composes the final order with a
// pure helper (live hard-grouping → within-group by mode). See
// docs/list-sort-v1.md.
import { z } from 'zod';

/**
 * Per-list sort mode. One [recent|manual] toggle per list; absence of a
 * stored row means the default, 'recent' (recently-OPENED by this viewer).
 */
export const SortModeSchema = z.enum(['recent', 'manual']);
export type SortMode = z.infer<typeof SortModeSchema>;

/**
 * Hard-group descriptor for a manual reorder. Groups are partitioned LIVE
 * from the VIEWER's own star state — NOT stored on the entity. Star is the
 * PRIMARY axis on the rail: a starred workspace OR starred DM both land in the
 * cross-kind `starred` group; `dm` / `regular` hold only the UNSTARRED tail of
 * that kind (#task:1209). Star is per-viewer personal state — it lives in the
 * viewer's sort entries (`starred_at`), never as a shared aggregate field.
 *   workspace rail : 'starred' (cross-kind) | 'dm' | 'regular'
 *   channel sidebar: 'starred' | 'unstarred'
 */
export const SortGroupSchema = z.enum(['starred', 'dm', 'regular', 'unstarred']);
export type SortGroup = z.infer<typeof SortGroupSchema>;

/**
 * `list_key` namespaces a list:
 *   'workspaces'        — the workspace rail (one per viewer)
 *   'channels:<ws_id>'  — one workspace's channel sidebar
 */
export const SortListKeySchema = z
  .string()
  .refine(v => v === 'workspaces' || v.startsWith('channels:'), {
    message: "list_key must be 'workspaces' or 'channels:<ws_id>'",
  });

/** Per-entity viewer state. rank/last_accessed_at/starred_at are null until set.
 *  `starred_at` is the personal ⭐ favorite (#task:1209): non-null = starred, and
 *  the timestamp drives "most-recently-starred first" within the `starred` group.
 *  It REPLACES the former shared `pinned_at` aggregate field — star is per-viewer
 *  view state, so it lives here in the sort entry, never on the entity DTO. */
export const ViewerSortEntryDtoSchema = z.object({
  entity_id: z.string(),
  rank: z.number().nullable(),
  last_accessed_at: z.number().nullable(),
  starred_at: z.number().nullable(),
});
export type ViewerSortEntryDto = z.infer<typeof ViewerSortEntryDtoSchema>;

/**
 * The viewer's sort state for one list. Carried inline on list responses
 * (workspace list, channel list) and returned authoritatively by the
 * mode/order mutations so the renderer can reconcile an optimistic drag.
 *
 * `modes` is the per-SCOPE mode map (#task:1146). A scope is one independently
 * toggleable [recent|manual] axis within the list:
 *   - workspace rail : scope = the hard group ('starred' | 'dm' | 'regular') —
 *     each rail section has its own mode.
 *   - channel sidebar: scope = '' (the sentinel "list-wide" scope) — one mode
 *     for the whole list, exactly as before.
 * Sparse: an absent scope means the default, 'recent'. Read with the renderer
 * helper `sortModeOf(state, group?)` (group omitted ⇒ scope '').
 */
export const ViewerSortStateDtoSchema = z.object({
  list_key: z.string(),
  modes: z.record(SortModeSchema),
  entries: z.array(ViewerSortEntryDtoSchema),
});
export type ViewerSortStateDto = z.infer<typeof ViewerSortStateDtoSchema>;

/**
 * Set one scope's mode. `group` selects the scope:
 *   - list_key 'workspaces'   → `group` REQUIRED (the rail section to toggle).
 *   - list_key 'channels:<id>' → `group` MUST be omitted (list-wide, scope '').
 * The route enforces this and rejects a mismatch (400) rather than guessing.
 */
export const SetSortModeInputSchema = z.object({
  list_key: SortListKeySchema,
  group: SortGroupSchema.optional(),
  mode: SortModeSchema,
});
export type SetSortModeInput = z.infer<typeof SetSortModeInputSchema>;

/**
 * Whole-list-within-group reorder. `ordered_ids` is the new order of ONE
 * group's entities (renderer only sends within-group ids). The backend
 * validates every id lives in `group` (live pin/kind) and rewrites their
 * dense ranks — leaving other groups untouched (grouping is sort-time).
 */
export const SortReorderInputSchema = z.object({
  list_key: SortListKeySchema,
  group: SortGroupSchema,
  ordered_ids: z.array(z.string()),
});
export type SortReorderInput = z.infer<typeof SortReorderInputSchema>;

/**
 * Stamp recent-opened. Called ONLY on selection (open a workspace / channel);
 * never on message arrival, unread change, or archive restore. Idempotent
 * upsert of last_accessed_at.
 */
export const SortTouchInputSchema = z.object({
  list_key: SortListKeySchema,
  entity_id: z.string(),
});
export type SortTouchInput = z.infer<typeof SortTouchInputSchema>;
