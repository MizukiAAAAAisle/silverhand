import { describe, expect, it } from 'vitest';
import type { TaskSummaryDto } from '@silverhand/shared';
import {
  applyTaskFilters,
  collectAssignees,
  collectCreators,
  DEFAULT_TASK_FILTERS,
  taskFiltersEqual,
  type TaskFilters,
} from './taskFilters';

function task(overrides: Partial<TaskSummaryDto>): TaskSummaryDto {
  return {
    message_id: 'm1',
    task_number: 1,
    workspace_id: 'ws1',
    workspace_name: 'ws',
    channel_id: 'ch1',
    channel_name: 'chan',
    thread_id: null,
    thread_root_id: null,
    legacy_thread_conversation_id: null,
    conversation: { id: 'ch1', title: 'chan' },
    status: 'todo',
    title: 'a task',
    assignee: null,
    creator: { type: 'user', id: 'u1', name: 'Shiki' },
    created_at: 1000,
    closed_at: null,
    ...overrides,
  };
}

const byWorkspace = (t: TaskSummaryDto, id: string): boolean => t.workspace_id === id;

describe('applyTaskFilters', () => {
  const tasks = [
    task({ message_id: 'a', workspace_id: 'ws1' }),
    task({ message_id: 'b', workspace_id: 'ws2' }),
    task({
      message_id: 'c',
      workspace_id: 'ws1',
      assignee: { type: 'agent', id: 'ag1', name: 'Alice' },
    }),
  ];

  it('returns all tasks at default filters', () => {
    expect(applyTaskFilters(tasks, DEFAULT_TASK_FILTERS, byWorkspace)).toHaveLength(3);
  });

  it('filters by channel via the supplied predicate', () => {
    const f: TaskFilters = { ...DEFAULT_TASK_FILTERS, channelId: 'ws1' };
    expect(applyTaskFilters(tasks, f, byWorkspace).map(t => t.message_id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('filters assignee=unassigned vs a specific person', () => {
    const unassigned: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      assignee: { kind: 'unassigned' },
    };
    expect(applyTaskFilters(tasks, unassigned, byWorkspace).map(t => t.message_id)).toEqual([
      'a',
      'b',
    ]);

    const person: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      assignee: { kind: 'person', person: { type: 'agent', id: 'ag1' } },
    };
    expect(applyTaskFilters(tasks, person, byWorkspace).map(t => t.message_id)).toEqual([
      'c',
    ]);
  });

  it('keys person filters by {type,id} so agent/user ids do not collide', () => {
    const collide = [
      task({ message_id: 'x', creator: { type: 'agent', id: 'shared', name: 'A' } }),
      task({ message_id: 'y', creator: { type: 'user', id: 'shared', name: 'U' } }),
    ];
    const f: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      creator: { kind: 'person', person: { type: 'user', id: 'shared' } },
    };
    expect(applyTaskFilters(collide, f, byWorkspace).map(t => t.message_id)).toEqual(['y']);
  });
});

describe('collectAssignees / collectCreators', () => {
  it('dedupes assignees and sorts by name', () => {
    const tasks = [
      task({ assignee: { type: 'agent', id: 'b', name: 'Bob' } }),
      task({ assignee: { type: 'agent', id: 'a', name: 'Ann' } }),
      task({ assignee: { type: 'agent', id: 'b', name: 'Bob' } }),
      task({ assignee: null }),
    ];
    expect(collectAssignees(tasks).map(o => o.name)).toEqual(['Ann', 'Bob']);
  });

  it('skips system creators (no selectable person)', () => {
    const tasks = [
      task({ creator: { type: 'system', id: null, name: 'system' } }),
      task({ creator: { type: 'user', id: 'u1', name: 'Shiki' } }),
    ];
    expect(collectCreators(tasks).map(o => o.name)).toEqual(['Shiki']);
  });
});

describe('taskFiltersEqual (Clear / baseline comparison)', () => {
  it('treats a drawer baseline (current channel) as equal to itself', () => {
    const baseline: TaskFilters = { ...DEFAULT_TASK_FILTERS, channelId: 'ch1' };
    // drawer 初始 = baseline → 不应显示 Clear
    expect(taskFiltersEqual(baseline, baseline)).toBe(true);
    // 切到别的 channel → 与 baseline 不同
    expect(taskFiltersEqual(baseline, { ...baseline, channelId: 'ch2' })).toBe(false);
    // 切到 All → 与 baseline 不同（Clear 会回到 baseline 的 current channel）
    expect(taskFiltersEqual(baseline, { ...baseline, channelId: null })).toBe(false);
  });

  it('compares person filters by value', () => {
    expect(
      taskFiltersEqual(DEFAULT_TASK_FILTERS, {
        ...DEFAULT_TASK_FILTERS,
        assignee: { kind: 'person', person: { type: 'agent', id: 'a' } },
      }),
    ).toBe(false);
  });
});
