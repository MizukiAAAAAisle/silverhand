import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import {
  type TaskBoardColumnDto,
  type TaskBoardCountsDto,
  type TaskBoardFacetsDto,
  type TaskChangedEvent,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { api } from '@/lib/api';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';
import {
  boardAuthority,
  type BoardAuthority,
  type BoardCounts,
  type BoardFacets,
} from './boardAuthority';
import {
  boardColumnKey,
  boardColumnPath,
  boardCountsKey,
  boardCountsPath,
  boardFacetsKey,
  boardFacetsPath,
  boardFilterKey,
  boardFilterParams,
} from './boardQuery';
import { columnVisibleCount, type ColumnWindow } from './columnWindow';
import type { PersonOption, TaskFilters } from './taskFilters';
import { applyTaskChangedToTaskByNumberCache } from './useTaskByNumber';

/**
 * The task board's read layer (#task:1885 against the #task:1884 authority).
 *
 * One column = one `useInfiniteQuery` keyed by `(status, filterKey)`. Per-status
 * queries are what make the window honest: a column's pages advance
 * independently, so one busy column can never eat another's window, and the
 * counts a header shows come from the counts face rather than from however many
 * pages happened to be loaded.
 *
 * WHAT DRIVES FETCHING is the surface's render window, not the query: a column
 * fetches until it has as many pages as the surface wants to render
 * (`window[status]`). The window is surface-local while pages are shared cache
 * (see `columnWindow.ts`), so the drawer scrolling to page 5 leaves 5 pages
 * cached without the pane inheriting them as a render bound — and the closed
 * drawer, pinned to its first page, issues no reads at all.
 *
 * Pages are concatenated in REQUEST order and never re-sorted: the wire contract
 * (`TaskBoardColumnDtoSchema`) delivers `(task_number DESC, id DESC)` with each
 * page continuing strictly after the last, and `task_number` is only monotonic
 * per workspace — a local sort over the loaded prefix would disagree with what
 * the next page continues from. `next_cursor === null` is the ONLY end-of-column
 * signal; a full page can also be the last one.
 */

/** One status column as a surface consumes it. */
export interface BoardColumnRead {
  /** Loaded rows, in delivered order. */
  items: TaskSummaryDto[];
  /** First window still in flight (nothing to render yet). */
  isLoading: boolean;
  isError: boolean;
  /** The column has no further pages (`next_cursor === null`). */
  atEnd: boolean;
  /** Any page of this column is in flight. */
  isFetching: boolean;
  /**
   * WHICH READ these clocks belong to: `(status, filterKey)`. The clocks below
   * are only comparable within one identity — a filter change swaps the query
   * behind this column, and the new one starts at `dataUpdatedAt: 0` /
   * `errorUpdateCount: 0`. Anything treating a clock as evidence must re-baseline
   * when this string changes, or it reads a query swap as a fresh answer
   * (#task:1885, Cindy MUST FIX).
   */
  identity: string;
  /** Latest successful read / failure clocks for THIS column under THIS identity
   *  — the reveal machine's evidence axes (`useRevealTaskRow`). */
  dataUpdatedAt: number;
  errorUpdateCount: number;
  /** Re-read this column's loaded pages. Scoped deliberately: a round that needs
   *  this column's answer must not be satisfiable by another column's. */
  refetch: () => void;
}

export type BoardColumns = Readonly<Record<TaskStatus, BoardColumnRead>>;

const EMPTY_ITEMS: TaskSummaryDto[] = [];

function useBoardColumn(
  status: TaskStatus,
  filterKey: string,
  filters: TaskFilters,
  enabled: boolean,
  wantedPages: number,
): BoardColumnRead {
  const query = useInfiniteQuery<
    TaskBoardColumnDto,
    Error,
    InfiniteData<TaskBoardColumnDto, string | null>,
    ReturnType<typeof boardColumnKey>,
    string | null
  >({
    queryKey: boardColumnKey(status, filterKey),
    enabled,
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api<TaskBoardColumnDto>(
        boardColumnPath(status, boardFilterParams(filters), pageParam),
        { signal },
      ),
    getNextPageParam: lastPage => lastPage.next_cursor,
  });

  const loadedPages = query.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  // The window asks, the query answers. Page N+1 is fetched only because some
  // surface wants to render it — there is no prefetch-ahead and no polling, so
  // the read cost of a board nobody is looking at is zero.
  useEffect(() => {
    if (!enabled) return;
    // No first page yet: it is already in flight (or the query is off). Asking
    // for a next page here would fetch the same window twice.
    if (loadedPages === 0) return;
    if (loadedPages >= wantedPages) return;
    if (!hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [
    enabled,
    loadedPages,
    wantedPages,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  ]);

  const items = useMemo(
    () => query.data?.pages.flatMap(p => p.items) ?? EMPTY_ITEMS,
    [query.data],
  );

  const { isLoading, isError, isFetching, dataUpdatedAt, errorUpdateCount, refetch } =
    query;

  return useMemo(
    () => ({
      items,
      isLoading,
      isError,
      atEnd: !hasNextPage,
      isFetching,
      identity: `${status}|${filterKey}`,
      dataUpdatedAt,
      errorUpdateCount,
      refetch: () => {
        void refetch();
      },
    }),
    [
      items,
      isLoading,
      isError,
      hasNextPage,
      isFetching,
      status,
      filterKey,
      dataUpdatedAt,
      errorUpdateCount,
      refetch,
    ],
  );
}

/**
 * Every column of ONE board surface.
 *
 * `isCollapsed` gates a column's reads: a collapsed column renders no body, so
 * it must not fetch one — that is what keeps a Closed column (the largest one on
 * a mature board) free until the reader opens it. Its header count still comes
 * from the counts face, so collapsing hides rows without hiding the total.
 *
 * The five hooks are written out rather than mapped so hook order is fixed by
 * the code, not by the contents of a status array.
 */
export function useBoardColumns(args: {
  filters: TaskFilters;
  /** Surface-level gate (a closed drawer reads nothing). */
  enabled: boolean;
  window: ColumnWindow;
  isCollapsed: (status: TaskStatus) => boolean;
}): BoardColumns {
  const { filters, enabled, window, isCollapsed } = args;
  const filterKey = boardFilterKey(filters);
  const pages = (status: TaskStatus) => window[status];
  const on = (status: TaskStatus) => enabled && !isCollapsed(status);

  const todo = useBoardColumn('todo', filterKey, filters, on('todo'), pages('todo'));
  const inProgress = useBoardColumn(
    'in_progress',
    filterKey,
    filters,
    on('in_progress'),
    pages('in_progress'),
  );
  const inReview = useBoardColumn(
    'in_review',
    filterKey,
    filters,
    on('in_review'),
    pages('in_review'),
  );
  const done = useBoardColumn('done', filterKey, filters, on('done'), pages('done'));
  const closed = useBoardColumn(
    'closed',
    filterKey,
    filters,
    on('closed'),
    pages('closed'),
  );

  return useMemo(
    () => ({
      todo,
      in_progress: inProgress,
      in_review: inReview,
      done,
      closed,
    }),
    [todo, inProgress, inReview, done, closed],
  );
}

/** Rows this surface may render for one column — the window bound applied to
 *  the loaded prefix. */
export function boardVisibleItems(
  column: BoardColumnRead,
  window: ColumnWindow,
  status: TaskStatus,
): TaskSummaryDto[] {
  const bound = columnVisibleCount(window, status);
  return column.items.length > bound ? column.items.slice(0, bound) : column.items;
}

/** Whether growing this column's window would reveal anything more — either
 *  loaded-but-unrendered rows, or a page the server still has. */
export function boardColumnCanGrow(
  column: BoardColumnRead,
  window: ColumnWindow,
  status: TaskStatus,
): boolean {
  return (
    column.items.length > columnVisibleCount(window, status) || !column.atEnd
  );
}

/**
 * The authoritative per-status totals under the current filters — the ONE
 * source for a column header's number and for the titlebar badge.
 *
 * Returns the AUTHORITY, not a `BoardCounts`: the face always carries all five
 * statuses, so a zeroed fallback would be indistinguishable from a real answer
 * and a column whose body holds rows could print an authoritative `0` in its
 * header. Unknown-ness comes from the query state alone — never from the value
 * (see `boardAuthority.ts`). No count is ever maintained by `±1` on an event.
 */
export function useBoardCounts(
  filters: TaskFilters,
  opts?: { enabled?: boolean },
): BoardAuthority<BoardCounts> {
  const enabled = opts?.enabled ?? true;
  const query = useQuery({
    queryKey: boardCountsKey(boardFilterKey(filters)),
    enabled,
    queryFn: ({ signal }) =>
      api<TaskBoardCountsDto>(boardCountsPath(boardFilterParams(filters)), {
        signal,
      }),
    select: dto => dto.counts as BoardCounts,
  });
  const { data, isError } = query;
  return useMemo(() => boardAuthority({ data, isError }), [data, isError]);
}

/**
 * The filter menus' option sets.
 *
 * Deliberately unfiltered and unpaginated at the source: option sets must not
 * shrink to the current selection (else picking one person collapses the menu to
 * that person), and they must not shrink to "whoever appeared in the pages we
 * happened to load" — which is exactly what aggregating them from the rendered
 * rows would now do.
 *
 * Returns the AUTHORITY for the same reason as the counts face, with the sharper
 * edge that here the empty answer is meaningful: a viewer whose visible
 * population really is empty is answered `[]`, so a failed cold read must not be
 * able to present itself as that (#task:1885).
 */
export function useBoardFacets(opts?: {
  enabled?: boolean;
}): BoardAuthority<BoardFacets> {
  const enabled = opts?.enabled ?? true;
  const query = useQuery({
    queryKey: boardFacetsKey(),
    enabled,
    queryFn: ({ signal }) =>
      api<TaskBoardFacetsDto>(boardFacetsPath(), { signal }),
    select: (dto): BoardFacets => {
      const toOptions = (
        people: TaskBoardFacetsDto['assignees'],
      ): PersonOption[] =>
        people.map(p => ({ person: { type: p.type, id: p.id }, name: p.name }));
      return {
        assignees: toOptions(dto.assignees),
        creators: toOptions(dto.creators),
        hasUnassigned: dto.has_unassigned,
      };
    },
  });
  const { data, isError } = query;
  return useMemo(() => boardAuthority({ data, isError }), [data, isError]);
}

/**
 * Keep a mounted board fresh (viewer scope: the server fans `task_changed` out
 * to each human member of the task's conversation, so one subscription covers
 * every conversation the viewer belongs to, across workspaces).
 *
 * ONE OWNER: called by App, never by a board surface. App is the ancestor of both
 * surfaces AND of the titlebar badge, so a single listener there keeps every
 * board projection fresh whether a board is mounted or not. Two listeners would
 * not be a free dedup — a second `invalidateQueries` on a key that already has
 * data CANCELS the in-flight refetch and restarts it (`cancelRefetch` defaults to
 * true), so each event would cost an extra round trip per surface.
 *
 * INVALIDATE, never patch. A board holds a paginated prefix of five columns plus
 * two server aggregates, so a patched row cannot be placed: the event carries no
 * `previous_status`, page boundaries move when a row leaves a column, and counts
 * / facets are `GROUP BY` results that no client-side `±1` can reproduce. The
 * cost of re-reading instead of patching is what the window bounds — a refresh
 * re-reads the loaded pages (normally one per column), where the pre-window board
 * re-downloaded every task.
 *
 * The precision below is only what the event itself proves:
 *   - column bodies: ALWAYS all five. Without `previous_status`, the after-state
 *     cannot identify the column a task LEFT, so a selective refresh would leave
 *     the source column showing a row that moved out of it.
 *   - counts: every kind except `edit` (title/body only — it cannot change a
 *     status). `claim` and `unclaim` are included because both dispatch a status
 *     in the same write on one of their paths (`todo → in_progress` on claim,
 *     back to `todo` on release) and the payload does not distinguish them.
 *   - facets: `create` / `claim` / `unclaim` — the kinds that can change who
 *     appears as an assignee. `status` writes only `status`/`closed_at`.
 */
export function useTaskBoardRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      if (frame.type === 'snapshot_required') {
        if (isCurrentViewerScope(frame.scope)) {
          void qc.invalidateQueries({ queryKey: ['task-by-number'] });
          void qc.invalidateQueries({ queryKey: ['tasks'] });
        }
        return;
      }
      if (frame.type !== 'event') return;
      if (frame.kind !== 'task_changed' || !isCurrentViewerScope(frame.scope)) {
        return;
      }
      const payload = frame.payload as TaskChangedEvent;
      applyTaskChangedToTaskByNumberCache(qc, payload);
      void qc.invalidateQueries({ queryKey: ['tasks', 'board', 'column'] });
      if (payload.kind !== 'edit') {
        void qc.invalidateQueries({ queryKey: ['tasks', 'board', 'counts'] });
      }
      if (
        payload.kind === 'create' ||
        payload.kind === 'claim' ||
        payload.kind === 'unclaim'
      ) {
        void qc.invalidateQueries({ queryKey: boardFacetsKey() });
      }
      // `['task-detail', id]` is deliberately untouched: `useTaskDetail` owns
      // that projection's realtime edge (ONE owner per projection), and the
      // detail modal opens with no board behind it.
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}
