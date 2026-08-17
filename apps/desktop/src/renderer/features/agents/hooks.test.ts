import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { agentRunStatesKey } from '@/lib/agentRunStateCache';
import {
  AGENT_LIVENESS_QUERY_POLICY,
  agentLivenessRetry,
  applySwitchAgentRuntimeSideEffects,
  projectAgentLiveness,
} from './hooks';

/**
 * The liveness endpoint has no push invalidation (#task:2043): a value the
 * client holds is trustworthy ONLY while it is a fresh successful read, so the
 * projection folds every non-fresh state to `unknown` and NEVER to `offline` (a
 * disconnected host is not a dead process, #task:2039). Each fold case is pinned
 * here in isolation because #task:2039 shipped a hook that returned the raw
 * cached value — a stale/failing read kept asserting a possibly-wrong
 * online/offline indefinitely.
 */
describe('projectAgentLiveness', () => {
  it('passes a fresh successful read straight through', () => {
    expect(projectAgentLiveness({ data: 'online', isStale: false })).toBe('online');
    expect(projectAgentLiveness({ data: 'offline', isStale: false })).toBe('offline');
    expect(projectAgentLiveness({ data: 'unknown', isStale: false })).toBe('unknown');
  });

  it('folds no value (loading / disabled / errored-with-no-data) to unknown', () => {
    expect(projectAgentLiveness({ data: undefined, isStale: false })).toBe('unknown');
    expect(projectAgentLiveness({ data: undefined, isStale: true })).toBe('unknown');
  });

  it('folds a stale value to unknown — a cached-old bit has no authority', () => {
    // Covers a value stranded behind a failing background refetch: React Query
    // retains the old `data` (status stays 'success') but never refreshes
    // `dataUpdatedAt`, so it ages into `isStale` and stops being asserted.
    expect(projectAgentLiveness({ data: 'online', isStale: true })).toBe('unknown');
    expect(projectAgentLiveness({ data: 'offline', isStale: true })).toBe('unknown');
  });

  it('keeps a FRESH value while a mounted poll is in flight — no per-poll flicker', () => {
    // The fold's input is `{ data, isStale }` and deliberately omits
    // `isFetching`: a bounded mounted poll (`refetchInterval`) is in flight on a
    // still-fresh value, and folding that to `unknown` would blink a mounted
    // `online` hero to nothing on every tick. The fresh value stays authoritative
    // until it goes stale or the poll replaces it.
    expect(projectAgentLiveness({ data: 'online', isStale: false })).toBe('online');
    expect(projectAgentLiveness({ data: 'offline', isStale: false })).toBe('offline');
  });

  it('never folds any non-fresh state to offline', () => {
    const nonFresh = [
      { data: undefined, isStale: false },
      { data: undefined, isStale: true },
      { data: 'online' as const, isStale: true },
      { data: 'offline' as const, isStale: true },
      { data: 'unknown' as const, isStale: true },
    ];
    for (const state of nonFresh) {
      expect(projectAgentLiveness(state)).not.toBe('offline');
    }
  });
});

/**
 * The endpoint has NO push invalidation (#task:2043), so freshness of a MOUNTED
 * value is the query config's job — the fold alone cannot save it. #task:2039's
 * Round 1 shipped `staleTime` WITHOUT a refetch interval: `staleTime` only
 * expires the value, it never refetches, so a resident hero read once at mount
 * aged to `unknown` after 15s and vanished. These pin the policy as a config:
 * the interval must exist and be STRICTLY below staleTime (so a reachable host
 * stays fresh between polls), and the retry ceiling must be bounded.
 */
describe('AGENT_LIVENESS_QUERY_POLICY', () => {
  it('polls on a bounded interval strictly shorter than staleTime', () => {
    // < staleMs is the whole invariant: each mounted poll refreshes
    // `dataUpdatedAt` before the value can age out, so the fold never sees a
    // fresh value flip to `unknown` between polls. `>=` would reintroduce the
    // 15s-then-gone bug (the value goes stale before the next poll refreshes it).
    expect(AGENT_LIVENESS_QUERY_POLICY.refetchIntervalMs).toBeGreaterThan(0);
    expect(AGENT_LIVENESS_QUERY_POLICY.refetchIntervalMs).toBeLessThan(
      AGENT_LIVENESS_QUERY_POLICY.staleMs,
    );
  });

  it('does not poll while unmounted / backgrounded', () => {
    // A surface with no viewer stops polling and refetches on next mount.
    expect(AGENT_LIVENESS_QUERY_POLICY.refetchIntervalInBackground).toBe(false);
  });

  it('bounds retries with a finite positive ceiling', () => {
    expect(AGENT_LIVENESS_QUERY_POLICY.maxRetries).toBeGreaterThan(0);
    expect(Number.isInteger(AGENT_LIVENESS_QUERY_POLICY.maxRetries)).toBe(true);
  });
});

/**
 * The retry predicate is the OTHER half of the freshness contract: a failing
 * read must eventually stop and let the fold settle into `unknown` rather than
 * hammer an unreachable host forever, but a 4xx (the anti-enumeration answer for
 * a non-viewer) must not be retried at all.
 */
describe('agentLivenessRetry', () => {
  it('never retries a 4xx — it is a terminal answer, not a transient failure', () => {
    for (const status of [400, 403, 404, 429]) {
      expect(agentLivenessRetry(0, new ApiError(status, 'client', 'no'))).toBe(false);
    }
  });

  it('retries a 5xx up to the ceiling, then stops', () => {
    const err = new ApiError(500, 'Server Error', '');
    const { maxRetries } = AGENT_LIVENESS_QUERY_POLICY;
    expect(agentLivenessRetry(0, err)).toBe(true);
    expect(agentLivenessRetry(maxRetries - 1, err)).toBe(true);
    expect(agentLivenessRetry(maxRetries, err)).toBe(false);
  });

  it('retries a transport failure up to the ceiling, then stops', () => {
    // status 0 (unreachable backend) and non-ApiError both fall through to the
    // bounded branch — a disconnected host is a "try again", not a 4xx verdict.
    const transport = new ApiError(0, '', 'backend_unreachable', 'backend_unreachable');
    const { maxRetries } = AGENT_LIVENESS_QUERY_POLICY;
    expect(agentLivenessRetry(0, transport)).toBe(true);
    expect(agentLivenessRetry(0, new Error('boom'))).toBe(true);
    expect(agentLivenessRetry(maxRetries, transport)).toBe(false);
    expect(agentLivenessRetry(maxRetries, new Error('boom'))).toBe(false);
  });
});

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
