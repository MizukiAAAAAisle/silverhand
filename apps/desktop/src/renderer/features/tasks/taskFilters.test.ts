import { describe, expect, it } from 'vitest';
import {
  applyWorkspaceCascade,
  DEFAULT_TASK_FILTERS,
  personFilterKey,
  taskFiltersEqual,
  type TaskFilters,
} from './taskFilters';

describe('personFilterKey', () => {
  // The collision property the whole person axis rests on. It used to be
  // asserted through `applyTaskFilters`, which was retired with the fetch-all
  // list (#task:1892) — the property is not: agent and user ids share no
  // namespace guarantee, so a key built from the id ALONE would make an agent
  // and a user with the same id one selection here, in `taskFiltersEqual`, and
  // in the wire params derived from them.
  it('keys a person by {type,id} so agent/user ids do not collide', () => {
    expect(personFilterKey({ kind: 'person', person: { type: 'agent', id: 'shared' } })).not.toBe(
      personFilterKey({ kind: 'person', person: { type: 'user', id: 'shared' } }),
    );
  });

  it('gives the two non-person values their own keys', () => {
    expect(personFilterKey({ kind: 'any' })).toBe('any');
    expect(personFilterKey({ kind: 'unassigned' })).toBe('unassigned');
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

  it('distinguishes the workspace dimension', () => {
    expect(
      taskFiltersEqual(DEFAULT_TASK_FILTERS, {
        ...DEFAULT_TASK_FILTERS,
        workspaceId: 'ws1',
      }),
    ).toBe(false);
  });
});

describe('applyWorkspaceCascade (#task:1387 workspace→channel)', () => {
  // channel c-eng belongs to ws-eng; c-design belongs to ws-design.
  const channelWorkspaceId = (id: string): string | null =>
    ({ 'c-eng': 'ws-eng', 'c-design': 'ws-design' })[id] ?? null;

  it('selecting a workspace drops a channel that belongs to another workspace', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      workspaceId: null,
      channelId: 'c-design',
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after.workspaceId).toBe('ws-eng');
    expect(after.channelId).toBeNull(); // orphan channel cleared
  });

  it('keeps a channel that belongs to the newly selected workspace', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      channelId: 'c-eng',
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after).toMatchObject({ workspaceId: 'ws-eng', channelId: 'c-eng' });
  });

  it('selecting "All workspaces" keeps any channel (channel filter unconstrained)', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      workspaceId: 'ws-eng',
      channelId: 'c-eng',
    };
    const after = applyWorkspaceCascade(before, null, channelWorkspaceId);
    expect(after).toMatchObject({ workspaceId: null, channelId: 'c-eng' });
  });

  it('preserves the non-cascaded dimensions (assignee / creator)', () => {
    const before: TaskFilters = {
      ...DEFAULT_TASK_FILTERS,
      channelId: 'c-design',
      assignee: { kind: 'person', person: { type: 'agent', id: 'a1' } },
    };
    const after = applyWorkspaceCascade(before, 'ws-eng', channelWorkspaceId);
    expect(after.assignee).toEqual(before.assignee);
  });
});
