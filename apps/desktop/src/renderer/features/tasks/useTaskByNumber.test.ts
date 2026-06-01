import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { TaskChangedEvent, TaskSummaryDto } from '@silverhand/shared';
import {
  applyTaskChangedToTaskByNumberCache,
  taskByNumberKey,
} from './useTaskByNumber';

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
    message_id: 'msg-task-42',
    task_number: 42,
    workspace_id: 'workspace-1',
    workspace_name: 'Workspace',
    channel_id: 'channel-1',
    channel_name: 'version3',
    thread_id: null,
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
    thread_id: null,
    conversation_id: 'channel-1',
    task_number: 42,
    message_id: 'msg-task-42',
    status: 'done',
    assignee: null,
    title: 'Task title',
    closed_at: null,
    ...overrides,
  };
}
