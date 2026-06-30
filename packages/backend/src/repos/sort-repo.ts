import type { Database as Db } from 'better-sqlite3';
import type {
  SortMode,
  ViewerSortEntryDto,
  ViewerSortStateDto,
} from '@silverhand/shared';

/**
 * Per-user (viewer-scoped) list sort state for the workspace rail and each
 * workspace's channel sidebar (#task:1146 / #task:1147).
 *
 * This repo owns the `sort` bounded context: it persists preferences only
 * (mode, manual rank, recent-opened timestamp) and never orders anything —
 * the renderer composes the final order with a pure helper (live
 * hard-grouping → within-group by mode). See docs/list-sort-v1.md.
 *
 * `rank` is a SINGLE value per (user, list, entity); hard groups are
 * partitioned live at sort time, never baked into a storage key here.
 */
export class SortRepo {
  constructor(private readonly db: Db) {}

  /**
   * Read the viewer's sort state for one list (default mode 'recent').
   *
   * `visibleEntityIds` filters `entries` to the live, viewer-visible set so the
   * wire never exposes a stale entity_id (e.g. after the viewer is removed from
   * a workspace/channel, or it is archived). Storage keeps the orphan row; the
   * read model hides it. Omit only for internal/non-wire callers.
   */
  getState(
    viewerUserId: string,
    listKey: string,
    visibleEntityIds?: Iterable<string>,
  ): ViewerSortStateDto {
    const modeRows = this.db
      .prepare<[string, string], { scope: string; mode: SortMode }>(
        `SELECT scope, mode FROM user_list_sort_mode
         WHERE user_id = ? AND list_key = ?`,
      )
      .all(viewerUserId, listKey);
    const modes: Record<string, SortMode> = {};
    for (const row of modeRows) modes[row.scope] = row.mode;
    const rows = this.db
      .prepare<[string, string], ViewerSortEntryDto>(
        `SELECT entity_id, rank, last_accessed_at, starred_at FROM user_sort_entry
         WHERE user_id = ? AND list_key = ?`,
      )
      .all(viewerUserId, listKey);
    const entries =
      visibleEntityIds === undefined
        ? rows
        : (() => {
            const visible = new Set(visibleEntityIds);
            return rows.filter(r => visible.has(r.entity_id));
          })();
    return {
      list_key: listKey,
      modes,
      entries,
    };
  }

  /**
   * Upsert one scope's sort mode. `scope` is '' for a list-wide list (channel
   * sidebar) or a hard group ('pinned'|'dm'|'regular') for a per-section list
   * (workspace rail). The caller (route) derives scope from list_key + group
   * and validates it; the repo just persists.
   */
  setMode(viewerUserId: string, listKey: string, scope: string, mode: SortMode): void {
    const now = Date.now();
    this.db
      .prepare<[string, string, string, SortMode, number]>(
        `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, list_key, scope) DO UPDATE SET
           mode = excluded.mode,
           updated_at = excluded.updated_at`,
      )
      .run(viewerUserId, listKey, scope, mode, now);
  }

  /**
   * Rewrite dense ranks for one group's entities (rank = position in
   * `orderedIds`) AND set the relevant SCOPE's mode to 'manual' — atomically,
   * in one transaction. Reordering is an explicit "arrange manually" act, so
   * `order ⟹ manual` is an invariant: there is never a window where manual
   * ranks exist while the mode still reads 'recent' (which would make the mode
   * label lie). `scope` is the mode axis the drag belongs to ('' list-wide for
   * channels; the dragged group for the rail) — only that scope flips, so
   * dragging the rail's `pinned` section leaves `dm`/`regular` modes untouched.
   * Preserves each row's last_accessed_at. Other groups' rows are untouched —
   * grouping is a sort-time concern, so cross-group rank values never interact.
   * Caller validates group membership + derives scope first.
   */
  reorder(
    viewerUserId: string,
    listKey: string,
    scope: string,
    orderedIds: string[],
  ): void {
    const now = Date.now();
    const rankStmt = this.db.prepare<[string, string, string, number]>(
      `INSERT INTO user_sort_entry
         (user_id, list_key, entity_id, rank, last_accessed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(user_id, list_key, entity_id) DO UPDATE SET
         rank = excluded.rank`,
    );
    const modeStmt = this.db.prepare<[string, string, string, number]>(
      `INSERT INTO user_list_sort_mode (user_id, list_key, scope, mode, updated_at)
       VALUES (?, ?, ?, 'manual', ?)
       ON CONFLICT(user_id, list_key, scope) DO UPDATE SET
         mode = 'manual',
         updated_at = excluded.updated_at`,
    );
    const tx = this.db.transaction((ids: string[]) => {
      modeStmt.run(viewerUserId, listKey, scope, now);
      ids.forEach((id, i) => rankStmt.run(viewerUserId, listKey, id, i));
    });
    tx(orderedIds);
  }

  /**
   * Stamp recent-opened (idempotent upsert of last_accessed_at). Called only
   * on selection; preserves any existing manual rank.
   */
  touch(viewerUserId: string, listKey: string, entityId: string): void {
    const now = Date.now();
    this.db
      .prepare<[string, string, string, number]>(
        `INSERT INTO user_sort_entry
           (user_id, list_key, entity_id, rank, last_accessed_at)
         VALUES (?, ?, ?, NULL, ?)
         ON CONFLICT(user_id, list_key, entity_id) DO UPDATE SET
           last_accessed_at = excluded.last_accessed_at`,
      )
      .run(viewerUserId, listKey, entityId, now);
  }

  /**
   * Toggle THIS viewer's personal ⭐ star on an entity (#task:1209), scoped to
   * the acting viewer (never global — the old pin cleared all viewers' ranks).
   * Recent-opened (last_accessed_at) is always preserved.
   *
   * Manual `rank` is cleared ONLY when the star crosses a hard-group boundary,
   * which depends on the list (#task:1252):
   *   - channel sidebar (`channels:<ws>`) hard-partitions by star
   *     (`unstarred ↔ starred`), so star/unstar moves the entity between groups
   *     → its arranged position is dropped (falls to the new group's manual tail).
   *   - the workspace rail (`workspaces`) partitions by KIND only; star is the
   *     global Favorites overlay, NOT a rail group, so a starred workspace/DM
   *     stays in its `dm`/`regular` group → rank is PRESERVED (clearing it would
   *     silently corrupt the viewer's manual order of that kind group).
   */
  setStarred(
    viewerUserId: string,
    listKey: string,
    entityId: string,
    starred: boolean,
  ): void {
    // Star crosses a hard group only where the list partitions by star — i.e.
    // the channel sidebar, never the kind-partitioned workspace rail.
    const crossesGroup = listKey.startsWith('channels:');
    if (starred) {
      const now = Date.now();
      this.db
        .prepare<[string, string, string, number]>(
          `INSERT INTO user_sort_entry
             (user_id, list_key, entity_id, rank, last_accessed_at, starred_at)
           VALUES (?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(user_id, list_key, entity_id) DO UPDATE SET
             starred_at = excluded.starred_at${crossesGroup ? ',\n             rank = NULL' : ''}`,
        )
        .run(viewerUserId, listKey, entityId, now);
    } else {
      // Unstar: only touch an existing row (no row ⇒ already unstarred — a
      // no-op, so we never write a junk all-NULL entry).
      this.db
        .prepare<[string, string, string]>(
          `UPDATE user_sort_entry SET starred_at = NULL${crossesGroup ? ', rank = NULL' : ''}
           WHERE user_id = ? AND list_key = ? AND entity_id = ?`,
        )
        .run(viewerUserId, listKey, entityId);
    }
  }

  /**
   * The entity ids THIS viewer has starred in a list. Backs the live
   * `starred` hard-group partition for reorder validation (the renderer reads
   * `starred_at` straight off the inline `viewer_sort` entries).
   */
  listStarredEntityIds(viewerUserId: string, listKey: string): string[] {
    return this.db
      .prepare<[string, string], { entity_id: string }>(
        `SELECT entity_id FROM user_sort_entry
         WHERE user_id = ? AND list_key = ? AND starred_at IS NOT NULL`,
      )
      .all(viewerUserId, listKey)
      .map(r => r.entity_id);
  }
}
