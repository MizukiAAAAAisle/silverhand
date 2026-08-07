import { useEffect, useMemo } from 'react';
import { TaskStatusSchema, type TaskStatus } from '@silverhand/shared';
import { useTaskDetail } from './hooks';
import { columnVisibleCount, type ColumnWindow } from './columnWindow';
import { expandColumn } from './useKanbanColumnCollapse';
import type { BoardColumns } from './useBoard';

/**
 * The reveal inputs a PAGED board can honestly provide (#task:1885).
 *
 * Before the board read a page face, "is the target renderable here?" was a
 * lookup in one array that held every task, and widening was a filter reset plus
 * a window jump to a known index. Neither is available now: a surface holds a
 * bounded prefix of five independently-paged columns, so a target it does not
 * hold may simply be further down a column — and the row's own column is not
 * knowable from a list that does not contain it.
 *
 * So this hook supplies what the shared reveal machine needs, in one place for
 * both surfaces:
 *
 *   - WHERE the target lives — from the task's own `['task-detail', id]`
 *     projection, the only read that answers it without walking every column.
 *     It is read LIVE (not snapshotted at intent arrival): a status changed
 *     inside the modal is exactly the path "View in Tasks" is reached by, and a
 *     stale snapshot would page the wrong column and then consume the intent.
 *   - WIDEN vs FETCH — a loaded row past the window needs a local window write and
 *     no read at all (`canWiden`); a row that is not loaded needs the column to be
 *     asked for another page (`canFetch`). Separating them is what lets the machine
 *     put a failed read ahead of fetching without also blocking a row it already
 *     holds.
 *   - THE EVIDENCE, SCOPED TO ONE READ. Not aggregated across the five columns: a
 *     max/sum over all of them let a sibling column's success outrank the target
 *     column's failure, so a round could conclude "absent" although the only column
 *     that could answer never did (Cindy MUST FIX). The clocks below therefore come
 *     from the TARGET's column alone, carried with the `authority` identity that
 *     says which query they belong to, so the machine can tell a fresh answer from
 *     a query swap.
 *
 * The target column is also force-expanded while an intent stands: a collapsed
 * column fetches nothing and renders nothing, so without this a reveal into
 * Closed (collapsed by default) would page a column that can never answer.
 * `expandColumn` is idempotent, so this is a no-op for an already-open column.
 *
 * KNOWN, BOUNDED RESIDUE — do not build a mechanism for it: if the detail read
 * neither answers nor fails (it is disabled or permanently in flight), no clock can
 * move and the round sits in `wait` until App voids the intent (the surface going
 * away). It never misreports absence and writes no state.
 */
export interface BoardRevealRead {
  /** The target as this surface's RENDERED rows hold it, or `null`. */
  target: { status: TaskStatus } | null;
  /** The target is loaded but outside this surface's window. */
  canWiden: boolean;
  /** Widen this surface's window over the loaded row. */
  widen: () => void;
  /** The target's column may still hold pages the server has not sent. */
  canFetch: boolean;
  /** Fetch one more page of the target's column. */
  page: () => void;
  /** Is a column known to own the target at all? */
  authorityKnown: boolean;
  /** Which read the clocks below belong to (`(status, filterKey)` + the failure
   *  axis' composition), or `null` while no column owns the target. */
  authority: string | null;
  /** The target's own column read (or the detail read that locates it) in flight. */
  isFetching: boolean;
  /** The target column's newest successful read — the SUCCESS clock. */
  dataUpdatedAt: number;
  /** Failures of the reads this round depends on — the FAILURE axis. */
  errorUpdateCount: number;
  /** Force one authoritative re-read of the target column's loaded pages. */
  refetch: () => void;
}

export function useBoardReveal(args: {
  revealTaskId: string | null;
  /** Whether this surface can host the reveal at all (a closed drawer cannot). */
  active: boolean;
  columns: BoardColumns;
  /** The bound this surface actually renders against. */
  window: ColumnWindow;
  /** Render one more page of a column (window + fetch driver in one). */
  grow: (status: TaskStatus) => void;
  /** Widen a column so a loaded row at `index` renders. */
  coverIndex: (status: TaskStatus, index: number) => void;
}): BoardRevealRead {
  const { revealTaskId, active, columns, window: renderWindow } = args;
  const { grow, coverIndex } = args;
  const revealing = active && revealTaskId !== null;

  const detail = useTaskDetail(revealTaskId, { enabled: revealing });
  const targetStatus = revealing ? (detail.data?.status ?? null) : null;

  useEffect(() => {
    if (targetStatus === null) return;
    expandColumn(targetStatus);
  }, [targetStatus]);

  // Where the target sits in the rows this surface has LOADED (any column, so a
  // detail projection that lags a status change cannot hide a rendered row).
  const located = useMemo(() => {
    if (revealTaskId === null) return null;
    for (const status of TaskStatusSchema.options) {
      const index = columns[status].items.findIndex(t => t.id === revealTaskId);
      if (index >= 0) return { status, index };
    }
    return null;
  }, [columns, revealTaskId]);

  const rendered =
    located !== null &&
    located.index < columnVisibleCount(renderWindow, located.status);

  const target = useMemo(
    () => (located !== null && rendered ? { status: located.status } : null),
    [located, rendered],
  );

  // Loaded but past the window → one covering write reaches it, no read involved.
  const canWiden = located !== null && !rendered;

  // THE ONE COLUMN THAT MAY ANSWER for this target: where it already sits if this
  // surface has loaded it, otherwise where the detail read says it lives. Nothing
  // else can vouch for its absence, so nothing else contributes evidence.
  const authorityStatus = located?.status ?? targetStatus;
  const authorityColumn =
    authorityStatus !== null ? columns[authorityStatus] : null;

  // Not loaded → the column must fetch, which growing its window is what asks for.
  const canFetch =
    located === null && authorityColumn !== null && !authorityColumn.atEnd;

  // The detail read joins the WAIT and FAILURE axes while it is what locates the
  // target: concluding absence while it is in flight would be premature, and its
  // failure means this round has no candidate column at all — which must end the
  // round rather than let some other read answer for it. Once the row is located it
  // drops out of both, which is a change of composition and therefore part of the
  // identity below.
  const detailAnswers = revealing && located === null;
  const authority =
    authorityColumn === null
      ? null
      : `${detailAnswers ? 'detail' : 'row'}|${authorityColumn.identity}`;

  return {
    target,
    canWiden,
    widen: () => {
      if (located !== null) coverIndex(located.status, located.index);
    },
    canFetch,
    page: () => {
      if (authorityStatus !== null) grow(authorityStatus);
    },
    authorityKnown: authority !== null,
    authority,
    isFetching:
      (authorityColumn?.isFetching ?? false) || (detailAnswers && detail.isFetching),
    dataUpdatedAt: authorityColumn?.dataUpdatedAt ?? 0,
    errorUpdateCount:
      (authorityColumn?.errorUpdateCount ?? 0) +
      (detailAnswers ? detail.errorUpdateCount : 0),
    refetch: () => {
      authorityColumn?.refetch();
    },
  };
}
