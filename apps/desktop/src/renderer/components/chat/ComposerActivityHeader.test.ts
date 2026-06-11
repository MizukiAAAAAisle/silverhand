import { describe, expect, it } from 'vitest';
import type { AgentRunState } from '@silverhand/shared';
import { selectActiveRunStates } from './ComposerActivityHeader';

/**
 * Locks the activity-bubble selection used by the Composer header,
 * including the thread follower filter (item 4 of #task:1047 cut B). The
 * bubble's run-state stream is channel-scoped — a reply cluster is not a
 * separate conversation — so inside the ThreadPanel it must be narrowed to
 * the thread's follower agents, or it would surface agents busy on the main
 * line / other clusters.
 */

function runState(overrides: Partial<AgentRunState> = {}): AgentRunState {
  return {
    runId: `run-${overrides.agentId ?? 'x'}`,
    agentId: 'a-1',
    conversationId: 'c-1',
    status: 'thinking',
    startedAt: 0,
    updatedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

describe('selectActiveRunStates', () => {
  it('drops terminal (idle / failed) states', () => {
    const states = [
      runState({ agentId: 'a-1', status: 'thinking' }),
      runState({ agentId: 'a-2', status: 'idle' }),
      runState({ agentId: 'a-3', status: 'failed' }),
      runState({ agentId: 'a-4', status: 'tool_running' }),
    ];
    expect(selectActiveRunStates(states).map(s => s.agentId)).toEqual([
      'a-4', // tool_running ranks above thinking
      'a-1',
    ]);
  });

  it('no restriction (null/undefined) keeps every non-terminal state', () => {
    const states = [
      runState({ agentId: 'a-1', status: 'thinking' }),
      runState({ agentId: 'a-2', status: 'thinking' }),
    ];
    expect(selectActiveRunStates(states, null).map(s => s.agentId).sort()).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(
      selectActiveRunStates(states, undefined).map(s => s.agentId).sort(),
    ).toEqual(['a-1', 'a-2']);
  });

  it('restricts to the follower allow-list', () => {
    const states = [
      runState({ agentId: 'a-1', status: 'thinking' }),
      runState({ agentId: 'a-2', status: 'tool_running' }),
      runState({ agentId: 'a-3', status: 'thinking' }),
    ];
    // Only a-1 and a-3 follow this thread → a-2 (busy on main line) hidden.
    expect(
      selectActiveRunStates(states, ['a-1', 'a-3']).map(s => s.agentId).sort(),
    ).toEqual(['a-1', 'a-3']);
  });

  it('empty allow-list yields nothing (thread with no follower agents)', () => {
    const states = [runState({ agentId: 'a-1', status: 'tool_running' })];
    expect(selectActiveRunStates(states, [])).toEqual([]);
  });

  it('sorts tool_running ahead of thinking, ties broken by recency', () => {
    const states = [
      runState({ agentId: 'a-1', status: 'thinking', lastActivityAt: 5 }),
      runState({ agentId: 'a-2', status: 'thinking', lastActivityAt: 9 }),
      runState({ agentId: 'a-3', status: 'tool_running', lastActivityAt: 1 }),
    ];
    expect(selectActiveRunStates(states).map(s => s.agentId)).toEqual([
      'a-3', // tool_running first regardless of recency
      'a-2', // newer thinking before older
      'a-1',
    ]);
  });
});
