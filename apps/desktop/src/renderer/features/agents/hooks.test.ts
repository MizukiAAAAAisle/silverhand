import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { agentRunStatesKey } from '@/lib/agentRunStateCache';
import { applySwitchAgentRuntimeSideEffects } from './hooks';

/**
 * The runtime-switch transition may restart every conversation an agent
 * participates in, so `onSuccess` must invalidate every conversation-scoped
 * agent-run-states query — not just the agent's own detail row. Cindy's
 * #1470 review caught two previous drift versions of this predicate; the
 * test seeds real keys (from `lib/agentRunStateCache::agentRunStatesKey`,
 * the single authority) and asserts they get marked invalid.
 */
describe('applySwitchAgentRuntimeSideEffects', () => {
  it('invalidates every seeded agent-run-states query (predicate walks the whole cache)', () => {
    const qc = new QueryClient();
    const c1 = agentRunStatesKey('conv-1');
    const c2 = agentRunStatesKey('conv-2');
    qc.setQueryData(c1, { agents: [] });
    qc.setQueryData(c2, { agents: [] });

    applySwitchAgentRuntimeSideEffects(qc, 'agent-1');

    expect(qc.getQueryState(c1)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(c2)?.isInvalidated).toBe(true);
  });

  it('invalidates the agent detail + agent-scoped runtime-state singleton', () => {
    const qc = new QueryClient();
    qc.setQueryData(['agents', 'agent-1'], { id: 'agent-1' });
    qc.setQueryData(['agents', 'agent-1', 'runtime-state'], {
      participations: [],
      visible_participations: [],
      seats: [],
    });
    qc.setQueryData(['agents'], []);

    applySwitchAgentRuntimeSideEffects(qc, 'agent-1');

    expect(qc.getQueryState(['agents'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['agents', 'agent-1'])?.isInvalidated).toBe(true);
    expect(
      qc.getQueryState(['agents', 'agent-1', 'runtime-state'])?.isInvalidated,
    ).toBe(true);
  });

  it('does not touch unrelated conversation-scoped queries', () => {
    // Non-run-state conversation queries (e.g. message lists) share the
    // `['conversations', id, ...]` prefix; the predicate must narrow on the
    // trailing `'agent-run-states'` segment so those unrelated queries stay
    // fresh and don't refetch on every runtime switch.
    const qc = new QueryClient();
    const runStateKey = agentRunStatesKey('conv-1');
    const messagesKey = ['conversations', 'conv-1', 'messages'] as const;
    qc.setQueryData(runStateKey, { agents: [] });
    qc.setQueryData(messagesKey, []);

    applySwitchAgentRuntimeSideEffects(qc, 'agent-1');

    expect(qc.getQueryState(runStateKey)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(messagesKey)?.isInvalidated).toBe(false);
  });
});
