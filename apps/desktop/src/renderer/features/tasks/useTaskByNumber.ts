import { taskWorkspaceId } from './taskPlace.js';
import {
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  apiPaths,
  type TaskChangedEvent,
  type TaskSummaryDto,
} from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import { restartRacingRead } from './racingRead';

/**
 * Fetch a single task by its board-scoped task_number for inline
 * `#task:<n>` sigil rendering.
 *
 * Conversation-anchored: `task_number` is unique per BOARD, not globally
 * (allocated by `TaskService.allocateTaskNumber`). The caller passes the
 * conversation the sigil is rendered inside; the server derives that
 * conversation's board and point-reads `(board_key, task_number)`. The
 * conversation is a LOOKUP key, never an authorization scope — a workspace
 * board and a DirectPair board are both named by any conversation on them,
 * and a DirectPair task has no workspace coordinate to anchor at all. When a
 * side pane renders foreign content, that's the conversation the message
 * belongs to, not the primary selected one — the same discipline as the
 * cross-conversation `useConversationById` resolution from PR-2.
 *
 * Returns `null` (resolved) when the server authoritatively has none for this
 * viewer — the renderer silently demotes the sigil to inert text rather than
 * show a broken pill. `undefined` while still loading; React Query owns the
 * loading flag.
 */
export type UseTaskByNumberResult = UseQueryResult<TaskSummaryDto | null>;

const TASK_REF_GC_MS = 5 * 60 * 1000;
const TASK_REF_STALE_MS = 30 * 1000;

/** The conversation-placement coordinates a caller renders a `#task:<n>` in.
 *  `workspaceId` is null for a DirectPair (no workspace coordinate); it is the
 *  input to BOTH the cache-scope projection and — via `conversationId` — the
 *  HTTP lookup anchor. */
export interface TaskRefCoord {
  workspaceId: string | null;
  conversationId: string | null;
}

declare const TASK_BOARD_CACHE_SCOPE: unique symbol;

/**
 * A renderer-only cache identity for by-number entries — NOT the server's
 * `board_key`, and never a wire value. Its sole job is to make every
 * conversation that shares ONE board collapse to ONE cache cell.
 *
 * Task numbers are board-scoped (`TaskService.allocateTaskNumber(boardKey)` +
 * the `uniq_tasks_board_number` constraint), but a cache keyed by CONVERSATION
 * split the sibling channels of one workspace board into independent cells. A
 * `task_changed` event names only its OWN conversation, so it could not reach a
 * sibling channel's cold/miss cell — that entry re-fetched on its own, the
 * "self-healing miss" that left a stale window with no bounded recovery. Keying
 * by board equivalence class closes that by construction: there is only one cell
 * to reach.
 *
 *  - `workspace:<workspace_id>` — every conversation in a workspace shares one
 *    board, so the workspace id IS the board's exact equivalence class.
 *  - `direct_pair:<conversation_id>` — a DirectPair board holds exactly one
 *    conversation (threads stay on the parent via `thread_root_id`), so its
 *    conversation id is 1:1 with the board.
 *
 * The scope is projected from ONE source — the conversation-placement coords
 * `{ workspaceId, conversationId }` — on BOTH the consumer and the event side,
 * so a read and the event that mutates it land in the same cell. The resolved
 * DTO's `pair_key` must NEVER build a key: a second derivation is a second
 * source of truth and would reopen the split.
 */
export type TaskBoardCacheScope = string & {
  readonly [TASK_BOARD_CACHE_SCOPE]: true;
};

/**
 * Project the cache scope from conversation-placement coords. Returns `null`
 * when neither coordinate is resolvable (a sigil rendered outside any
 * conversation) — the query is disabled in that case, never keyed to a guessed
 * board.
 */
export function taskBoardCacheScope(
  coord: TaskRefCoord | null | undefined,
): TaskBoardCacheScope | null {
  // Workspace placement wins when present: Workspace AND Agent Space are both
  // `placement_kind='workspace'` (split only by `workspace_kind`), so both key
  // by their workspace id. A DirectPair has no workspace coordinate, so it
  // falls through to its pair conversation. `agent_inbox` never reaches here —
  // it has no human participant to render an inline task ref — so it needs no
  // arm; a coord with both axes null is unresolvable.
  const workspaceId = coord?.workspaceId ?? null;
  const conversationId = coord?.conversationId ?? null;
  if (typeof workspaceId === 'string' && workspaceId.length > 0) {
    return `workspace:${workspaceId}` as TaskBoardCacheScope;
  }
  if (typeof conversationId === 'string' && conversationId.length > 0) {
    return `direct_pair:${conversationId}` as TaskBoardCacheScope;
  }
  return null;
}

export const taskByNumberKey = (
  scope: TaskBoardCacheScope | null | undefined,
  taskNumber: number | null | undefined,
) => ['task-by-number', scope ?? null, taskNumber ?? null] as const;

/**
 * What one event did to the by-number entries it names.
 *
 * `patched` is the only outcome that WROTE — which is what makes this cache's
 * single refetch owner decidable: nothing else in the event path invalidates a
 * `['task-by-number']` entry, so an assignment that landed over a read issued
 * before the event has to restart that read itself, and one that changed nothing
 * must not (restarting on a duplicate delivery would spend a round trip per echo,
 * the same defect identity preservation fixes on the board rows).
 *
 * The outcome is an aggregate: it scans every by-number entry. Under
 * board-scope keying at most one COLD/MISS cell exists per board (sibling
 * conversations collapse to one `TaskBoardCacheScope`), and RESOLVED cells are
 * matched by task identity across whatever the cache holds — so one event
 * settles on a single decisive outcome. No production caller reads this value —
 * it exists for the seam tests and documents the write contract.
 */
export type TaskByNumberPatchOutcome =
  /** No entry names this task, or every candidate was a cold first load that had
   *  not resolved: there is no DTO to write over and the event cannot synthesize
   *  one. A first load still IN FLIGHT is restarted, because it was issued before
   *  this event and would otherwise commit pre-event state as the chip's initial
   *  value. */
  | 'absent'
  /** A cached MISS that has become a real task — only a read can build it. */
  | 'invalidated'
  /** The snapshot says what the entry already reads. */
  | 'unchanged'
  | 'patched';

function sameTaskChangedFields(
  row: TaskSummaryDto,
  task: TaskChangedEvent,
): boolean {
  return (
    row.id === task.task_id
    && taskWorkspaceId(row) === task.workspace_id
    && row.place.conversation_id === task.conversation_id
    && row.thread_root_id === task.thread_root_id
    && row.status === task.status
    && row.title === task.title
    && row.closed_at === task.closed_at
    && (row.assignee?.id ?? null) === (task.assignee?.id ?? null)
    && (row.assignee?.type ?? null) === (task.assignee?.type ?? null)
  );
}

/** The mutable slice a `task_changed` event writes over a by-number DTO.
 *  Immutable context (creator/created_at/place) stays from the original
 *  fetch — the event does not carry it. */
function patchTaskByNumberEntry(
  qc: QueryClient,
  key: ReturnType<typeof taskByNumberKey>,
  prev: TaskSummaryDto,
  task: TaskChangedEvent,
  fetchStatus: 'fetching' | 'paused' | 'idle',
): void {
  qc.setQueryData<TaskSummaryDto | null>(key, {
    ...prev,
    id: task.task_id,
    // Keep the navigation anchor fresh from the realtime event so an inline
    // `#task:<n>` jump resolves to the right reply cluster instead of relying
    // on stale by-number fetch values.
    thread_root_id: task.thread_root_id,
    status: task.status,
    title: task.title,
    assignee: task.assignee,
    closed_at: task.closed_at,
  });
  if (fetchStatus === 'fetching') {
    restartRacingRead(qc, key);
  }
}

/** Does this cold/miss entry's cache cell belong to the board the event names?
 *  Both sides project the SAME `TaskBoardCacheScope` from conversation-placement
 *  coords, so a workspace event reaches its board's single shared cell (every
 *  sibling channel collapsed to `workspace:<workspace_id>`) and a DirectPair
 *  event reaches its one pair cell. This is what retires the old "self-healing
 *  miss": there is no sibling cell left to miss. Resolved entries do not take
 *  this path — they match by task identity, which is complete regardless of
 *  scope. `pair_key` is never consulted here; the event's own placement coords
 *  are the one source. */
function eventScopeMatchesKey(
  scope: TaskBoardCacheScope | null,
  taskNumber: number | null,
  eventScope: TaskBoardCacheScope | null,
  task: TaskChangedEvent,
): boolean {
  return (
    eventScope !== null
    && scope === eventScope
    && taskNumber === task.task_number
  );
}

/**
 * Keep inline `#task:<n>` popover cache coherent with realtime task
 * mutations. The `task_changed` payload has exactly the mutable fields
 * this cache needs (status, assignee, title); immutable context such as
 * creator/created_at stays from the original by-number fetch.
 *
 * The cache is keyed by (`TaskBoardCacheScope`, task_number), so every
 * conversation on one board shares a single cell. This scans the cells:
 *  - a RESOLVED entry is matched by task IDENTITY (`dto.id === task_id`), which
 *    is complete regardless of scope — a stale resolved chip is user-visible and
 *    wrong, so this is the correctness path;
 *  - a COLD or MISS entry has no DTO to identity-match, so it is matched by
 *    board scope: the event projects the SAME scope from its placement coords
 *    (`workspace_id` / `conversation_id`), so it reaches the one cell that board
 *    shares.
 *
 * The write is IDENTITY-PRESERVING and owns the freshness of its own keys: an
 * event that repeats what an entry holds writes nothing and restarts nothing,
 * while one that carries news restarts a read issued before it — React Query
 * commits a settled response over an interim `setQueryData`, so without that a
 * point read in flight when the event arrives can put pre-event state back
 * (#task:1975; the same rule as `restartRacingRead` on the board columns).
 */
export function applyTaskChangedToTaskByNumberCache(
  qc: QueryClient,
  task: TaskChangedEvent,
): TaskByNumberPatchOutcome {
  const entries = qc.getQueryCache().findAll({ queryKey: ['task-by-number'] });
  // The event's board scope, projected from the SAME source the consumer uses.
  // `pair_key` on the resolved DTO is deliberately NOT consulted — one source.
  const eventScope = taskBoardCacheScope({
    workspaceId: task.workspace_id,
    conversationId: task.conversation_id,
  });
  let outcome: TaskByNumberPatchOutcome = 'absent';
  const raise = (next: TaskByNumberPatchOutcome) => {
    // Precedence for the aggregate: patched > invalidated > absent. `unchanged`
    // only survives if it is the sole signal from a matched entry.
    if (next === 'patched') outcome = 'patched';
    else if (next === 'invalidated' && outcome !== 'patched') outcome = 'invalidated';
    else if (next === 'unchanged' && outcome === 'absent') outcome = 'unchanged';
  };

  for (const entry of entries) {
    const key = entry.queryKey as ReturnType<typeof taskByNumberKey>;
    const scope = (key[1] ?? null) as TaskBoardCacheScope | null;
    const taskNumber = (key[2] ?? null) as number | null;
    const state = qc.getQueryState<TaskSummaryDto | null>(key);
    if (!state) continue;

    // A COLD read — the entry exists but has never resolved. Nothing can be
    // patched (there is no DTO yet, and the event cannot synthesize one), so the
    // restart is the entire fix: that request was issued before this event, and
    // React Query commits a settled response over anything written since, so
    // leaving it alone lets the chip's FIRST paint be pre-event state with no
    // bounded recovery behind it (`staleTime` does not re-read on a timer).
    if (state.data === undefined) {
      if (eventScopeMatchesKey(scope, taskNumber, eventScope, task)) {
        restartRacingRead(qc, key);
      }
      continue;
    }

    // A cached miss can become real if the task is created after a user has
    // already hovered the sigil. We cannot synthesize the full TaskSummaryDto
    // from the event, so mark the exact query stale and let active observers
    // refetch. Identity is unavailable here (there is no DTO), so this matches
    // by the board scope the event projects.
    if (state.data === null) {
      if (eventScopeMatchesKey(scope, taskNumber, eventScope, task)) {
        void qc.invalidateQueries({ queryKey: key, exact: true });
        raise('invalidated');
      }
      continue;
    }

    // A RESOLVED entry — match by task identity, complete across every board
    // scope that keyed this task.
    const prev = state.data;
    if (prev.id !== task.task_id) continue;
    if (sameTaskChangedFields(prev, task)) {
      raise('unchanged');
      continue;
    }
    patchTaskByNumberEntry(qc, key, prev, task, state.fetchStatus);
    raise('patched');
  }

  return outcome;
}

/**
 * The wire path for one point lookup. `apiPaths.taskByNumber` is the single
 * authority for where this face lives (#task:1891) — the renderer does not
 * spell the route out a second time.
 *
 * Both axes and NOTHING else: this face takes no `status` and no `limit`. It
 * used to be `GET /api/tasks?workspace_id=&task_number=&limit=1` — a filtered
 * slice of the unbounded human list. That list DID carry a `task_number` filter
 * (`ListTasksQuerySchema`: a repeatable, OR-ed axis), and that is exactly how
 * the old consumer worked. What it lacked was a POINT FACE: the answer to a
 * point question arrived in a list envelope (`{ tasks: [t] }`) narrowed by one
 * filter among many and capped by a caller-supplied `limit`.
 *
 * The lookup axis is `conversation_id`, not `workspace_id`: the board is named
 * indirectly by any conversation on it, so a DirectPair task — with no
 * workspace coordinate — is reachable by the same face (#task:2041).
 */
export function taskByNumberPath(
  conversationId: string,
  taskNumber: number,
): string {
  const qs = new URLSearchParams();
  qs.set('conversation_id', conversationId);
  qs.set('task_number', String(taskNumber));
  return `${apiPaths.taskByNumber}?${qs.toString()}`;
}

/**
 * Whether the two axes are resolvable at all. A missing conversation context
 * (e.g. SavedListView outside any conversation) short-circuits the fetch.
 *
 * `Number.isInteger` rather than `isFinite` mirrors the server's axis
 * (`TaskByNumberQuerySchema`: positive integer), so the two gates cannot
 * disagree about what a task number is — a fractional one is a bad REQUEST
 * (400), which must never be mistaken for a resolved miss.
 */
export function canLookupTaskByNumber(
  conversationId: string | null | undefined,
  taskNumber: number | null | undefined,
): boolean {
  return (
    typeof conversationId === 'string'
    && conversationId.length > 0
    && typeof taskNumber === 'number'
    && Number.isInteger(taskNumber)
    && taskNumber > 0
  );
}

/**
 * Is this failure the authoritative "no such task for you"?
 *
 * ONLY a 404. The face is fail-closed by design — a number that was never
 * allocated, a task the viewer cannot see, and a conversation with no board all
 * return the same 404 (no existence oracle) — and every one means the same thing
 * to a sigil: demote to inert text. Everything else stays an error: a 400 says
 * the request was malformed (caching it as a resolved miss would make a client
 * bug look like a deleted task), and a transport failure arrives as `ApiError`
 * with `kind: 'backend_unreachable'` / `status: 0`, which this predicate excludes
 * by the status check alone. A pill must not claim a task is gone because the
 * server was unreachable.
 */
export function isResolvedTaskMiss(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * One point lookup: the task, or `null` when the server authoritatively has
 * none for this viewer.
 *
 * A module-level function rather than an inline `queryFn` so the envelope
 * wiring and the error taxonomy are testable without a React tree — reading
 * `res.task` (this face) instead of `res.tasks[0]` (the retired list) is a
 * value-level fact that a path assertion cannot catch.
 */
export async function fetchTaskByNumber(
  conversationId: string,
  taskNumber: number,
): Promise<TaskSummaryDto | null> {
  try {
    const res = await api<{ task: TaskSummaryDto }>(
      taskByNumberPath(conversationId, taskNumber),
    );
    return res.task;
  } catch (err) {
    // A resolved miss, not a failure — so it needs no `retry` policy: the query
    // never enters an error state and React Query has nothing to retry.
    // Anything else propagates and retries as usual.
    if (isResolvedTaskMiss(err)) return null;
    throw err;
  }
}

/**
 * Resolve one inline `#task:<n>`. The caller passes the conversation-placement
 * `coord` it is rendered in: `conversationId` is the HTTP lookup anchor, and
 * `{ workspaceId, conversationId }` projects the `TaskBoardCacheScope` that keys
 * the cache — so every conversation sharing a board reads (and is invalidated
 * through) one cell.
 */
export function useTaskByNumber(
  coord: TaskRefCoord | null | undefined,
  taskNumber: number | null | undefined,
): UseTaskByNumberResult {
  const conversationId = coord?.conversationId ?? null;
  const scope = taskBoardCacheScope(coord);
  // The HTTP anchor is the conversation; a resolvable conversation guarantees a
  // non-null scope, so no separate scope gate is needed.
  const enabled = canLookupTaskByNumber(conversationId, taskNumber);

  return useQuery({
    queryKey: taskByNumberKey(scope, taskNumber),
    queryFn: () =>
      fetchTaskByNumber(conversationId as string, taskNumber as number),
    enabled,
    staleTime: TASK_REF_STALE_MS,
    gcTime: TASK_REF_GC_MS,
  });
}
