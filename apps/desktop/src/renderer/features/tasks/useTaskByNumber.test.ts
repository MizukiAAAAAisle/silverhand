import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { apiPaths, type TaskChangedEvent, type TaskSummaryDto } from '@silverhand/shared';
import { api, ApiError } from '@/lib/api';
import {
  applyTaskChangedToTaskByNumberCache,
  canLookupTaskByNumber,
  fetchTaskByNumber,
  isResolvedTaskMiss,
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
    const path = taskByNumberPath('workspace-1', 42);

    expect(path.split('?')[0]).toBe(apiPaths.taskByNumber);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect([...qs.entries()]).toEqual([
      ['workspace_id', 'workspace-1'],
      ['task_number', '42'],
    ]);
  });

  it('is not the retired unbounded list', () => {
    const path = taskByNumberPath('workspace-1', 42);

    // The old shape was `/api/tasks?workspace_id=&task_number=&limit=1`: a
    // filtered slice of the human fetch-all list (#task:1891 retired it). The
    // point face has no `limit` and no `status` axis, and its path is a
    // different route rather than a query on the collection.
    expect(path.startsWith('/api/tasks?')).toBe(false);
    expect(path).not.toContain('limit');
    expect(path).not.toContain('status');
  });
});

describe('canLookupTaskByNumber', () => {
  it('accepts a resolvable workspace + positive integer pair', () => {
    expect(canLookupTaskByNumber('workspace-1', 42)).toBe(true);
  });

  it('short-circuits when either axis is unresolvable', () => {
    // No workspace context: an inline sigil rendered outside any conversation.
    expect(canLookupTaskByNumber(null, 42)).toBe(false);
    expect(canLookupTaskByNumber(undefined, 42)).toBe(false);
    expect(canLookupTaskByNumber('', 42)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', null)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', undefined)).toBe(false);
  });

  it('mirrors the server axis: positive INTEGER, so a bad request is never sent', () => {
    // `TaskByNumberQuerySchema` answers a fractional or non-positive number with
    // a 400. That is a malformed request, not a miss — the gate must stop it
    // here rather than let a pill cache a client bug as "no such task".
    expect(canLookupTaskByNumber('workspace-1', 1.5)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', 0)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', -3)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', Number.NaN)).toBe(false);
    expect(canLookupTaskByNumber('workspace-1', Number.POSITIVE_INFINITY)).toBe(false);
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

    await expect(fetchTaskByNumber('workspace-1', 42)).resolves.toEqual(task);
    expect(mockApi).toHaveBeenCalledExactlyOnceWith(
      taskByNumberPath('workspace-1', 42),
    );
  });

  it('resolves a 404 to null so the sigil demotes to inert text', async () => {
    mockApi.mockRejectedValue(new ApiError(404, 'Not Found', 'task not found'));

    await expect(fetchTaskByNumber('workspace-1', 42)).resolves.toBeNull();
  });

  it('rethrows every other failure instead of reporting a missing task', async () => {
    mockApi.mockRejectedValue(new ApiError(500, 'Server Error', ''));
    await expect(fetchTaskByNumber('workspace-1', 42)).rejects.toThrow(ApiError);

    mockApi.mockRejectedValue(
      new ApiError(0, '', 'backend_unreachable', 'backend_unreachable'),
    );
    await expect(fetchTaskByNumber('workspace-1', 42)).rejects.toMatchObject({
      kind: 'backend_unreachable',
    });
  });
});

describe('task-by-number cache realtime patching', () => {
  it('updates an existing inline task ref cache entry from task_changed', () => {
    const client = new QueryClient();
    client.setQueryData<TaskSummaryDto | null>(
      taskByNumberKey('workspace-1', 42),
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
      taskByNumberKey('workspace-1', 42),
    )).toMatchObject({
      status: 'in_review',
      title: 'Updated task title',
      assignee: { type: 'agent', id: 'agent-1', name: 'Cindy' },
    });
  });

  it('does not create a cache entry for unrelated task_changed events', () => {
    const client = new QueryClient();

    applyTaskChangedToTaskByNumberCache(client, taskChanged({ task_number: 42 }));

    expect(client.getQueryData(taskByNumberKey('workspace-1', 42))).toBeUndefined();
  });
});

function taskSummary(
  overrides: Partial<TaskSummaryDto> = {},
): TaskSummaryDto {
  return {
    id: 'task-42',
    task_number: 42,
    workspace_id: 'workspace-1',
    workspace_name: 'Workspace',
    channel_id: 'channel-1',
    channel_name: 'version3',
    thread_root_id: null,
    conversation: { id: 'channel-1', title: 'version3' },
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
    channel_id: 'channel-1',
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
