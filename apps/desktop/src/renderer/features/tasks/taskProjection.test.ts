import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  TaskBoardColumnDto,
  TaskChangedEvent,
  TaskDetailDto,
  TaskStatus,
  TaskSummaryDto,
} from '@silverhand/shared';
import { boardColumnKey, boardCountsKey, boardFacetsKey } from './boardQuery';
import { taskDetailKey } from './taskDetail';
import { taskBoardCacheScope, taskByNumberKey } from './useTaskByNumber';
import {
  applyTaskChangedToProjections,
  beginOptimisticStatusWrite,
  insertTaskIntoColumnPages,
  locateTaskInBoardColumns,
  moveTaskStatusInBoardColumns,
  optimisticClosedAt,
  patchTaskPointCaches,
  reconcileTaskStatusWrite,
  removeTaskFromColumnPages,
  restartRacingTaskReads,
  revertOptimisticStatusWrite,
  taskRowPrecedes,
  type BoardColumnPages,
} from './taskProjection';

/**
 * The task-status projection contract (#task:1975).
 *
 * Two layers, tested as two layers:
 *
 *   - the PAGE ALGEBRA — pure functions over a column's cached pages. This is
 *     where "a locally moved row is a row the server would have returned in that
 *     page" is either true or a duplicate/dropped card on the next fetch.
 *   - the REQUEST BUDGET — the acceptance criterion that cannot be read off the
 *     code: how many HTTP reads ONE status change costs, across local success,
 *     local failure, a self echo, a remote event, rapid consecutive changes, and
 *     an event that overtakes its own ACK. Asserted with real `QueryObserver`s
 *     over a real `QueryClient` and counted `queryFn`s, because a cache/request
 *     contract is the only falsifiable form of "does not refetch" (the desktop
 *     test env is `node`: no jsdom, no rendered hooks).
 */

const WS = 'ws-1';
// The by-number chip cache is keyed by BOARD scope, not by conversation
// (#task:2041 / B4): every conversation on one workspace board collapses to
// `workspace:<workspace_id>`, so a `task_changed` event reaches that single
// cell no matter which sibling conversation rendered the chip. `eventOf()`'s
// task sits on the `ws-1` board, so a chip keyed by this scope is its cell.
const SCOPE = taskBoardCacheScope({ workspaceId: WS, conversationId: 'chan-1' })!;
const FILTER = `${WS}|*|any|any`;
const OTHER_FILTER = `${WS}|chan-2|any|any`;

function row(over: Partial<TaskSummaryDto> = {}): TaskSummaryDto {
  return {
    id: 'task-a',
    task_number: 100,
    channel_id: 'chan-1',
    board: {
      kind: 'workspace',
      workspace_id: WS,
      workspace_name: 'ws',
      channel_name: 'chan',
    },
    thread_root_id: null,
    status: 'todo',
    title: 'a task',
    assignee: null,
    creator: { type: 'user', id: 'u1', name: 'Shiki' },
    created_at: 1000,
    closed_at: null,
    ...over,
  };
}

function detailOf(over: Partial<TaskDetailDto> = {}): TaskDetailDto {
  return {
    ...row(),
    content: 'body',
    last_editor: null,
    last_edited_at: null,
    source_message_id: 'msg-1',
    nav: { kind: 'unavailable' },
    ...over,
  };
}

function page(
  items: TaskSummaryDto[],
  next_cursor: string | null = null,
  status: TaskStatus = 'todo',
): TaskBoardColumnDto {
  return { status, items, next_cursor };
}

function pages(...list: TaskBoardColumnDto[]): BoardColumnPages {
  return {
    pages: list,
    pageParams: list.map((_, i) => (i === 0 ? null : `cursor-${i}`)),
  } as InfiniteData<TaskBoardColumnDto, string | null>;
}

function eventOf(over: Partial<TaskChangedEvent> = {}): TaskChangedEvent {
  return {
    kind: 'status',
    workspace_id: WS,
    channel_id: 'chan-1',
    thread_root_id: null,
    conversation_id: 'chan-1',
    task_number: 100,
    task_id: 'task-a',
    source_message_id: 'msg-1',
    status: 'in_progress',
    assignee: null,
    title: 'a task',
    closed_at: null,
    ...over,
  };
}

// ── Page algebra ───────────────────────────────────────────────────

describe('wire order', () => {
  it('is task_number DESC with id DESC as the tiebreak', () => {
    expect(taskRowPrecedes({ id: 'b', task_number: 101 }, { id: 'a', task_number: 100 })).toBe(true);
    expect(taskRowPrecedes({ id: 'a', task_number: 100 }, { id: 'b', task_number: 101 })).toBe(false);
    // Same number (possible across workspaces on the default board variant):
    // `id DESC` decides, so the order stays total.
    expect(taskRowPrecedes({ id: 'b', task_number: 100 }, { id: 'a', task_number: 100 })).toBe(true);
    expect(taskRowPrecedes({ id: 'a', task_number: 100 }, { id: 'b', task_number: 100 })).toBe(false);
  });
});

describe('removeTaskFromColumnPages', () => {
  it('drops the row from its page and returns it, leaving cursors untouched', () => {
    const target = row({ id: 'task-b', task_number: 99 });
    const before = pages(
      page([row({ task_number: 100 }), target], 'cursor-1'),
      page([row({ id: 'task-c', task_number: 98 })]),
    );
    const cut = removeTaskFromColumnPages(before, 'task-b');
    expect(cut?.row).toBe(target);
    expect(cut?.pages.pages[0]?.items.map(t => t.id)).toEqual(['task-a']);
    // A cursor is a POSITION in the surviving order, not an offset: page 1 still
    // continues from exactly where it did, so a 19-row page is correct.
    expect(cut?.pages.pages[0]?.next_cursor).toBe('cursor-1');
    expect(cut?.pages.pages[1]?.items.map(t => t.id)).toEqual(['task-c']);
  });

  it('answers null when this column does not hold the row', () => {
    expect(removeTaskFromColumnPages(pages(page([row()])), 'nope')).toBeNull();
  });
});

describe('insertTaskIntoColumnPages', () => {
  const loaded = pages(
    page([row({ id: 't-100', task_number: 100 }), row({ id: 't-90', task_number: 90 })], 'cursor-1'),
    page([row({ id: 't-80', task_number: 80 }), row({ id: 't-70', task_number: 70 })], 'cursor-2'),
  );

  it('places the row at its ordered position inside the page that covers it', () => {
    const next = insertTaskIntoColumnPages(loaded, row({ id: 'new', task_number: 95 }));
    expect(next?.pages[0]?.items.map(t => t.id)).toEqual(['t-100', 'new', 't-90']);
    expect(next?.pages[0]?.next_cursor).toBe('cursor-1');
    expect(next?.pages[1]?.items.map(t => t.id)).toEqual(['t-80', 't-70']);
  });

  it('places it in a later loaded page when it sorts past the first', () => {
    const next = insertTaskIntoColumnPages(loaded, row({ id: 'new', task_number: 75 }));
    expect(next?.pages[0]?.items.map(t => t.id)).toEqual(['t-100', 't-90']);
    expect(next?.pages[1]?.items.map(t => t.id)).toEqual(['t-80', 'new', 't-70']);
  });

  it('DROPS a row that belongs to the unloaded tail', () => {
    // Sorting after every loaded row while the column still has pages means the
    // server will deliver it in a page we have not fetched. Appending it here
    // would show it twice as soon as that page arrives.
    expect(insertTaskIntoColumnPages(loaded, row({ id: 'new', task_number: 10 }))).toBeNull();
  });

  it('appends only when the column is fully loaded', () => {
    const complete = pages(page([row({ id: 't-100', task_number: 100 })], null));
    const next = insertTaskIntoColumnPages(complete, row({ id: 'new', task_number: 10 }));
    expect(next?.pages[0]?.items.map(t => t.id)).toEqual(['t-100', 'new']);
  });
});

describe('optimisticClosedAt', () => {
  it('mirrors the server formula except for the stamp it cannot compute', () => {
    // Every non-closed status clears it — determinable.
    expect(optimisticClosedAt(1234, 'in_progress')).toBeNull();
    expect(optimisticClosedAt(null, 'todo')).toBeNull();
    // Re-closing an already-closed task keeps the existing stamp — determinable.
    expect(optimisticClosedAt(1234, 'closed')).toBe(1234);
    // Closing a task that was never closed: the server stamps `Date.now()`, so
    // the client leaves it unknown rather than inventing a timestamp.
    expect(optimisticClosedAt(null, 'closed')).toBeNull();
  });
});

// ── Cache-level projection ─────────────────────────────────────────

/** Seed one filter scope's columns. */
function seedColumns(
  qc: QueryClient,
  filterKey: string,
  byStatus: Partial<Record<TaskStatus, BoardColumnPages>>,
): void {
  for (const [status, value] of Object.entries(byStatus)) {
    qc.setQueryData(boardColumnKey(status as TaskStatus, filterKey), value);
  }
}

describe('locateTaskInBoardColumns', () => {
  it('reports the column each filter scope holds the row in — the source column the event never carries', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row()])),
      in_progress: pages(page([])),
    });
    seedColumns(qc, OTHER_FILTER, { in_review: pages(page([row({ status: 'in_review' })])) });

    const held = locateTaskInBoardColumns(qc, 'task-a');
    expect(held.map(h => [h.filterKey, h.status])).toEqual([
      [FILTER, 'todo'],
      [OTHER_FILTER, 'in_review'],
    ]);
    expect(locateTaskInBoardColumns(qc, 'nope')).toEqual([]);
  });
});

describe('moveTaskStatusInBoardColumns', () => {
  it('moves the held row into the destination column and reports the pair', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row(), row({ id: 'task-b', task_number: 90 })])),
      in_progress: pages(page([row({ id: 'task-c', task_number: 110, status: 'in_progress' })])),
    });

    const projection = moveTaskStatusInBoardColumns(qc, {
      taskId: 'task-a',
      status: 'in_progress',
    });

    expect(projection.moves).toMatchObject([
      { filterKey: FILTER, from: 'todo', to: 'in_progress', placed: true },
    ]);
    // The move retains the row AS IT WAS, which is the rollback path's only way
    // back when a destination column cannot hold it (see `placed: false` below).
    expect(projection.moves[0]?.row).toMatchObject({ id: 'task-a', status: 'todo' });
    const from = qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER));
    const to = qc.getQueryData<BoardColumnPages>(boardColumnKey('in_progress', FILTER));
    expect(from?.pages[0]?.items.map(t => t.id)).toEqual(['task-b']);
    // Ordered placement, and the row carried over WHOLE — the fields the event
    // does not have (`board.workspace_name`, `creator`, `created_at`) come from the row
    // itself, so the moved card renders identically.
    expect(to?.pages[0]?.items.map(t => t.id)).toEqual(['task-c', 'task-a']);
    expect(to?.pages[0]?.items[1]).toMatchObject({
      status: 'in_progress',
      board: { kind: 'workspace', workspace_name: 'ws' },
      creator: { name: 'Shiki' },
    });
  });

  it('reports a scope whose window cannot place the row as unknown', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, { todo: pages(page([row()])) });
    seedColumns(qc, OTHER_FILTER, { todo: pages(page([])) });

    const projection = moveTaskStatusInBoardColumns(qc, {
      taskId: 'task-a',
      status: 'done',
    });
    // `placed: false` — the `done` column is not cached in this scope, so after
    // the move the row is in no column at all.
    expect(projection.moves).toMatchObject([
      { filterKey: FILTER, from: 'todo', to: 'done', placed: false },
    ]);
    expect(projection.unknownFilterKeys).toEqual([OTHER_FILTER]);
  });

  it('is a compare-and-swap when expectStatus is given', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([])),
      in_review: pages(page([row({ status: 'in_review' })])),
      done: pages(page([])),
    });
    // The rollback of a `todo → done` write, arriving after an event already put
    // the task in `in_review`: the row no longer reads what we wrote, so it is
    // left alone rather than dragged back to `todo`.
    const projection = moveTaskStatusInBoardColumns(qc, {
      taskId: 'task-a',
      status: 'todo',
      expectStatus: 'done',
    });
    expect(projection.moves).toEqual([]);
    expect(
      qc.getQueryData<BoardColumnPages>(boardColumnKey('in_review', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-a']);
  });
});

describe('patchTaskPointCaches', () => {
  it('patches the detail and every chip entry that holds this task, by content', () => {
    const qc = new QueryClient();
    qc.setQueryData(taskDetailKey('task-a'), detailOf());
    qc.setQueryData(taskByNumberKey(SCOPE, 100), row());
    qc.setQueryData(taskByNumberKey(SCOPE, 7), row({ id: 'other', task_number: 7 }));

    patchTaskPointCaches(qc, { taskId: 'task-a', patch: { status: 'done' } });

    expect(qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.status).toBe('done');
    // The body is untouched: a status patch never claims to know the definition.
    expect(qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.content).toBe('body');
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('done');
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 7))?.status).toBe('todo');
  });
});

describe('applyTaskChangedToProjections', () => {
  it('assigns the snapshot and asks for no reconciliation when nothing changed', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, { in_progress: pages(page([row({ status: 'in_progress' })])) });

    const outcome = applyTaskChangedToProjections(qc, eventOf({ title: 'renamed' }));

    expect(outcome.needsReconcile).toBe(false);
    expect(
      qc.getQueryData<BoardColumnPages>(boardColumnKey('in_progress', FILTER))?.pages[0]
        ?.items[0],
    ).toMatchObject({ title: 'renamed', status: 'in_progress' });
  });

  it('writes NOTHING when the snapshot says what the cache already reads', () => {
    const qc = new QueryClient();
    const seeded = pages(page([row({ status: 'in_progress' })]));
    seedColumns(qc, FILTER, { in_progress: seeded });
    const seededDetail = detailOf({ status: 'in_progress' });
    qc.setQueryData(taskDetailKey('task-a'), seededDetail);

    applyTaskChangedToProjections(qc, eventOf());

    // Object identity, not deep equality: a no-news echo that rebuilt an equal
    // row would still count as a cache write, and every read in flight on those
    // keys would be restarted for nothing.
    expect(qc.getQueryData(boardColumnKey('in_progress', FILTER))).toBe(seeded);
    expect(qc.getQueryData(taskDetailKey('task-a'))).toBe(seededDetail);
  });

  it('reconciles when the status or the assignee is news', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row()])),
      in_progress: pages(page([])),
    });
    expect(applyTaskChangedToProjections(qc, eventOf()).needsReconcile).toBe(true);

    // Same status, new assignee — a membership fact for the assignee filter axis.
    const qc2 = new QueryClient();
    seedColumns(qc2, FILTER, { todo: pages(page([row()])) });
    const outcome = applyTaskChangedToProjections(
      qc2,
      eventOf({
        kind: 'claim',
        status: 'todo',
        assignee: { type: 'agent', id: 'agent-1', name: 'Norman' },
      }),
    );
    expect(outcome.needsReconcile).toBe(true);
  });

  it('reconciles a task no cache holds — absence is not evidence', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, { todo: pages(page([])) });
    const outcome = applyTaskChangedToProjections(qc, eventOf({ kind: 'create' }));
    expect(outcome.needsReconcile).toBe(true);
  });

  it('leaves an `edit`s detail to be re-read, and settles every other kind', () => {
    const qc = new QueryClient();
    expect(applyTaskChangedToProjections(qc, eventOf({ kind: 'edit' })).detailSettled).toBe(
      false,
    );
    expect(applyTaskChangedToProjections(qc, eventOf()).detailSettled).toBe(true);
  });
});

// ── Request budget (acceptance #2 / #3 / #4 / #6) ──────────────────

/**
 * Attach a real observer so the query is ACTIVE and an invalidation actually
 * costs a request. Pre-seeded + `staleTime: Infinity` means subscribing alone
 * fetches nothing, so every counted fetch came from the contract under test.
 *
 * The probe answers with WHAT THE CACHE CURRENTLY HOLDS, i.e. an authority that
 * agrees with the projection — which is the premise these tests are counting
 * requests against. Replaying the original seed instead would have the reconcile
 * round hand back pre-write rows and fabricate a regression the real server
 * cannot produce.
 */
function observe(
  qc: QueryClient,
  queryKey: readonly unknown[],
  data: unknown,
): { fetches: () => number; stop: () => void } {
  let fetches = 0;
  qc.setQueryData(queryKey, data);
  const observer = new QueryObserver(qc, {
    queryKey: [...queryKey],
    queryFn: async () => {
      fetches += 1;
      return qc.getQueryData(queryKey) ?? data;
    },
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => {});
  return { fetches: () => fetches, stop };
}

interface Board {
  qc: QueryClient;
  columns: Record<string, { fetches: () => number }>;
  counts: { fetches: () => number };
  facets: { fetches: () => number };
  detail: { fetches: () => number };
  chip: { fetches: () => number };
  stop: () => void;
}

/** One expanded board (four visible columns), its two aggregates, an open detail
 *  modal and one inline chip — the surface mix Cindy traced the 8/4/4/1 storm
 *  on. `task-a` sits in `todo`. */
function board(): Board {
  const qc = new QueryClient();
  const stops: Array<() => void> = [];
  const columns: Record<string, { fetches: () => number }> = {};
  for (const status of ['todo', 'in_progress', 'in_review', 'done'] as const) {
    const probe = observe(
      qc,
      boardColumnKey(status, FILTER),
      status === 'todo'
        ? pages(page([row(), row({ id: 'task-b', task_number: 90 })]))
        : pages(page([], null, status)),
    );
    columns[status] = probe;
    stops.push(probe.stop);
  }
  const counts = observe(qc, boardCountsKey(FILTER), { counts: {} });
  const facets = observe(qc, boardFacetsKey(), { assignees: [] });
  const detail = observe(qc, taskDetailKey('task-a'), detailOf());
  const chip = observe(qc, taskByNumberKey(SCOPE, 100), row());
  stops.push(counts.stop, facets.stop, detail.stop, chip.stop);
  return {
    qc,
    columns,
    counts,
    facets,
    detail,
    chip,
    stop: () => stops.forEach(s => s()),
  };
}

/** The hook's own sequence, seam by seam (`useUpdateTaskStatus`). */
function localWrite(qc: QueryClient, status: TaskStatus) {
  return beginOptimisticStatusWrite(qc, { taskId: 'task-a', status });
}

async function settled(): Promise<void> {
  await vi.waitFor(() => Promise.resolve());
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('request budget for one status change', () => {
  it('moves the card before the write, and re-reads only the column pair + counts', async () => {
    const b = board();
    const write = localWrite(b.qc, 'in_progress');

    // Acceptance #1: the card has already moved — no request has been made yet.
    expect(
      b.qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-b']);
    expect(
      b.qc.getQueryData<BoardColumnPages>(boardColumnKey('in_progress', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-a']);
    expect(b.qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.status).toBe(
      'in_progress',
    );
    expect(b.qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe(
      'in_progress',
    );
    expect(b.columns.todo?.fetches()).toBe(0);

    restartRacingTaskReads(b.qc, write.taskId);
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
    await settled();

    // Acceptance #4: source + destination only. The two columns that were never
    // involved are not re-read, and neither is the detail (the snapshot settled
    // it) or the chip (patched in place).
    expect(b.columns.todo?.fetches()).toBe(1);
    expect(b.columns.in_progress?.fetches()).toBe(1);
    expect(b.columns.in_review?.fetches()).toBe(0);
    expect(b.columns.done?.fetches()).toBe(0);
    expect(b.counts.fetches()).toBe(1);
    expect(b.detail.fetches()).toBe(0);
    expect(b.chip.fetches()).toBe(0);
    // Acceptance #3, and the falsifier for the old root invalidation: a status
    // write cannot change the assignee/creator population, so a facets request
    // here means someone widened the key again.
    expect(b.facets.fetches()).toBe(0);
    b.stop();
  });

  it('costs ONE re-read of the detail when it closes a task, because that stamp is the server’s', async () => {
    const b = board();
    const write = localWrite(b.qc, 'closed');
    expect(write.closedAtUnknown).toBe(true);
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
    await settled();
    expect(b.detail.fetches()).toBe(1);
    b.stop();
  });

  it('spends NOTHING on the write’s own echo (acceptance #2)', async () => {
    const b = board();
    const write = localWrite(b.qc, 'in_progress');
    restartRacingTaskReads(b.qc, write.taskId);
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
    await settled();
    const before = {
      todo: b.columns.todo?.fetches(),
      in_progress: b.columns.in_progress?.fetches(),
      counts: b.counts.fetches(),
    };

    // The same commit arriving on the viewer scope. No mutation identity, no
    // `previous_status`, no timing window — the caches already agree, so there
    // is no news and nothing is re-read.
    const outcome = applyTaskChangedToProjections(b.qc, eventOf());
    expect(outcome.needsReconcile).toBe(false);
    await settled();

    expect(b.columns.todo?.fetches()).toBe(before.todo);
    expect(b.columns.in_progress?.fetches()).toBe(before.in_progress);
    expect(b.counts.fetches()).toBe(before.counts);
    expect(b.facets.fetches()).toBe(0);
    b.stop();
  });

  it('is idempotent under a duplicate delivery (two scopes, replay)', async () => {
    const b = board();
    applyTaskChangedToProjections(b.qc, eventOf());
    const first = b.columns.todo?.fetches();
    const outcome = applyTaskChangedToProjections(b.qc, eventOf());
    await settled();
    // The row is not duplicated in the destination column, and the second
    // delivery asks for nothing.
    expect(
      b.qc.getQueryData<BoardColumnPages>(boardColumnKey('in_progress', FILTER))?.pages[0]
        ?.items.filter(t => t.id === 'task-a').length,
    ).toBe(1);
    expect(outcome.needsReconcile).toBe(false);
    expect(b.columns.todo?.fetches()).toBe(first);
    b.stop();
  });

  it('reverts a failed write and re-reads, without clobbering a newer authority', async () => {
    const b = board();
    const write = localWrite(b.qc, 'done');

    revertOptimisticStatusWrite(b.qc, write);
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: true });
    await settled();

    // Back where it was, and the authority was asked.
    expect(
      b.qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-a', 'task-b']);
    expect(b.qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.status).toBe('todo');
    expect(b.counts.fetches()).toBe(1);
    b.stop();
  });

  it('refuses to revert over a status that landed after the write', async () => {
    const b = board();
    const write = localWrite(b.qc, 'done');
    // A remote event moves it to `in_review` while our POST is still in flight.
    applyTaskChangedToProjections(b.qc, eventOf({ status: 'in_review' }));

    revertOptimisticStatusWrite(b.qc, write);

    // The newer authority stands: a snapshot restore would have shown `todo`
    // again and kept showing it until the next event.
    expect(
      b.qc.getQueryData<BoardColumnPages>(boardColumnKey('in_review', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-a']);
    expect(b.qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.status).toBe(
      'in_review',
    );
    b.stop();
  });

  it('costs one column PAIR per hop across consecutive changes', async () => {
    const b = board();
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      const write = localWrite(b.qc, status);
      reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
      applyTaskChangedToProjections(b.qc, eventOf({ status }));
      await settled();
    }

    // Exactly one row, in the last status asked for.
    expect(locateTaskInBoardColumns(b.qc, 'task-a').map(h => h.status)).toEqual(['done']);
    // Three hops = three pairs, so each column is read once as a destination and
    // once as the next hop's source. `todo` was only ever a source, `done` only
    // ever a destination. The retired root invalidation cost 4 columns × 2 owners
    // × 3 hops = 24 column reads plus 3 facets reads for the same three clicks.
    expect(b.columns.todo?.fetches()).toBe(1);
    expect(b.columns.in_progress?.fetches()).toBe(2);
    expect(b.columns.in_review?.fetches()).toBe(2);
    expect(b.columns.done?.fetches()).toBe(1);
    expect(b.counts.fetches()).toBe(3);
    expect(b.facets.fetches()).toBe(0);
    b.stop();
  });

  it('converges when the event overtakes its own ACK', async () => {
    const b = board();
    const write = localWrite(b.qc, 'in_progress');
    // Echo first…
    const outcome = applyTaskChangedToProjections(b.qc, eventOf());
    expect(outcome.needsReconcile).toBe(false);
    // …then the ACK's bounded round.
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
    await settled();

    expect(locateTaskInBoardColumns(b.qc, 'task-a').map(h => h.status)).toEqual([
      'in_progress',
    ]);
    expect(b.columns.in_progress?.fetches()).toBe(1);
    expect(b.facets.fetches()).toBe(0);
    b.stop();
  });

  it('re-reads every column of a filter scope that could not place the row', async () => {
    const b = board();
    // A second board scope (e.g. the drawer filtered to one channel) whose
    // window does not contain this task: it cannot say which column the row
    // left, so its columns are the honest re-read.
    const otherTodo = observe(b.qc, boardColumnKey('todo', OTHER_FILTER), pages(page([])));
    const otherDone = observe(b.qc, boardColumnKey('done', OTHER_FILTER), pages(page([])));

    const write = localWrite(b.qc, 'in_progress');
    expect(write.projection.unknownFilterKeys).toEqual([OTHER_FILTER]);
    reconcileTaskStatusWrite(b.qc, write.projection, { detail: write.closedAtUnknown });
    await settled();

    expect(otherTodo.fetches()).toBe(1);
    expect(otherDone.fetches()).toBe(1);
    expect(b.facets.fetches()).toBe(0);
    otherTodo.stop();
    otherDone.stop();
    b.stop();
  });

  it('restarts a point read that was already in flight, so it cannot commit pre-click state', async () => {
    const qc = new QueryClient();
    const resolvers: Array<(value: TaskSummaryDto) => void> = [];
    let chipFetches = 0;
    qc.setQueryData(taskByNumberKey(SCOPE, 100), row());
    const observer = new QueryObserver(qc, {
      queryKey: [...taskByNumberKey(SCOPE, 100)],
      queryFn: () =>
        new Promise<TaskSummaryDto>(resolve => {
          chipFetches += 1;
          resolvers.push(resolve);
        }),
      staleTime: 0,
    });
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(chipFetches).toBe(1));

    const write = localWrite(qc, 'in_progress');
    restartRacingTaskReads(qc, write.taskId);
    await vi.waitFor(() => expect(chipFetches).toBe(2));

    // The read issued before the click answers late, with pre-click state. Its
    // retryer was cancelled, so the response has nowhere to commit — the card
    // the user has already seen move does not flip back.
    resolvers[0]?.(row({ status: 'todo' }));
    await settled();
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe(
      'in_progress',
    );
    stop();
  });

  it('spends nothing on a CHIP-ONLY write and its own echo', async () => {
    const qc = new QueryClient();
    // A `TaskRef` popover in a message row: no board, no detail modal. The chip is
    // the only projection there is — and therefore the only evidence about the
    // task's current value.
    const chip = observe(qc, taskByNumberKey(SCOPE, 100), row());

    const write = localWrite(qc, 'in_progress');
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe(
      'in_progress',
    );
    restartRacingTaskReads(qc, write.taskId);
    reconcileTaskStatusWrite(qc, write.projection, { detail: write.closedAtUnknown });

    const outcome = applyTaskChangedToProjections(qc, eventOf());
    await settled();

    // Reading the chip as evidence is what makes this echo newsless. Treating it
    // as an auxiliary cache left `known` null — "no cache holds it" — and every
    // self echo then bought a full authoritative round for the one surface that
    // was already right.
    expect(outcome.needsReconcile).toBe(false);
    expect(chip.fetches()).toBe(0);
    chip.stop();
  });

  it('settles a chip-only FAILURE with exactly one authoritative read', async () => {
    const qc = new QueryClient();
    const chip = observe(qc, taskByNumberKey(SCOPE, 100), row());
    const write = localWrite(qc, 'done');

    revertOptimisticStatusWrite(qc, write);
    reconcileTaskStatusWrite(qc, write.projection, { detail: true, points: true });
    await settled();

    // The local rollback answers immediately; `points` is what makes the failure
    // path TOTAL — the cases the rollback deliberately declines (a superseded
    // write, a baseline no cache carried) still end on a server value.
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('todo');
    expect(chip.fetches()).toBe(1);
    chip.stop();
  });
});

/**
 * A probe whose responses this test HOLDS: seeded + `staleTime: 0`, so
 * subscribing puts one read in flight immediately and it stays there until the
 * test resolves it. That in-flight read is the state both "who owns this key"
 * bugs need: a second owner shows up as one extra fetch on the same key.
 *
 * Omit `seed` for a COLD read — an entry that exists with a request in flight and
 * NO data yet (`data === undefined`), which is what a chip or a modal looks like
 * on its first paint. No patch can reach that state, so a restart is the only
 * thing between the user and a pre-event first paint (`staleTime` does not re-read
 * on a timer, so nothing corrects it afterwards).
 */
function observeInFlight(
  qc: QueryClient,
  queryKey: readonly unknown[],
  seed?: unknown,
): {
  fetches: () => number;
  answer: (index: number, value: unknown) => void;
  stop: () => void;
} {
  let fetches = 0;
  const resolvers: Array<(value: unknown) => void> = [];
  if (seed !== undefined) qc.setQueryData(queryKey, seed);
  const observer = new QueryObserver(qc, {
    queryKey: [...queryKey],
    queryFn: () =>
      new Promise(resolve => {
        fetches += 1;
        resolvers.push(resolve);
      }),
    staleTime: 0,
  });
  const stop = observer.subscribe(() => {});
  return {
    fetches: () => fetches,
    answer: (index, value) => resolvers[index]?.(value),
    stop,
  };
}

// ── One refetch owner per key ──────────────────────────────────────
//
// A second `invalidateQueries` on a key does not merge with the first: with
// `cancelRefetch` defaulting to true it CANCELS the in-flight read and starts
// another, so two owners cost a whole extra round trip each. The rule this
// section pins: a key the authoritative round is going to re-read belongs to
// that round alone, and only a patch nobody will follow restarts its own racing
// read (Cindy, #task:1975).

describe('single refetch owner', () => {
  it('spends ONE post-event read per column when source and destination are already fetching', async () => {
    const qc = new QueryClient();
    const todo = observeInFlight(
      qc,
      boardColumnKey('todo', FILTER),
      pages(page([row()])),
    );
    const dest = observeInFlight(
      qc,
      boardColumnKey('in_progress', FILTER),
      pages(page([], null, 'in_progress')),
    );
    await vi.waitFor(() => expect(todo.fetches()).toBe(1));
    await vi.waitFor(() => expect(dest.fetches()).toBe(1));

    // A genuine remote status change: it moves the row AND needs a bounded
    // authoritative round, so the round owns both columns.
    const outcome = applyTaskChangedToProjections(qc, eventOf());
    expect(outcome.needsReconcile).toBe(true);
    reconcileTaskStatusWrite(qc, outcome.projection, { detail: false });
    await settled();

    // 1 = the read that was already in flight, 2 = the reconcile round. A third
    // is the ingestor restarting a key it does not own.
    expect(todo.fetches()).toBe(2);
    expect(dest.fetches()).toBe(2);
    todo.stop();
    dest.stop();
  });

  it('spends ONE post-event read on an `edit` detail, and leaves it to its listener', async () => {
    const qc = new QueryClient();
    const detail = observeInFlight(qc, taskDetailKey('task-a'), detailOf());
    await vi.waitFor(() => expect(detail.fetches()).toBe(1));

    const outcome = applyTaskChangedToProjections(
      qc,
      eventOf({ kind: 'edit', title: 'renamed' }),
    );
    expect(outcome.detailSettled).toBe(false);
    await settled();
    // The App-level patch did NOT restart it: an `edit`'s authority is wider than
    // its event, so `useTaskDetail` is the one owner of this key.
    expect(detail.fetches()).toBe(1);

    // …and that owner's refresh is the only read.
    void qc.invalidateQueries({ queryKey: taskDetailKey('task-a'), exact: true });
    await settled();
    expect(detail.fetches()).toBe(2);
    detail.stop();
  });

  it('DOES restart a racing read on a key nobody else will re-read', async () => {
    const qc = new QueryClient();
    const todo = observeInFlight(qc, boardColumnKey('todo', FILTER), pages(page([row()])));
    await vi.waitFor(() => expect(todo.fetches()).toBe(1));

    // A title-only edit: nothing about membership changed, so no authoritative
    // round follows — and the read in flight was issued BEFORE the event, so it
    // would commit the old title over the patch. This one is ours to restart.
    const outcome = applyTaskChangedToProjections(
      qc,
      eventOf({ kind: 'edit', status: 'todo', title: 'renamed' }),
    );
    expect(outcome.needsReconcile).toBe(false);
    await settled();
    expect(todo.fetches()).toBe(2);

    todo.answer(0, pages(page([row({ title: 'a task' })])));
    await settled();
    expect(
      qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER))?.pages[0]
        ?.items[0]?.title,
    ).toBe('renamed');
    todo.stop();
  });

  it('keeps a chip read issued before the event from committing over it', async () => {
    const qc = new QueryClient();
    const chip = observeInFlight(qc, taskByNumberKey(SCOPE, 100), row());
    await vi.waitFor(() => expect(chip.fetches()).toBe(1));

    applyTaskChangedToProjections(qc, eventOf({ status: 'in_review' }));
    await vi.waitFor(() => expect(chip.fetches()).toBe(2));

    // The pre-event response answers late. Its retryer was cancelled by the
    // restart, so `todo` has nowhere to commit and the pill keeps the snapshot.
    chip.answer(0, row({ status: 'todo' }));
    await settled();
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe(
      'in_review',
    );
    chip.stop();
  });

  it('writes nothing and restarts nothing when the chip already reads the snapshot', async () => {
    const qc = new QueryClient();
    const seeded = row({ status: 'in_progress' });
    const chip = observe(qc, taskByNumberKey(SCOPE, 100), seeded);

    applyTaskChangedToProjections(qc, eventOf());
    await settled();

    // Object identity: a duplicate delivery (engineered by the applied-floor
    // replay) must cost neither a write nor a request on this key either.
    expect(qc.getQueryData(taskByNumberKey(SCOPE, 100))).toBe(seeded);
    expect(chip.fetches()).toBe(0);
    chip.stop();
  });

  it('restarts a COLD chip read the event overtook, so the FIRST paint is not pre-event', async () => {
    const qc = new QueryClient();
    const chip = observeInFlight(qc, taskByNumberKey(SCOPE, 100));
    await vi.waitFor(() => expect(chip.fetches()).toBe(1));

    // There is nothing to patch — no DTO yet, and the event cannot synthesize one
    // — so the restart is the entire fix.
    applyTaskChangedToProjections(qc, eventOf({ status: 'in_review' }));
    await vi.waitFor(() => expect(chip.fetches()).toBe(2));

    // The read issued before the event answers late and has nowhere to commit:
    // without the restart THIS would have been the pill's first value, and
    // nothing would re-read it afterwards.
    chip.answer(0, row({ status: 'todo' }));
    await settled();
    expect(qc.getQueryData(taskByNumberKey(SCOPE, 100))).toBeUndefined();

    chip.answer(1, row({ status: 'in_review' }));
    await settled();
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe(
      'in_review',
    );
    chip.stop();
  });

  it('restarts a COLD detail read on a status event — nothing else owns that key', async () => {
    const qc = new QueryClient();
    const detail = observeInFlight(qc, taskDetailKey('task-a'));
    await vi.waitFor(() => expect(detail.fetches()).toBe(1));

    // `status` / `claim` / `unclaim` are settled by the event, so `useTaskDetail`'s
    // listener deliberately does not refresh on them — this path is the modal's
    // only owner, and a cold read is the one state its patch cannot reach.
    applyTaskChangedToProjections(qc, eventOf({ status: 'in_review' }));
    await vi.waitFor(() => expect(detail.fetches()).toBe(2));

    detail.answer(0, detailOf({ status: 'todo' }));
    await settled();
    expect(qc.getQueryData(taskDetailKey('task-a'))).toBeUndefined();
    detail.stop();
  });
});

// ── Assignee changes vs assignee-filtered columns ──────────────────

describe('assignee-filtered membership', () => {
  const MINE = `${WS}|*|agent:agent-1|any`;
  const NORMAN = { type: 'agent', id: 'agent-1', name: 'Norman' } as const;

  it('re-reads the ONE column a narrowed scope holds the row in when it changes hands', async () => {
    const qc = new QueryClient();
    const claimed = row({ status: 'in_progress', assignee: NORMAN });
    const mine = observe(
      qc,
      boardColumnKey('in_progress', MINE),
      pages(page([claimed], null, 'in_progress')),
    );
    const mineTodo = observe(qc, boardColumnKey('todo', MINE), pages(page([], null, 'todo')));
    const anyone = observe(
      qc,
      boardColumnKey('in_progress', FILTER),
      pages(page([claimed], null, 'in_progress')),
    );

    // Unclaimed: same status, so no move can express it — but the row has just
    // left the `assignee:agent-1` population.
    const outcome = applyTaskChangedToProjections(
      qc,
      eventOf({ kind: 'unclaim', status: 'in_progress', assignee: null }),
    );
    expect(outcome.projection.recheckColumns).toEqual([
      { filterKey: MINE, status: 'in_progress' },
    ]);
    reconcileTaskStatusWrite(qc, outcome.projection, { detail: false });
    await settled();

    expect(mine.fetches()).toBe(1);
    // The scope that narrows nothing on that axis keeps the row it holds:
    // membership there cannot have changed, so it is not re-read. Nor is the
    // narrowed scope's OTHER column — one column, not the whole scope.
    expect(anyone.fetches()).toBe(0);
    expect(mineTodo.fetches()).toBe(0);
    mine.stop();
    mineTodo.stop();
    anyone.stop();
  });

  it('re-reads a narrowed scope that does not hold the row yet when it is claimed', async () => {
    const qc = new QueryClient();
    const mineTodo = observe(qc, boardColumnKey('todo', MINE), pages(page([], null, 'todo')));
    const mineProgress = observe(
      qc,
      boardColumnKey('in_progress', MINE),
      pages(page([], null, 'in_progress')),
    );
    const anyone = observe(qc, boardColumnKey('todo', FILTER), pages(page([row()])));

    // Claimed by the person that scope is filtered to: the row has to APPEAR
    // there, and only the server can say where in the window it lands.
    const outcome = applyTaskChangedToProjections(
      qc,
      eventOf({ kind: 'claim', status: 'todo', assignee: NORMAN }),
    );
    expect(outcome.projection.unknownFilterKeys).toEqual([MINE]);
    reconcileTaskStatusWrite(qc, outcome.projection, { detail: false });
    await settled();

    expect(mineTodo.fetches()).toBe(1);
    expect(mineProgress.fetches()).toBe(1);
    expect(anyone.fetches()).toBe(0);
    mineTodo.stop();
    mineProgress.stop();
    anyone.stop();
  });
});

// ── Rollback context ───────────────────────────────────────────────
//
// One design, three failures it has to cover (Cindy asked for them together, and
// they are one question: what does a failed write hold that lets it undo exactly
// itself): the stamp it overwrote, a chip that is the only cache in play, and a
// row that is in NO column because its destination was never cached.

describe('rollback context', () => {
  it('restores the closed_at stamp it overwrote', () => {
    const qc = new QueryClient();
    const closedRow = row({ status: 'closed', closed_at: 5000 });
    seedColumns(qc, FILTER, {
      closed: pages(page([closedRow], null, 'closed')),
      done: pages(page([], null, 'done')),
    });
    qc.setQueryData(taskDetailKey('task-a'), detailOf({ status: 'closed', closed_at: 5000 }));
    qc.setQueryData(taskByNumberKey(SCOPE, 100), closedRow);

    const write = localWrite(qc, 'done');
    expect(write.previousClosedAt).toBe(5000);
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.closed_at).toBeNull();

    revertOptimisticStatusWrite(qc, write);

    // Status AND stamp, everywhere. Restoring the status alone left the task
    // `closed` with no `closed_at` — a pair the server never produces, and one
    // the failure path's re-read does not reach on the chip.
    for (const held of [
      qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100)),
      qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a')),
      qc.getQueryData<BoardColumnPages>(boardColumnKey('closed', FILTER))?.pages[0]?.items[0],
    ]) {
      expect(held).toMatchObject({ status: 'closed', closed_at: 5000 });
    }
  });

  it('rolls back a write whose ONLY cache is an inline chip', () => {
    const qc = new QueryClient();
    qc.setQueryData(taskByNumberKey(SCOPE, 100), row());

    // A `TaskRef` popover drives this mutation with no board and no detail
    // mounted. The by-number entry is then the only baseline there is.
    const write = localWrite(qc, 'done');
    expect(write.previousStatus).toBe('todo');
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('done');

    revertOptimisticStatusWrite(qc, write);
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('todo');
  });

  it('puts the board row back when the destination column was never cached', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row(), row({ id: 'task-b', task_number: 90 })])),
    });

    const write = localWrite(qc, 'done');
    // The `done` column is collapsed, so the row is now in NO cached column:
    // there is nothing for a compare-and-swap to find.
    expect(write.projection.moves[0]?.placed).toBe(false);
    expect(locateTaskInBoardColumns(qc, 'task-a')).toEqual([]);

    revertOptimisticStatusWrite(qc, write);

    // Back at its ordered position, from the row the move retained.
    expect(
      qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER))?.pages[0]
        ?.items.map(t => t.id),
    ).toEqual(['task-a', 'task-b']);
  });

  it('does NOT reinstate a detached row once an authority has spoken', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, { todo: pages(page([row()])) });
    const write = localWrite(qc, 'done');

    // Somebody else moved the task while our POST was in flight. The retained row
    // is a pre-write snapshot, and a snapshot is exactly what must not be
    // reinstated over an authority — the bounded re-read settles it instead.
    applyTaskChangedToProjections(qc, eventOf({ status: 'in_review' }));
    revertOptimisticStatusWrite(qc, write);

    expect(
      qc.getQueryData<BoardColumnPages>(boardColumnKey('todo', FILTER))?.pages[0]?.items,
    ).toEqual([]);
  });

  it('refuses to roll back a write a later write has superseded (same target value)', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row()])),
      done: pages(page([], null, 'done')),
    });
    qc.setQueryData(taskByNumberKey(SCOPE, 100), row());

    // Two clicks on the same target. B commits and echoes; A fails afterwards.
    const a = localWrite(qc, 'done');
    localWrite(qc, 'done');
    applyTaskChangedToProjections(qc, eventOf({ status: 'done', closed_at: null }));

    revertOptimisticStatusWrite(qc, a);

    // The status-value compare-and-swap is blind here — the value on screen IS
    // what A wrote — so only the LOCAL write order can refuse this rollback.
    // Without it the task reverts to `todo` and stays there: the failure path
    // re-reads the board, but B's committed `done` is what the server holds.
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('done');
    expect(locateTaskInBoardColumns(qc, 'task-a').map(h => h.status)).toEqual(['done']);
  });

  it('refuses the WHOLE rollback once an authoritative event has landed', () => {
    const qc = new QueryClient();
    seedColumns(qc, FILTER, {
      todo: pages(page([row()])),
      done: pages(page([], null, 'done')),
    });
    qc.setQueryData(taskDetailKey('task-a'), detailOf());
    qc.setQueryData(taskByNumberKey(SCOPE, 100), row());

    // ONE click, and the server COMMITTED it: the echo arrives with the real
    // stamp, only the HTTP answer is lost. `onError` then runs over caches the
    // authority already agrees with.
    const write = localWrite(qc, 'done');
    applyTaskChangedToProjections(qc, eventOf({ status: 'done', closed_at: 4000 }));

    revertOptimisticStatusWrite(qc, write);

    // Every projection keeps the committed value. The status CAS is blind here for
    // the same reason as above — `done` is what this write assigned — and this
    // write IS the newest, so `writeSeq` cannot refuse it either. Only "an
    // authority has spoken since the write began" can, and it has to refuse the
    // whole rollback: the board card, the modal and the pill would otherwise all
    // rewind to `todo`, and the server-stamped `closed_at` would be wiped.
    expect(locateTaskInBoardColumns(qc, 'task-a').map(h => h.status)).toEqual(['done']);
    expect(qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.status).toBe('done');
    expect(qc.getQueryData<TaskDetailDto>(taskDetailKey('task-a'))?.closed_at).toBe(4000);
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.status).toBe('done');
    expect(qc.getQueryData<TaskSummaryDto>(taskByNumberKey(SCOPE, 100))?.closed_at).toBe(4000);
  });
});

// ── Mechanical fence: no root invalidation from the status write ────

describe('useUpdateTaskStatus wiring', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./hooks.ts', import.meta.url)),
    'utf8',
  );
  const body = (() => {
    const start = source.indexOf('export function useUpdateTaskStatus()');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nexport ', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
  })();

  it('drives the projection seams on all three mutation edges', () => {
    expect(body).toContain('onMutate: vars => beginOptimisticStatusWrite(qc, vars)');
    expect(body).toContain('revertOptimisticStatusWrite(qc, write)');
    expect(body).toContain('reconcileTaskStatusWrite(qc, write.projection');
    expect(body).toContain('restartRacingTaskReads(qc, write.taskId)');
  });

  it('closes every write in the local ledger, and settles the chips it failed', () => {
    // Two wiring facts no cache test can see, because both are about writes this
    // hook did NOT finish: an entry left open makes the NEXT write on that task
    // look superseded and silently stops rolling back, and a failure that skips
    // `points` leaves whatever the rollback declined on a client-side value.
    expect(body).toContain('closeOptimisticStatusWrite(write)');
    expect(body).toContain('points: true');
  });

  it('never invalidates a task ROOT again', () => {
    // The whole point of #task:1975: a root invalidation is what turned one
    // 7ms write into 17 requests, and it is a one-line regression to re-add.
    // Scoped to this mutation's body — `useEditTask` / `useCreateTask` legally
    // invalidate `['tasks']` (a new row belongs on every list, and an edit can
    // retitle any of them).
    expect(body).not.toContain("queryKey: ['tasks']");
    expect(body).not.toContain("queryKey: ['task-by-number']");
    expect(body).not.toContain('boardFacetsKey');
  });
});
