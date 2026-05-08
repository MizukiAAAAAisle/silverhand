import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { AgentRunState } from '@silverhand/shared';
import {
  agentRunStatesKey,
  applyAgentRunState,
  applyAgentRunStateToCache,
  reconcileAgentRunStateSnapshot,
} from './agentRunStateCache';

describe('agent run state cache', () => {
  it('keeps per-conversation cache writes isolated', () => {
    const client = new QueryClient();
    const state = runState({
      conversationId: 'conversation-a',
      agentId: 'agent-1',
      runId: 'run-1',
    });

    applyAgentRunStateToCache('conversation-b', state, client);

    expect(client.getQueryData(agentRunStatesKey('conversation-b'))).toBeUndefined();
    expect(client.getQueryData(agentRunStatesKey('conversation-a'))).toBeUndefined();
  });

  it('does not let an older run replace a newer run for the same agent', () => {
    const newer = runState({
      conversationId: 'conversation-a',
      agentId: 'agent-1',
      runId: 'newer',
      startedAt: 200,
      updatedAt: 220,
    });
    const older = runState({
      conversationId: 'conversation-a',
      agentId: 'agent-1',
      runId: 'older',
      startedAt: 100,
      updatedAt: 300,
    });

    expect(applyAgentRunState([newer], older)).toEqual([newer]);
  });

  it('uses terminal tombstones to keep stale snapshots from reviving a run', () => {
    const client = new QueryClient();
    const now = Date.now();
    const active = runState({
      conversationId: 'conversation-a',
      agentId: 'agent-1',
      runId: 'run-1',
      startedAt: now - 200,
      updatedAt: now - 200,
    });
    const terminal = runState({
      conversationId: 'conversation-a',
      agentId: 'agent-1',
      runId: 'run-1',
      status: 'idle',
      startedAt: now - 200,
      updatedAt: now,
      terminalReason: 'replaced',
    });

    applyAgentRunStateToCache('conversation-a', active, client);
    applyAgentRunStateToCache('conversation-a', terminal, client);

    const reconciled = reconcileAgentRunStateSnapshot(
      undefined,
      [active],
      now - 100,
    );

    expect(reconciled).toEqual([]);
  });
});

function runState(
  overrides: Partial<AgentRunState> & {
    conversationId: string;
    agentId: string;
    runId: string;
  },
): AgentRunState {
  const now = overrides.updatedAt ?? overrides.startedAt ?? 100;
  return {
    status: 'thinking',
    startedAt: now,
    updatedAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}
