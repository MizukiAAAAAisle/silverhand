import { describe, expect, it } from 'vitest';
import {
  TaskSummaryDtoSchema,
  type TaskSummaryDto,
} from '../src/api/task.js';

const base = {
  id: 'task-1',
  task_number: 1,
  channel_id: 'conversation-1',
  thread_root_id: null,
  status: 'todo' as const,
  title: 'task',
  assignee: null,
  creator: { type: 'user' as const, id: 'user-1', name: 'shiki' },
  created_at: 1,
  closed_at: null,
};

describe('TaskSummaryDto placement projection', () => {
  it('narrows placement coordinates exclusively through board.kind', () => {
    const workspace: TaskSummaryDto = {
      ...base,
      board: {
        kind: 'workspace',
        workspace_id: 'workspace-1',
        workspace_name: 'Workspace',
        channel_name: 'general',
      },
    };
    if (workspace.board.kind === 'workspace') {
      expect(workspace.board.workspace_id).toBe('workspace-1');
      // @ts-expect-error pair identity is structurally absent on workspace.
      void workspace.board.pair_key;
    }

    const pair: TaskSummaryDto = {
      ...base,
      board: { kind: 'direct_pair', pair_key: 'pair-key' },
    };
    if (pair.board.kind === 'direct_pair') {
      expect(pair.board.pair_key).toBe('pair-key');
      // @ts-expect-error workspace coordinates are structurally absent on pair.
      void pair.board.workspace_id;
      // @ts-expect-error display title is structurally absent on pair.
      void pair.board.channel_name;
    }
  });

  it('serializes no parallel placement/title keys outside the union', () => {
    const parsed = TaskSummaryDtoSchema.parse({
      ...base,
      board: { kind: 'direct_pair', pair_key: 'pair-key' },
      // Zod's object projection strips unknown legacy keys. They cannot leak a
      // stored DM sentinel title back into the wire during mixed-version input.
      workspace_id: null,
      workspace_name: null,
      channel_name: '',
      conversation: { id: 'conversation-1', title: '' },
    });

    expect(Object.keys(parsed).sort()).toEqual([
      'assignee',
      'board',
      'channel_id',
      'closed_at',
      'created_at',
      'creator',
      'id',
      'status',
      'task_number',
      'thread_root_id',
      'title',
    ]);
    expect(parsed.board).toEqual({ kind: 'direct_pair', pair_key: 'pair-key' });
  });
});
