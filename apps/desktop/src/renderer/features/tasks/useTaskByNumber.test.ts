import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { apiPaths, type TaskChangedEvent, type TaskSummaryDto } from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import {
  applyTaskChangedToTaskByNumberCache,
  canLookupTaskByNumber,
  fetchTaskByNumber,
  isResolvedTaskMiss,
  taskBoardCacheScope,
  taskByNumberKey,
  taskByNumberPath,
} from './useTaskByNumber';

// Only `api` is replaced; `ApiError` must stay the REAL class because the
// resolved-miss decision is an `instanceof` check. A bare `vi.mock('@/lib/api')`
// would auto-mock the class too and quietly make every error a non-miss.
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: vi.fn() };
});

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.mockReset();
});

describe('taskByNumberPath', () => {
  it('asks the bounded by-number face for both axes and nothing else', () => {
    const path = taskByNumberPath('conv-1', 42);

    expect(path.split('?')[0]).toBe(apiPaths.taskByNumber);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect([...qs.entries()]).toEqual([
      ['conversation_id', 'conv-1'],
      ['task_number', '42'],
    ]);
  });

  it('names the board by conversation, not workspace', () => {
    // The board is named indirectly by ANY conversation on it, so a DirectPair
    // task — with no workspace coordinate — is reachable by the same face
    // (#task:2041). The axis is `conversation_id`; `workspace_id` is gone.
    const path = taskByNumberPath('conv-1', 42);
    expect(path).not.toContain('workspace_id');
  });

  it('is not the retired unbounded list', () => {
    const path = taskByNumberPath('conv-1', 42);

    // The old shape was `/api/tasks?workspace_id=&task_number=&limit=1`: a
    // filtered slice of the human fetch-all list (#task:1891 retired it). The
    // point face has no `limit` and no `status` axis, and its path is a
    // different route rather than a query on the collection.
    expect(path.startsWith('/api/tasks?')).toBe(false);
    expect(path).not.toContain('limit');
    expect(path).not.toContain('status');
  });
});

/**
 * The cache scope is the WHOLE point of #task:2041's by-number rework: it is the
 * single projection that decides which conversations share one cache cell, and
 * both the consumer and the realtime patcher must derive it from the same source.
 * These assert the constructor DIRECTLY (never through a cast) — the properties
 * downstream identity/scope matching relies on:
 *  - sibling conversations of one workspace collapse to ONE scope;
 *  - the arm tag keeps a workspace id and a conversation id that happen to share
 *    a string on separate scopes;
 *  - each DirectPair board keeps its own scope.
 */
describe('taskBoardCacheScope (the sole projection)', () => {
  it('collapses every conversation on one workspace board to a single scope', () => {
    // A workspace board spans all its channels, so two different channels on the
    // same workspace MUST key the same cell — this is what lets a `task_changed`
    // event on one channel reach a cold miss another channel cached.
    expect(taskBoardCacheScope({ workspaceId: 'ws-1', conversationId: 'c1' })).toBe(
      taskBoardCacheScope({ workspaceId: 'ws-1', conversationId: 'c2' }),
    );
  });

  it('lets the workspace coordinate win when both are present', () => {
    // Workspace AND Agent Space are both `placement_kind='workspace'`; both key by
    // workspace id, so a leftover pair conversation does not fork the cell.
    expect(
      taskBoardCacheScope({ workspaceId: 'ws-1', conversationId: 'pair-1' }),
    ).toBe(taskBoardCacheScope({ workspaceId: 'ws-1', conversationId: 'pair-2' }));
  });

  it('tags the arm so a workspace id and a conversation id sharing a string never collide', () => {
    // Without the `workspace:` / `direct_pair:` tag, a workspace and a DirectPair
    // that happened to share an id string would patch each other's cell.
    expect(taskBoardCacheScope({ workspaceId: 'x', conversationId: null })).not.toBe(
      taskBoardCacheScope({ workspaceId: null, conversationId: 'x' }),
    );
  });

  it('keeps each DirectPair board on its own scope', () => {
    expect(
      taskBoardCacheScope({ workspaceId: null, conversationId: 'pair-1' }),
    ).not.toBe(taskBoardCacheScope({ workspaceId: null, conversationId: 'pair-2' }));
  });

  it('is null when neither axis resolves (a sigil rendered outside any conversation)', () => {
    expect(taskBoardCacheScope({ workspaceId: null, conversationId: null })).toBeNull();
    expect(taskBoardCacheScope(null)).toBeNull();
    expect(taskBoardCacheScope({ workspaceId: '', conversationId: '' })).toBeNull();
  });
});

describe('canLookupTaskByNumber', () => {
  it('accepts a resolvable conversation + positive integer pair', () => {
    expect(canLookupTaskByNumber('conv-1', 42)).toBe(true);
  });

  it('short-circuits when either axis is unresolvable', () => {
    // No conversation context: an inline sigil rendered outside any conversation.
    expect(canLookupTaskByNumber(null, 42)).toBe(false);
    expect(canLookupTaskByNumber(undefined, 42)).toBe(false);
    expect(canLookupTaskByNumber('', 42)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', null)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', undefined)).toBe(false);
  });

  it('mirrors the server axis: positive INTEGER, so a bad request is never sent', () => {
    // `TaskByNumberQuerySchema` answers a fractional or non-positive number with
    // a 400. That is a malformed request, not a miss — the gate must stop it
    // here rather than let a pill cache a client bug as "no such task".
    expect(canLookupTaskByNumber('conv-1', 1.5)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', 0)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', -3)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', Number.NaN)).toBe(false);
    expect(canLookupTaskByNumber('conv-1', Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('isResolvedTaskMiss', () => {
  it('treats ONLY a 404 as the authoritative miss', () => {
    expect(isResolvedTaskMiss(new ApiError(404, 'Not Found', 'task not found'))).toBe(
      true,
    );
  });

  it('does not let any other failure masquerade as a miss', () => {
    // 400 = the request was malformed. Caching it as a resolved miss would make
    // a client bug look like a deleted task.
    expect(isResolvedTaskMiss(new ApiError(400, 'Bad Request', 'invalid query'))).toBe(
      false,
    );
    expect(isResolvedTaskMiss(new ApiError(500, 'Server Error', ''))).toBe(false);
    expect(isResolvedTaskMiss(new ApiError(403, 'Forbidden', ''))).toBe(false);
    // Transport failure: `status: 0`, so the status check alone excludes it. A
    // pill must not claim a task is gone because the server was unreachable.
    expect(
      isResolvedTaskMiss(
        new ApiError(0, '', 'backend_unreachable', 'backend_unreachable'),
      ),
    ).toBe(false);
    expect(isResolvedTaskMiss(new Error('boom'))).toBe(false);
    expect(isResolvedTaskMiss(null)).toBe(false);
  });
});

describe('fetchTaskByNumber', () => {
  it('reads the single-task envelope, not a list of one', async () => {
    const task = taskSummary({ title: 'Bridge the sigil' });
    mockApi.mockResolvedValue({ task });

    await expect(fetchTaskByNumber('conv-1', 42)).resolves.toEqual(task);
    expect(mockApi).toHaveBeenCalledExactlyOnceWith(
      taskByNumberPath('conv-1', 42),
    );
  });

  it('resolves a 404 to null so the sigil demotes to inert text', async () => {
    mockApi.mockRejectedValue(new ApiError(404, 'Not Found', 'task not found'));

    await expect(fetchTaskByNumber('conv-1', 42)).resolves.toBeNull();
  });

  it('rethrows every other failure instead of reporting a missing task', async () => {
    mockApi.mockRejectedValue(new ApiError(500, 'Server Error', ''));
    await expect(fetchTaskByNumber('conv-1', 42)).rejects.toThrow(ApiError);

    mockApi.mockRejectedValue(
      new ApiError(0, '', 'backend_unreachable', 'backend_unreachable'),
    );
    await expect(fetchTaskByNumber('conv-1', 42)).rejects.toMatchObject({
      kind: 'backend_unreachable',
    });
  });
});

describe('task-by-number cache realtime patching', () => {
  // Every cell is keyed through the REAL `taskBoardCacheScope` — no cast — so the
  // tests exercise the same collapse the production code relies on.
  const wsBoard = (conversationId: string) =>
    taskBoardCacheScope({ workspaceId: 'workspace-1', conversationId })!;

  it('updates an existing inline task ref cache entry from task_changed', () => {
    const client = new QueryClient();
    client.setQueryData<TaskSummaryDto | null>(
      taskByNumberKey(wsBoard('channel-1'), 42),
      taskSummary({
        status: 'in_progress',
        title: 'Old title',
        assignee: null,
      }),
    );

    applyTaskChangedToTaskByNumberCache(
      client,
      taskChanged({
        status: 'in_review',
        title: 'Updated task title',
        assignee: { type: 'agent', id: 'agent-1', name: 'Cindy' },
      }),
    );

    expect(client.getQueryData<TaskSummaryDto | null>(
      taskByNumberKey(wsBoard('channel-1'), 42),
    )).toMatchObject({
      status: 'in_review',
      title: 'Updated task title',
      assignee: { type: 'agent', id: 'agent-1', name: 'Cindy' },
    });
  });

  it('patches a resolved entry by task IDENTITY and leaves a different task alone', () => {
    // A resolved entry is user-visible, so it is matched by `dto.id === task_id`
    // — complete regardless of which board scope holds it. A task on an unrelated
    // board (here a DirectPair) with a different id must stay untouched.
    const client = new QueryClient();
    const pairBoard = taskBoardCacheScope({ workspaceId: null, conversationId: 'pair-9' })!;
    client.setQueryData<TaskSummaryDto | null>(
      taskByNumberKey(wsBoard('channel-1'), 42),
      taskSummary({ id: 'task-42', status: 'todo', title: 'Old' }),
    );
    client.setQueryData<TaskSummaryDto | null>(
      taskByNumberKey(pairBoard, 7),
      taskSummary({ id: 'task-7', task_number: 7, status: 'todo', title: 'Unrelated' }),
    );

    applyTaskChangedToTaskByNumberCache(
      client,
      taskChanged({ task_id: 'task-42', status: 'done', title: 'New' }),
    );

    expect(client.getQueryData<TaskSummaryDto | null>(
      taskByNumberKey(wsBoard('channel-1'), 42),
    )).toMatchObject({ status: 'done', title: 'New' });
    expect(client.getQueryData<TaskSummaryDto | null>(
      taskByNumberKey(pairBoard, 7),
    )).toMatchObject({ status: 'todo', title: 'Unrelated' });
  });

  it('invalidates a cached MISS through the board scope even when a SIBLING channel names it', () => {
    // A user hovered `#task:42` on channel c1 before it existed → a resolved miss
    // (null), cached under the workspace board scope. The task is then created and
    // the `task_changed` event names a DIFFERENT channel c2 on the SAME workspace
    // board. Per-conversation keying could never reach c1's cell from a c2 event;
    // board-scope collapse means c1 and c2 are ONE cell, so the miss is woken.
    const client = new QueryClient();
    const missKey = taskByNumberKey(wsBoard('c1'), 42);
    client.setQueryData<TaskSummaryDto | null>(missKey, null);
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    applyTaskChangedToTaskByNumberCache(
      client,
      taskChanged({
        kind: 'create',
        task_number: 42,
        workspace_id: 'workspace-1',
        conversation_id: 'c2',
      }),
    );

    // Same cell — `wsBoard('c1')` and the event's `wsBoard('c2')` are the same
    // scope string, so the seeded key is exactly what gets invalidated.
    expect(wsBoard('c1')).toBe(wsBoard('c2'));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: missKey,
      exact: true,
    });
  });

  it('does not create a cache entry for unrelated task_changed events', () => {
    const client = new QueryClient();

    applyTaskChangedToTaskByNumberCache(client, taskChanged({ task_number: 42 }));

    expect(client.getQueryData(taskByNumberKey(wsBoard('channel-1'), 42))).toBeUndefined();
  });
});

function taskSummary(
  overrides: Partial<TaskSummaryDto> = {},
): TaskSummaryDto {
  return {
    id: 'task-42',
    task_number: 42,
    place: {
      kind: 'workspace',
      conversation_id: 'channel-1',
      workspace_id: 'workspace-1',
      workspace_kind: 'regular',
      channel_name: 'version3',
    },
    thread_root_id: null,
    status: 'todo',
    title: 'Task title',
    assignee: null,
    creator: { type: 'agent', id: 'agent-creator', name: 'Alice' },
    created_at: 1_000,
    closed_at: null,
    ...overrides,
  };
}

function taskChanged(
  overrides: Partial<TaskChangedEvent> = {},
): TaskChangedEvent {
  return {
    kind: 'status',
    workspace_id: 'workspace-1',
    thread_root_id: null,
    conversation_id: 'channel-1',
    task_number: 42,
    task_id: 'task-42',
    source_message_id: 'msg-task-42',
    status: 'done',
    assignee: null,
    title: 'Task title',
    closed_at: null,
    ...overrides,
  };
}
