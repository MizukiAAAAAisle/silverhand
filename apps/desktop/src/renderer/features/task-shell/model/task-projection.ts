import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  TaskBoardColumnDto,
  TaskChangedEvent,
  TaskDetailDto,
  TaskStatus,
  TaskSummaryDto,
} from "@silverhand/shared";
import { boardColumnKey, classifyTasksCacheKey, filterKeyConstrainsAssignee } from "./board-query";
import { restartRacingRead } from "./racing-read";
import { taskDetailKey } from "./task-detail";
import { applyTaskChangedToTaskByNumberCache } from "../hooks/use-task-by-number";

/**
 * The task caches' PROJECTION layer (#task:1975): what a status change can be
 * settled locally, and what still has to be re-read.
 *
 * A committed status change reaches this client from two faces — the writer's own
 * HTTP ACK and the `task_changed` WS echo — and both used to answer it the same
 * way: `invalidateQueries(['tasks'])`. That made every status change cost two
 * refetches of every loaded column, two of every active counts scope, one per
 * cached by-number entry, and one facets read that a status write cannot even
 * change (Cindy's request trace on #task:1975: 8 / 4 / 4 / 1 for two 7ms writes).
 *
 * The way out is NOT a smarter de-dupe of the two faces — it is having something
 * to converge WITH. Three facts make a status move locally determinable, and none
 * of them needs a wire change:
 *
 *   1. THE SOURCE COLUMN IS IN THE CACHE. The event carries no `previous_status`,
 *      but it does not have to: the column a row LEAVES is the column this
 *      client currently holds it in. Not found in any loaded page = there is no
 *      row on screen to move, which is the same answer.
 *   2. THE ROW ITSELF IS IN THE CACHE. A `TaskSummaryDto` cannot be synthesized
 *      from the event (no workspace/channel names, no creator, no `created_at`),
 *      but it never has to be: the row moved between columns is the object we
 *      already hold, with `status`/`closed_at` reassigned.
 *   3. PAGE CURSORS SURVIVE BOTH EDITS. A cursor is a POSITION in
 *      `(task_number DESC, id DESC)` (`services/task/board.ts`), not an offset,
 *      so dropping a row from a page leaves every later page exact, and a row
 *      inserted at its ordered place inside a loaded page's range is a row the
 *      server would have returned in that page. A row that sorts BEYOND the last
 *      loaded one belongs to the unloaded tail and is therefore dropped, not
 *      appended (appending it would duplicate it when that page is fetched).
 *
 * What stays authoritative-only: the two `GROUP BY` aggregates. A client `±1` on
 * counts would invent a number (the same rule as `useBoard.ts`: no count is ever
 * maintained by a delta), and facets are an assignee/creator population a status
 * write cannot touch at all — so counts are re-read and facets are left alone.
 *
 * DE-DUPE IS A VALUE COMPARISON, NEVER A SELF-ECHO GUESS. Nothing here asks
 * "was this event mine": it asks whether the event still carries news about the
 * two facts that decide where a row belongs (`status`, `assignee`). Once the
 * writer's optimistic patch has landed, its own echo answers "no" and reconciles
 * nothing; a stranger's change answers "yes". That is why no `previous_status`,
 * no mutation id, and no timing window is needed — and why replay, a second
 * delivery, or an ACK that loses the race to its own echo are all idempotent.
 */

/** A board column's cached value: pages of rows keyed by opaque cursors. */
export type BoardColumnPages = InfiniteData<TaskBoardColumnDto, string | null>;

/** The row order the wire contract delivers and pages are concatenated in:
 *  `task_number DESC, id DESC` (`services/task/board.ts` — `task_number` alone
 *  is not total on the cross-workspace board, `id` is the unique tiebreak).
 *  True when `a` sorts strictly before `b`. */
export function taskRowPrecedes(
  a: Pick<TaskSummaryDto, "id" | "task_number">,
  b: Pick<TaskSummaryDto, "id" | "task_number">,
): boolean {
  if (a.task_number !== b.task_number) return a.task_number > b.task_number;
  return a.id > b.id;
}

/** Drop one row from a column's pages. `null` = this column does not hold it
 *  (nothing to move, and nothing to invalidate on its behalf). Page cursors are
 *  positions, so the pages behind the edit keep continuing exactly. */
export function removeTaskFromColumnPages(
  pages: BoardColumnPages,
  taskId: string,
): { pages: BoardColumnPages; row: TaskSummaryDto } | null {
  for (const [i, page] of pages.pages.entries()) {
    const row = page.items.find((t) => t.id === taskId);
    if (!row) continue;
    const next = [...pages.pages];
    next[i] = { ...page, items: page.items.filter((t) => t.id !== taskId) };
    return { pages: { ...pages, pages: next }, row };
  }
  return null;
}

/**
 * Place a row at its ordered position inside the loaded prefix.
 *
 * `null` = the row sorts after everything loaded AND the column has more pages,
 * i.e. it belongs to the unloaded tail: it must NOT be appended, or the page
 * that really contains it would deliver it a second time. The row is simply not
 * on screen — which is what the server's own window would show.
 *
 * A row placed inside page `i` makes that page one longer than the server's page
 * size. That is deliberate and correct: the page's `next_cursor` still names the
 * position it always named, so page `i + 1` continues from the same place with
 * no gap and no repeat.
 */
export function insertTaskIntoColumnPages(
  pages: BoardColumnPages,
  row: TaskSummaryDto,
): BoardColumnPages | null {
  for (const [i, page] of pages.pages.entries()) {
    const at = page.items.findIndex((item) => taskRowPrecedes(row, item));
    const isLastPage = i === pages.pages.length - 1;
    const next = [...pages.pages];
    if (at === -1) {
      // Sorts after every row of this page: it belongs further down — in the
      // next loaded page, or (only when this column is fully loaded) at the end.
      if (!isLastPage) continue;
      if (page.next_cursor !== null) return null;
      next[i] = { ...page, items: [...page.items, row] };
      return { ...pages, pages: next };
    }
    next[i] = {
      ...page,
      items: [...page.items.slice(0, at), row, ...page.items.slice(at)],
    };
    return { ...pages, pages: next };
  }
  return null;
}

/** Rewrite one row in place (no move). `null` = not held here. */
export function patchTaskInColumnPages(
  pages: BoardColumnPages,
  taskId: string,
  patch: (row: TaskSummaryDto) => TaskSummaryDto,
): BoardColumnPages | null {
  for (const [i, page] of pages.pages.entries()) {
    const at = page.items.findIndex((t) => t.id === taskId);
    const held = at === -1 ? undefined : page.items[at];
    if (!held) continue;
    const patched = patch(held);
    if (patched === held) return pages;
    const items = [...page.items];
    items[at] = patched;
    const next = [...pages.pages];
    next[i] = { ...page, items };
    return { ...pages, pages: next };
  }
  return null;
}

/**
 * What the server writes to `closed_at` for a status change, minus the one
 * branch a client cannot reproduce.
 *
 * `updateStatus` sets `closed_at` to `Date.now()` when a task becomes `closed`
 * and to `null` for every other status (`task-service.ts`), keeping an existing
 * stamp if the task already had one. So every arm except "newly closed" is
 * locally determinable; that one keeps the previous value and lets the event's
 * authoritative stamp settle it. Inventing a client timestamp here would be the
 * same fabrication as a client-side `±1` on a count.
 */
export function optimisticClosedAt(prevClosedAt: number | null, status: TaskStatus): number | null {
  return status === "closed" ? prevClosedAt : null;
}

/** Where the board caches currently hold one task, per filter scope. */
export interface HeldTaskRow {
  filterKey: string;
  status: TaskStatus;
  row: TaskSummaryDto;
}

interface CachedColumnKey {
  key: readonly unknown[];
  status: TaskStatus;
  filterKey: string;
}

/** Every cached column key, parsed back into its two axes. The key IS the
 *  authority for what a `['tasks', …]` entry holds (never the value's shape —
 *  three different values live under that root). */
function cachedColumnKeys(qc: QueryClient): CachedColumnKey[] {
  const out: CachedColumnKey[] = [];
  for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "board", "column"] })) {
    if (classifyTasksCacheKey(q.queryKey) !== "board-column") continue;
    const status = q.queryKey[3];
    const filterKey = q.queryKey[4];
    if (typeof status !== "string" || typeof filterKey !== "string") continue;
    out.push({ key: q.queryKey, status: status as TaskStatus, filterKey });
  }
  return out;
}

/** Which cached column each filter scope holds this task in. At most one per
 *  filter scope (a task has one status), and absent for a scope that does not
 *  hold it at all — out of window, filtered out, or simply not loaded. */
export function locateTaskInBoardColumns(qc: QueryClient, taskId: string): HeldTaskRow[] {
  const found: HeldTaskRow[] = [];
  for (const column of cachedColumnKeys(qc)) {
    const pages = qc.getQueryData<BoardColumnPages>(column.key);
    if (!pages) continue;
    for (const page of pages.pages) {
      const row = page.items.find((t) => t.id === taskId);
      if (!row) continue;
      found.push({ filterKey: column.filterKey, status: column.status, row });
      break;
    }
  }
  return found;
}

/** One filter scope's cached columns that do NOT hold the task — the scopes
 *  whose window cannot say where the row was, so only a re-read can. */
function filterScopesWithoutTask(qc: QueryClient, held: readonly HeldTaskRow[]): string[] {
  const holding = new Set(held.map((h) => h.filterKey));
  const scopes = new Set<string>();
  for (const column of cachedColumnKeys(qc)) {
    if (!holding.has(column.filterKey)) scopes.add(column.filterKey);
  }
  return [...scopes];
}

/** Where the task sits in the scopes whose FILTER narrows the assignee axis —
 *  the only columns whose membership an assignee change can end without any
 *  status change to derive it from. */
function assigneeFilteredColumnsHolding(qc: QueryClient, taskId: string): BoardColumnRef[] {
  return locateTaskInBoardColumns(qc, taskId)
    .filter((at) => filterKeyConstrainsAssignee(at.filterKey))
    .map((at) => ({ filterKey: at.filterKey, status: at.status }));
}

/** A row this client moved between two of its own columns. */
export interface BoardColumnMove {
  filterKey: string;
  from: TaskStatus;
  to: TaskStatus;
  /**
   * The row exactly as this column held it BEFORE the move.
   *
   * Retained because a move is not always visible afterwards: when the
   * destination column is not cached (collapsed, never opened) or the row sorts
   * into its unloaded tail, the row leaves every cached column of that scope and
   * there is nothing left for a compare-and-swap to find. The rollback path puts
   * THIS object back where it came from (`revertOptimisticStatusWrite`), so a
   * failed write never leaves a card missing until the next read lands.
   */
  row: TaskSummaryDto;
  /** False = the row is not in any cached column of this scope after the move
   *  (no destination cache, or it belongs to the unloaded tail). */
  placed: boolean;
}

/** One cached column, named by its two axes. */
export interface BoardColumnRef {
  filterKey: string;
  status: TaskStatus;
}

/**
 * What a local status projection settled, and what it could not.
 *
 * `unknownFilterKeys` is the honest half: those scopes have loaded columns that
 * do not hold this task, so this client cannot tell whether the row left one of
 * them (out of window) or was never in the population at all.
 *
 * `recheckColumns` is the other honest half, for a change that moves nothing: a
 * scope narrowed by an axis this client cannot evaluate (assignee) keeps holding
 * a row whose membership may have just ended, so that ONE column is re-read.
 */
export interface TaskStatusProjection {
  taskId: string;
  status: TaskStatus;
  moves: BoardColumnMove[];
  unknownFilterKeys: string[];
  recheckColumns: BoardColumnRef[];
}

/**
 * Move a task between status columns in every board scope that holds it.
 *
 * `expectStatus` makes the write a compare-and-swap: the rollback path passes
 * the value it optimistically wrote, so a row that has since been reassigned by
 * an authoritative event (or by a later status write) is LEFT ALONE. Rolling
 * back by restoring a snapshot would instead undo whatever landed in between.
 */
export function moveTaskStatusInBoardColumns(
  qc: QueryClient,
  args: {
    taskId: string;
    status: TaskStatus;
    /** The stamp to write, when the caller HOLDS it (the rollback path holds the
     *  one it overwrote). Absent = derive it, which is all a forward write can
     *  do. Without this a `closed → done` rollback restores `closed` with the
     *  `null` stamp its own optimistic write had just derived. */
    closedAt?: number | null;
    /** Only act where the row currently reads this status. */
    expectStatus?: TaskStatus;
  },
): TaskStatusProjection {
  const held = locateTaskInBoardColumns(qc, args.taskId);
  const moves: BoardColumnMove[] = [];

  for (const at of held) {
    if (args.expectStatus !== undefined && at.status !== args.expectStatus) continue;
    if (at.status === args.status) continue;

    const fromKey = boardColumnKey(at.status, at.filterKey);
    const fromPages = qc.getQueryData<BoardColumnPages>(fromKey);
    if (!fromPages) continue;
    const cut = removeTaskFromColumnPages(fromPages, args.taskId);
    if (!cut) continue;
    qc.setQueryData<BoardColumnPages>(fromKey, cut.pages);

    const moved: TaskSummaryDto = {
      ...cut.row,
      status: args.status,
      closed_at:
        args.closedAt !== undefined
          ? args.closedAt
          : optimisticClosedAt(cut.row.closed_at, args.status),
    };
    const toKey = boardColumnKey(args.status, at.filterKey);
    const toPages = qc.getQueryData<BoardColumnPages>(toKey);
    // No cached destination column (collapsed, or never opened) = nothing to
    // place the row into. Its header count still comes from the counts face, and
    // the move keeps the row itself so a rollback can restore it.
    let placed = false;
    if (toPages) {
      const grown = insertTaskIntoColumnPages(toPages, moved);
      if (grown) {
        qc.setQueryData<BoardColumnPages>(toKey, grown);
        placed = true;
      }
    }
    moves.push({
      filterKey: at.filterKey,
      from: at.status,
      to: args.status,
      row: cut.row,
      placed,
    });
  }

  return {
    taskId: args.taskId,
    status: args.status,
    moves,
    unknownFilterKeys: filterScopesWithoutTask(qc, held),
    recheckColumns: [],
  };
}

/** The mutable fields every single-object task cache shares with the board row.
 *  Absent = leave whatever the cache holds (a status write knows nothing about
 *  the title). */
export interface TaskFieldPatch {
  status?: TaskStatus;
  closedAt?: number | null;
  title?: string;
  assignee?: TaskSummaryDto["assignee"];
  threadRootId?: string | null;
}

function sameAssignee(a: TaskSummaryDto["assignee"], b: TaskSummaryDto["assignee"]): boolean {
  return (a?.id ?? null) === (b?.id ?? null) && (a?.type ?? null) === (b?.type ?? null);
}

/**
 * Apply the present fields — returning the SAME OBJECT when every one of them
 * already reads that way.
 *
 * Identity preservation is what makes the whole projection idempotent by value
 * rather than merely convergent: a duplicate delivery, a replayed frame, or the
 * writer's own echo produces no new object, so no cache is written and no
 * in-flight read is restarted for news that was already on screen. Rebuilding an
 * equal row instead cost one extra column read per echo (caught by the
 * consecutive-hops budget in `taskProjection.test.ts`).
 */
function withFields<T extends TaskSummaryDto | TaskDetailDto>(row: T, patch: TaskFieldPatch): T {
  const unchanged =
    (patch.status === undefined || patch.status === row.status) &&
    (patch.closedAt === undefined || patch.closedAt === row.closed_at) &&
    (patch.title === undefined || patch.title === row.title) &&
    (patch.assignee === undefined || sameAssignee(patch.assignee, row.assignee)) &&
    (patch.threadRootId === undefined || patch.threadRootId === row.thread_root_id);
  if (unchanged) return row;
  const next: T = { ...row };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.closedAt !== undefined) next.closed_at = patch.closedAt;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.assignee !== undefined) next.assignee = patch.assignee;
  if (patch.threadRootId !== undefined) next.thread_root_id = patch.threadRootId;
  return next;
}

/** `expectStatus` makes any patch a compare-and-swap: a row that has since been
 *  reassigned by an authoritative event is left alone. */
function fieldPatcher(
  patch: TaskFieldPatch,
  expectStatus?: TaskStatus,
): <T extends TaskSummaryDto | TaskDetailDto>(row: T) => T {
  return (row) =>
    expectStatus !== undefined && row.status !== expectStatus ? row : withFields(row, patch);
}

/** Apply fields to the open detail modal's projection, if one is cached. */
export function patchTaskDetailCache(
  qc: QueryClient,
  args: { taskId: string; patch: TaskFieldPatch; expectStatus?: TaskStatus },
): void {
  const guard = fieldPatcher(args.patch, args.expectStatus);
  qc.setQueryData<TaskDetailDto>(taskDetailKey(args.taskId), (prev) => (prev ? guard(prev) : prev));
}

/**
 * Apply the same fields to the two SINGLE-OBJECT task caches — the open detail
 * modal (`['task-detail', id]`) and every inline `#task:<n>` entry
 * (`['task-by-number', boardCacheScope, n]`) — addressed BY CONTENT.
 *
 * By content because a local writer holds only a `taskId` while the by-number
 * key needs the board's `TaskBoardCacheScope` and `task_number`. Scanning for
 * the entry that already holds this task is what lets a status write patch the
 * very chip that triggered it (`TaskRef`'s popover drives this mutation and is
 * often the only surface mounted) without first reading the task to learn its
 * own coordinates. An entry that is not cached is simply not there — the correct
 * zero-request answer.
 *
 * The EVENT path does not come through here: it projects the board scope from
 * its own placement coords, so it patches the by-number cell by scope
 * (`applyTaskChangedToTaskByNumberCache`), which also handles the one case a
 * content scan structurally cannot — a cached MISS (`data === null`) that has
 * since become a real task.
 */
export function patchTaskPointCaches(
  qc: QueryClient,
  args: { taskId: string; patch: TaskFieldPatch; expectStatus?: TaskStatus },
): void {
  patchTaskDetailCache(qc, args);
  const guard = fieldPatcher(args.patch, args.expectStatus);
  for (const key of pointCacheKeysHolding(qc, args.taskId)) {
    qc.setQueryData<TaskSummaryDto | null>(key, (prev) => (prev ? guard(prev) : prev));
  }
}

/** Every `['task-by-number']` entry that currently HOLDS this task. A cached
 *  MISS (`null`) holds nothing — it is addressed by the event path instead,
 *  which knows both axes and can invalidate it. */
function pointCacheKeysHolding(qc: QueryClient, taskId: string): readonly unknown[][] {
  const keys: unknown[][] = [];
  for (const q of qc.getQueryCache().findAll({ queryKey: ["task-by-number"] })) {
    const held = qc.getQueryData<TaskSummaryDto | null>(q.queryKey);
    if (held?.id === taskId) keys.push([...q.queryKey]);
  }
  return keys;
}

/**
 * Re-read every inline `#task:<n>` entry that holds this task, and no others —
 * the narrow form of `invalidateQueries(['task-by-number'])`.
 *
 * Exported because a write that cannot patch its own outcome still must not
 * re-read chips about OTHER tasks: `useAssignTask` invalidates rather than
 * patches (the server may dispatch the task in the same write, so the resulting
 * status is not this client's to guess), and that is a statement about VALUES,
 * not about scope. Naming the entries needs no prediction — it is a content
 * scan — so the two callers share this one definition instead of one of them
 * walking the root.
 */
export function invalidateTaskPointCaches(qc: QueryClient, taskId: string): void {
  for (const key of pointCacheKeysHolding(qc, taskId)) {
    void qc.invalidateQueries({ queryKey: key, exact: true });
  }
}

/**
 * The task as an inline chip's entry holds it, or `null`.
 *
 * `['task-by-number']` is a FIRST-CLASS read face, not an auxiliary cache: the
 * `TaskRef` popover drives this mutation and is regularly the ONLY surface
 * mounted, so this entry is the only place a baseline (`previousStatus`,
 * `previousClosedAt`) or evidence about the current value can come from. Reading
 * it nowhere is what left a chip-only write with nothing to roll back and made
 * its own echo look like news (Cindy, #task:1975).
 */
export function locateTaskInPointCaches(qc: QueryClient, taskId: string): TaskSummaryDto | null {
  for (const key of pointCacheKeysHolding(qc, taskId)) {
    const held = qc.getQueryData<TaskSummaryDto | null>(key);
    if (held) return held;
  }
  return null;
}

/**
 * Restart the single-object reads of one task that are in flight RIGHT NOW.
 *
 * Called after a write is acknowledged, never before it: a read issued before
 * the click can only answer with pre-click state, so restarting it earlier would
 * re-fetch exactly the value the optimistic patch is replacing. Once the server
 * has committed, the restarted read can only snapshot at-or-after the write —
 * which is what stops a slow chip refresh from reverting a card the user has
 * already seen move (and needs no version field to do it).
 */
export function restartRacingTaskReads(qc: QueryClient, taskId: string): void {
  restartRacingRead(qc, taskDetailKey(taskId));
  for (const key of pointCacheKeysHolding(qc, taskId)) restartRacingRead(qc, key);
}

/**
 * Exactly which board columns one projection has to re-read — the ONE definition
 * of that set.
 *
 * One definition because two consumers must agree on it: `reconcileTaskStatusWrite`
 * issues these reads, and the event path asks the same question in reverse ("is
 * this key already someone else's to refresh?") before it restarts a racing read.
 * Two loops claiming to be the same set would let a column end up with two
 * refetch owners — and a second `invalidateQueries` on one key CANCELS and
 * restarts the first, so that costs a whole extra round trip per column
 * (Cindy, #task:1975).
 */
function columnKeysToReconcile(
  qc: QueryClient,
  projection: TaskStatusProjection,
): readonly unknown[][] {
  const seen = new Set<string>();
  const keys: unknown[][] = [];
  const add = (key: readonly unknown[]) => {
    const id = JSON.stringify(key);
    if (seen.has(id)) return;
    seen.add(id);
    keys.push([...key]);
  };
  for (const move of projection.moves) {
    add(boardColumnKey(move.from, move.filterKey));
    add(boardColumnKey(move.to, move.filterKey));
  }
  for (const column of projection.recheckColumns) {
    add(boardColumnKey(column.status, column.filterKey));
  }
  if (projection.unknownFilterKeys.length > 0) {
    const unknown = new Set(projection.unknownFilterKeys);
    for (const column of cachedColumnKeys(qc)) {
      if (unknown.has(column.filterKey)) add(column.key);
    }
  }
  return keys;
}

/**
 * The bounded authoritative round after a status change — the ONLY requests a
 * status write is allowed to issue.
 *
 *   - the SOURCE and DESTINATION columns of each scope that moved. The move
 *     itself is already exact for the loaded prefix; the re-read is what pulls
 *     the row that was sitting just past the window into the source column's
 *     first page again, so a long session of moves cannot slowly thin a column.
 *   - the one column of a scope whose FILTER may no longer admit the row
 *     (`recheckColumns`).
 *   - every cached column of a scope that could not place the row at all.
 *   - counts, per cached scope: a server `GROUP BY`, never a client delta.
 *   - `['task-detail', id]` ONLY when the caller has no authoritative snapshot
 *     for it (see `applyTaskChangedToProjections`).
 *   - `points` ONLY on the failure path: whatever the local rollback could not
 *     decide about a chip (a same-value race, a baseline no cache carried) is
 *     settled by one authoritative read of the entry holding this task.
 *
 * Facets are deliberately absent: they are the assignee/creator population, and
 * a status write changes neither. `['task-by-number']` is deliberately absent as
 * a ROOT: the entries that hold this task are named individually, and the ones
 * that don't are about other tasks.
 */
export function reconcileTaskStatusWrite(
  qc: QueryClient,
  projection: TaskStatusProjection,
  opts?: { detail?: boolean; points?: boolean },
): void {
  for (const key of columnKeysToReconcile(qc, projection)) {
    void qc.invalidateQueries({ queryKey: key, exact: true });
  }
  for (const q of qc.getQueryCache().findAll({ queryKey: ["tasks", "board", "counts"] })) {
    if (classifyTasksCacheKey(q.queryKey) !== "board-counts") continue;
    void qc.invalidateQueries({ queryKey: q.queryKey, exact: true });
  }
  if (opts?.detail) {
    void qc.invalidateQueries({
      queryKey: taskDetailKey(projection.taskId),
      exact: true,
    });
  }
  if (opts?.points) {
    invalidateTaskPointCaches(qc, projection.taskId);
  }
}

/** What one status write optimistically assigned, so its failure path can undo
 *  exactly that and nothing else. */
export interface OptimisticStatusWrite {
  taskId: string;
  status: TaskStatus;
  /**
   * The status and stamp this client held before the write, read from ONE row so
   * the pair cannot come from two disagreeing caches. `null` status = no cache
   * held the task at all — then there is nothing to roll back either.
   */
  previousStatus: TaskStatus | null;
  previousClosedAt: number | null;
  /** The write closes a task that had no `closed_at` yet, so the server stamped
   *  a timestamp this client cannot compute — the ONE field a status write
   *  leaves unsettled, and the only reason it re-reads a detail. */
  closedAtUnknown: boolean;
  /** This write's place in the per-task LOCAL order (see `taskWriteEpochs`). */
  writeSeq: number;
  /** How many authoritative events this client had applied to the task when the
   *  write began — any later one voids this write's rollback baseline. */
  eventSeq: number;
  projection: TaskStatusProjection;
}

/**
 * Per-task local ledger: which status write is the newest, and whether an
 * authority has spoken since one began.
 *
 * Both questions are LOCAL facts that no wire field can answer (Alice's ruling
 * on #task:1975: a mutation id on the event cannot say which of two client
 * writes is later), and each gates exactly one thing:
 *
 *   - `write` — the value on screen is only MINE to undo while my write is the
 *     newest. Two writes asking for the SAME status make the status-value
 *     compare-and-swap blind: A (`todo → done`) fails after B's `done` has
 *     already committed and echoed, the CAS still reads `done`, and A would roll
 *     the task back to `todo` and leave it there. A superseded write simply does
 *     not roll back; the authoritative round still runs.
 *   - `event` — the value on screen is only mine to undo while nothing else has
 *     spoken. An event carries an ABSOLUTE snapshot that has already been
 *     assigned to every projection this client holds, so once one lands the
 *     rollback has no baseline left: a committed write whose ACK is lost echoes
 *     the value it wrote, and the status-value CAS cannot tell that value came
 *     from the server rather than from its own patch. So one applied event
 *     refuses the WHOLE rollback — board, detail and chips alike — and the
 *     failure path's authoritative round converges instead.
 *
 * Entries exist only while a write is outstanding, so the ledger is bounded by
 * concurrent writes rather than by session length.
 */
interface TaskWriteEpoch {
  open: number;
  write: number;
  event: number;
}
const taskWriteEpochs = new Map<string, TaskWriteEpoch>();

function openWriteEpoch(taskId: string): { writeSeq: number; eventSeq: number } {
  const at = taskWriteEpochs.get(taskId) ?? { open: 0, write: 0, event: 0 };
  at.open += 1;
  at.write += 1;
  taskWriteEpochs.set(taskId, at);
  return { writeSeq: at.write, eventSeq: at.event };
}

/** Called once per write, whatever its outcome (`onSettled`). */
export function closeOptimisticStatusWrite(write: OptimisticStatusWrite): void {
  const at = taskWriteEpochs.get(write.taskId);
  if (!at) return;
  at.open -= 1;
  if (at.open <= 0) taskWriteEpochs.delete(write.taskId);
}

function noteAppliedEvent(taskId: string): void {
  const at = taskWriteEpochs.get(taskId);
  if (at) at.event += 1;
}

/**
 * Show a status change before the write is acknowledged.
 *
 * This is a pre-ACK optimistic write, which the two-transport contract
 * (docs/reactions-design.md §5.3) forbids for a reaction COUNT — and the
 * difference is the value, not the timing. A count is an unversioned aggregate
 * co-owned by every actor, so a local delta drifts and no carrier can prove it
 * holds the newest one. A status is a caller-CHOSEN absolute value for a single
 * field: the writer knows exactly what it asked for, the server either commits
 * that value or refuses the write (`already_at_status` → 409), and the only
 * field it cannot compute (`closed_at` on a fresh close) is left for the event.
 * The three guards §5.3 asks of any local assignment are what make it safe here:
 * it is rolled back on failure, every write is compare-and-swap so it can never
 * overwrite a newer authority, and a bounded authoritative read follows.
 *
 * The baseline comes from the board row, else the open detail, else the inline
 * chip — the last of which is regularly the ONLY surface mounted, since a
 * `TaskRef` popover drives this mutation.
 */
export function beginOptimisticStatusWrite(
  qc: QueryClient,
  args: { taskId: string; status: TaskStatus },
): OptimisticStatusWrite {
  const held = locateTaskInBoardColumns(qc, args.taskId);
  const baseline: TaskSummaryDto | TaskDetailDto | null =
    held[0]?.row ??
    qc.getQueryData<TaskDetailDto>(taskDetailKey(args.taskId)) ??
    locateTaskInPointCaches(qc, args.taskId);
  const previousStatus = baseline?.status ?? null;
  const previousClosedAt = baseline?.closed_at ?? null;
  const epoch = openWriteEpoch(args.taskId);

  const projection = moveTaskStatusInBoardColumns(qc, {
    taskId: args.taskId,
    status: args.status,
  });
  patchTaskPointCaches(qc, {
    taskId: args.taskId,
    patch: {
      status: args.status,
      closedAt: optimisticClosedAt(previousClosedAt, args.status),
    },
  });
  return {
    taskId: args.taskId,
    status: args.status,
    previousStatus,
    previousClosedAt,
    closedAtUnknown: args.status === "closed" && previousClosedAt === null,
    writeSeq: epoch.writeSeq,
    eventSeq: epoch.eventSeq,
    projection,
  };
}

/**
 * Undo an optimistic status write whose POST failed — but only where the value
 * this client wrote is still the value on screen, and only while NOTHING ELSE has
 * spoken about the task since the write began.
 *
 * Two local gates, then compare-and-swap:
 *
 *   - a write a LATER write has superseded does not roll back at all. Two writes
 *     asking for the same status make the value comparison blind (A `todo → done`
 *     fails after B's `done` committed), and only the local order can see it.
 *   - an AUTHORITATIVE EVENT applied since the write began refuses the rollback
 *     outright. The event is an absolute snapshot that has already been assigned
 *     to every projection, so the value on screen is no longer this write's to
 *     undo — it is what the server last reported. The reachable case is a
 *     committed write whose ACK is lost: the echo says `done`, the HTTP face
 *     fails, and a value comparison cannot tell that `done` came from the server
 *     rather than from this client's own patch.
 *
 * Then compare-and-swap, not snapshot restore: the rollback acts only where the
 * cache still reads the value this write assigned. `previousClosedAt` travels with
 * `previousStatus` because it is the ONE stamp this write overwrote (a
 * `closed → done` failure otherwise left the task `closed` with no `closed_at` —
 * a state the server never produces).
 *
 * The retained-row restore is the one non-CAS path, and it is the answer to a
 * move whose destination column was never cached: the row is then in no column at
 * all, so there is nothing for a CAS to find. Both gates above already hold here,
 * so it only re-checks that the row is really absent from that scope.
 *
 * Whatever these gates decline, the caller's authoritative round settles — which
 * is why the failure path re-reads the detail and every chip holding the task.
 */
export function revertOptimisticStatusWrite(qc: QueryClient, write: OptimisticStatusWrite): void {
  const epoch = taskWriteEpochs.get(write.taskId);
  if (epoch?.write !== write.writeSeq) return;
  if (epoch.event !== write.eventSeq) return;
  if (write.previousStatus === null || write.previousStatus === write.status) return;

  moveTaskStatusInBoardColumns(qc, {
    taskId: write.taskId,
    status: write.previousStatus,
    closedAt: write.previousClosedAt,
    expectStatus: write.status,
  });
  for (const move of write.projection.moves) {
    if (move.placed) continue;
    const stillHeld = locateTaskInBoardColumns(qc, write.taskId).some(
      (at) => at.filterKey === move.filterKey,
    );
    if (stillHeld) continue;
    const fromKey = boardColumnKey(move.from, move.filterKey);
    const pages = qc.getQueryData<BoardColumnPages>(fromKey);
    if (!pages) continue;
    // `move.row` IS the pre-write row, so it already carries the status and
    // stamp being restored — nothing is synthesized here either.
    const back = insertTaskIntoColumnPages(pages, move.row);
    if (back) qc.setQueryData<BoardColumnPages>(fromKey, back);
  }
  patchTaskPointCaches(qc, {
    taskId: write.taskId,
    patch: { status: write.previousStatus, closedAt: write.previousClosedAt },
    expectStatus: write.status,
  });
}

/** What a `task_changed` event still has to be reconciled for, after its
 *  absolute snapshot has been applied to everything this client holds.
 *
 *  CALLER CONTRACT: when `needsReconcile` is true, pass THIS `projection` to
 *  `reconcileTaskStatusWrite`. The event path already decided which racing reads
 *  to restart by asking which keys that call will own — a different projection
 *  (or none) puts two refetch owners back on the same column. */
export interface TaskEventOutcome {
  projection: TaskStatusProjection;
  /**
   * Does anything about this event still need an authoritative read?
   *
   * FALSE means the caches already agreed on both facts that decide where a row
   * belongs — its status and its assignee — so the columns hold it in the right
   * place and the aggregates already counted it there. This is the whole
   * de-dupe: the writer's own echo lands on the value the writer just wrote and
   * reconciles nothing, WITHOUT anyone having to recognise it as self-inflicted.
   *
   * TRUE for a genuine change, and for a task no cache holds — absence is not
   * evidence, so an unplaceable row keeps the re-read.
   */
  needsReconcile: boolean;
  /** The event carried the full mutable state of the detail projection, so it
   *  needs no re-read. False for `edit`, whose body/editor are not on the wire. */
  detailSettled: boolean;
}

/**
 * Apply one `task_changed` event to every task projection this client holds.
 *
 * The event is an ABSOLUTE snapshot, so it may ASSIGN — and a second delivery of
 * the same snapshot is a no-op by value (`withFields` preserves identity).
 *
 * ORDER, precisely (Alice's wire audit on #task:1975, checked against the code):
 * the wire is FIFO per scope with an append-only replay buffer and no batching or
 * key-coalescing anywhere, so no frame is ever lost in favour of an older one.
 * What the transport deliberately does NOT promise is that `onWsFrame` is
 * monotonic in `seq`: a client resumes from its APPLIED floor, which by design
 * lags `received` whenever a scope legally receives a frame that writes no warm
 * content, so an already-delivered seq is re-delivered later
 * (`docs/event-ws-transport-v1.md` §4.1: "resume replays from `applied`, so a
 * readerless/no-op frame is re-delivered to a later content reader
 * (idempotent)"). Duplicate delivery is therefore ENGINEERED, and consumer
 * idempotence is a stated correctness requirement — "replay idempotency is wholly
 * the ingestor's responsibility" (ibid.) — not a risk this module chose to accept.
 * Absolute snapshots + value comparison + identity-preserving assignment is the
 * shape that contract asks for.
 *
 * THE RULE THAT OUTLIVES THIS TASK: a projection fed by a scope event may only
 * apply ABSOLUTE values — never a relative delta (`count ± 1`, a toggle, an
 * append without a key). The applied-floor replay hands the same frame over
 * again, so a delta is applied twice with no self-healing path. That is why the
 * two board aggregates stay server `GROUP BY` reads here.
 *
 * Ordering is not what a version field would buy, either: the board and detail
 * projections ride `viewer:<userId>`, whose floor advances with `received`, so
 * they never resume below what they delivered. The one exposed carrier is the
 * CONVERSATION-scope `linked_task` chip in a message row (content-gated ⇒ its
 * floor can lag), and even there a replay range is ascending and ends at the
 * newest seq, so the last frame applied is the current one — a transient stale
 * paint, never a stuck value.
 */
export function applyTaskChangedToProjections(
  qc: QueryClient,
  event: TaskChangedEvent,
): TaskEventOutcome {
  const held = locateTaskInBoardColumns(qc, event.task_id);
  const detail = qc.getQueryData<TaskDetailDto>(taskDetailKey(event.task_id));
  // The chip is EVIDENCE, not a side cache. It is matched by task IDENTITY, not
  // by an exact key: the by-number cache is keyed by board scope now (every
  // conversation on a task's board collapses to one `TaskBoardCacheScope`), so
  // a task holds a single cell and identity finds it regardless of scope. A
  // cached MISS (`null`) holds nothing and is excluded — it says this client has
  // never resolved the task.
  const chip = locateTaskInPointCaches(qc, event.task_id);
  const known = held[0]?.row ?? detail ?? chip ?? null;

  const fields: TaskFieldPatch = {
    status: event.status,
    closedAt: event.closed_at,
    title: event.title,
    assignee: event.assignee,
    threadRootId: event.thread_root_id,
  };

  // Decided BEFORE anything is written — the caches are about to agree with the
  // event by construction, so afterwards there is no news left to detect.
  const assigneeChanged = known === null || !sameAssignee(known.assignee, event.assignee);
  const needsReconcile = known === null || known.status !== event.status || assigneeChanged;
  // `edit` is the one kind whose authoritative state is wider than the event
  // (body, editor byline, edit timestamp), so the detail projection re-reads.
  const detailSettled = event.kind !== "edit";
  noteAppliedEvent(event.task_id);

  // Rewrite the row in place wherever its status did NOT change (title/assignee
  // edits), and move it where it did.
  const touched: (readonly unknown[])[] = [];
  for (const at of held) {
    const key = boardColumnKey(at.status, at.filterKey);
    if (at.status === event.status) {
      const pages = qc.getQueryData<BoardColumnPages>(key);
      if (!pages) continue;
      const patched = patchTaskInColumnPages(pages, event.task_id, (row) =>
        withFields(row, fields),
      );
      if (patched && patched !== pages) {
        qc.setQueryData<BoardColumnPages>(key, patched);
        touched.push(key);
      }
    }
  }
  const moved = moveTaskStatusInBoardColumns(qc, {
    taskId: event.task_id,
    status: event.status,
  });
  for (const move of moved.moves) {
    touched.push(boardColumnKey(move.from, move.filterKey));
    touched.push(boardColumnKey(move.to, move.filterKey));
  }
  const projection: TaskStatusProjection = {
    ...moved,
    // An assignee change moves a row between assignee-filtered POPULATIONS
    // without changing its status, so no move can express it: the one column each
    // narrowed scope holds it in has to be re-read (a scope that does not hold it
    // is already in `unknownFilterKeys`).
    recheckColumns: assigneeChanged ? assigneeFilteredColumnsHolding(qc, event.task_id) : [],
  };

  // ONE refetch owner per key. Where the authoritative round below is going to
  // invalidate a column anyway, it owns that key: invalidating it a second time
  // cancels and restarts the first read, which costs a whole round trip per
  // column. Only a key nobody will re-read has its racing read restarted here —
  // and it needs it, because a read issued before this event would otherwise
  // commit pre-event rows over the assignment just made.
  const owned = needsReconcile
    ? new Set(columnKeysToReconcile(qc, projection).map((key) => JSON.stringify(key)))
    : new Set<string>();
  for (const key of touched) {
    if (!owned.has(JSON.stringify(key))) restartRacingRead(qc, key);
  }

  patchTaskDetailCache(qc, { taskId: event.task_id, patch: fields });
  // The detail projection, whenever this event is its whole authority (`edit` is
  // refreshed by `useTaskDetail` instead — restarting here would be its second
  // owner). Two cases need the restart, and both are reads issued BEFORE the
  // event: one whose value the assignment just changed, and a COLD one that has
  // no value yet — the latter has no other owner at all for a
  // `status`/`claim`/`unclaim`, so without this the modal's first paint can be
  // pre-event state and stay there.
  if (detailSettled) {
    const now = qc.getQueryData<TaskDetailDto>(taskDetailKey(event.task_id));
    if (now !== detail || now === undefined) {
      restartRacingRead(qc, taskDetailKey(event.task_id));
    }
  }
  // The chip owns the freshness of its own key (nothing else in this path
  // invalidates it), including the racing read — see
  // `applyTaskChangedToTaskByNumberCache`.
  applyTaskChangedToTaskByNumberCache(qc, event);

  return { projection, needsReconcile, detailSettled };
}
