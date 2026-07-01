import type { AgentRunState } from '@silverhand/shared';
import type { QueryClient } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';

export const AGENT_RUN_STATES_GC_MS = 30 * 60_000;
const TERMINAL_RUN_TOMBSTONE_TTL_MS = 5 * 60_000;

export const agentRunStatesKey = (conversationId: string) =>
  ['conversations', conversationId, 'agent-run-states'] as const;

/** True when an agent-run-states reader (`useAgentRunStates`, or the Composer
 *  activity header) is mounted — the exact key has at least one active observer.
 *  Stage-2 P1c gate (#task:1255): the central ingestor took over the
 *  `agent_activity` cache write + the `snapshot_required` invalidate that used
 *  to ride the per-view conversation stream, so both happen ONLY while a reader
 *  is alive. A non-terminal `agent_activity` bootstraps an incomplete one-row
 *  list, so it must not write with no reader; on the next mount the reader's
 *  `refetchOnMount: 'always'` reconciles the full snapshot regardless. */
export function hasActiveAgentRunStatesReader(
  qc: QueryClient,
  conversationId: string,
): boolean {
  const entry = qc
    .getQueryCache()
    .find({ queryKey: agentRunStatesKey(conversationId), exact: true });
  return (entry?.getObserversCount() ?? 0) > 0;
}

/** Reconcile agent-run-states on `snapshot_required` (#task:1255 P1c) — verbatim
 *  move of `useAgentRunStates.onEvent`: a reconnect may have missed terminal /
 *  start events, so refetch the snapshot (the queryFn merges any newer live
 *  updates that arrived while the request was in flight). */
export function invalidateAgentRunStates(
  qc: QueryClient,
  conversationId: string,
): Promise<void> {
  // Returns the invalidate Promise (reconcile-settle signal for the P2 snapshot
  // join, #1255 P2); strategy unchanged.
  return qc.invalidateQueries({ queryKey: agentRunStatesKey(conversationId) });
}

const terminalRunUpdatedAtByKey = new Map<string, number>();

function isTerminalRunState(state: AgentRunState): boolean {
  return state.status === 'idle' || state.status === 'failed';
}

function terminalRunKey(state: AgentRunState): string {
  return `${state.conversationId}:${state.agentId}:${state.runId}`;
}

function pruneTerminalRunStates(now: number): void {
  const cutoff = now - TERMINAL_RUN_TOMBSTONE_TTL_MS;
  for (const [key, updatedAt] of terminalRunUpdatedAtByKey) {
    if (updatedAt < cutoff) terminalRunUpdatedAtByKey.delete(key);
  }
}

function recordTerminalRunState(state: AgentRunState): void {
  pruneTerminalRunStates(Date.now());
  terminalRunUpdatedAtByKey.set(terminalRunKey(state), state.updatedAt);
}

function hasNewerTerminalRunState(state: AgentRunState, requestedAt: number): boolean {
  pruneTerminalRunStates(Date.now());
  return (terminalRunUpdatedAtByKey.get(terminalRunKey(state)) ?? -1) >= requestedAt;
}

export function applyAgentRunState(
  previous: AgentRunState[] | undefined,
  state: AgentRunState,
): AgentRunState[] {
  const current = previous ?? [];

  if (isTerminalRunState(state)) {
    return current.filter(
      s => !(s.agentId === state.agentId && s.runId === state.runId),
    );
  }

  const index = current.findIndex(s => s.agentId === state.agentId);
  if (index === -1) return [...current, state];

  const existing = current[index]!;
  const shouldReplace =
    state.startedAt > existing.startedAt ||
    (state.startedAt === existing.startedAt && state.runId !== existing.runId) ||
    (state.runId === existing.runId && state.updatedAt >= existing.updatedAt);

  if (!shouldReplace) return current;

  return current.map((s, i) => (i === index ? state : s));
}

export function reconcileAgentRunStateSnapshot(
  previous: AgentRunState[] | undefined,
  snapshot: AgentRunState[],
  requestedAt: number,
): AgentRunState[] {
  let next = snapshot.filter(state => !hasNewerTerminalRunState(state, requestedAt));

  for (const state of previous ?? []) {
    if (state.updatedAt < requestedAt) continue;
    next = applyAgentRunState(next, state);
  }

  return next;
}

export function applyAgentRunStateToCache(
  conversationId: string,
  state: AgentRunState | undefined,
  client: QueryClient = queryClient,
): void {
  if (!state?.runId || state.conversationId !== conversationId) return;

  const key = agentRunStatesKey(conversationId);
  const hasCachedState = client.getQueryData<AgentRunState[]>(key) !== undefined;
  if (isTerminalRunState(state)) {
    recordTerminalRunState(state);
  }
  if (isTerminalRunState(state) && !hasCachedState) return;

  client.setQueryData<AgentRunState[]>(key, previous =>
    applyAgentRunState(previous, state),
  );
}
