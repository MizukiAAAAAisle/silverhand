import { describe, expect, it } from 'vitest';
import {
  TaskPlaceSchema,
  TaskSummaryDtoSchema,
  type TaskSummaryDto,
} from '../src/api/task.js';

const base = {
  id: 'task-1',
  task_number: 1,
  thread_root_id: null,
  status: 'todo' as const,
  title: 'task',
  assignee: null,
  creator: { type: 'user' as const, id: 'user-1', name: 'shiki' },
  created_at: 1,
  closed_at: null,
};

describe('TaskSummaryDto placement projection', () => {
  it('narrows placement coordinates exclusively through place.kind', () => {
    const workspace: TaskSummaryDto = {
      ...base,
      place: {
        kind: 'workspace',
        conversation_id: 'conversation-1',
        workspace_id: 'workspace-1',
        workspace_kind: 'regular',
        channel_name: 'general',
      },
    };
    if (workspace.place.kind === 'workspace') {
      expect(workspace.place.workspace_id).toBe('workspace-1');
      expect(workspace.place.conversation_id).toBe('conversation-1');
      // @ts-expect-error pair identity is structurally absent on workspace.
      void workspace.place.pair_key;
    }

    const pair: TaskSummaryDto = {
      ...base,
      place: {
        kind: 'direct_pair',
        conversation_id: 'conversation-1',
        pair_key: 'pair-key',
      },
    };
    if (pair.place.kind === 'direct_pair') {
      expect(pair.place.pair_key).toBe('pair-key');
      expect(pair.place.conversation_id).toBe('conversation-1');
      // @ts-expect-error workspace coordinates are structurally absent on pair.
      void pair.place.workspace_id;
      // @ts-expect-error display title is structurally absent on pair.
      void pair.place.channel_name;
    }
  });

  it('folds the routing coordinate into place, with no parallel top-level channel_id', () => {
    const parsed = TaskSummaryDtoSchema.parse({
      ...base,
      place: {
        kind: 'direct_pair',
        conversation_id: 'conversation-1',
        pair_key: 'pair-key',
      },
      // Zod's object projection strips unknown legacy keys. A stale top-level
      // channel_id cannot survive into the wire during mixed-version input.
      channel_id: 'conversation-1',
      workspace_id: null,
      workspace_name: null,
    });

    expect(Object.keys(parsed).sort()).toEqual([
      'assignee',
      'closed_at',
      'created_at',
      'creator',
      'id',
      'place',
      'status',
      'task_number',
      'thread_root_id',
      'title',
    ]);
    expect(parsed.place).toEqual({
      kind: 'direct_pair',
      conversation_id: 'conversation-1',
      pair_key: 'pair-key',
    });
  });

  it('rejects the physical agent_home workspace_kind — only the domain projection reaches the wire', () => {
    // Contract §2 rule 5: the physical `agent_home` workspace_kind is projected
    // to the domain `agent_space` at the SQL boundary and never appears on the
    // wire. The schema's workspace_kind enum is the last static gate proving
    // that: `agent_home` must fail to parse. If the enum ever readmits it, this
    // reddens.
    const result = TaskPlaceSchema.safeParse({
      kind: 'workspace',
      conversation_id: 'conversation-1',
      workspace_id: 'workspace-1',
      workspace_kind: 'agent_home',
      channel_name: 'home',
    });
    expect(result.success).toBe(false);
  });
});
