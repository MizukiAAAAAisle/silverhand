import type { AgentStreamActivityEvent, AgentStreamActivityListResponse, ServerFrame, TransportEpoch, TransportSeq } from '@silverhand/shared';
import { AgentStreamActivityEventSchema, agentActivityScope, apiPaths } from '@silverhand/shared';
import { ApiError, api } from '@/lib/api';
import { eventWsClient, onWsFrame, type WsClientStatus } from '@/lib/ws-client';
import { interestRegistry } from '@/features/realtime/interest-registry';

export interface AgentStreamSnapshot {
  events: AgentStreamActivityEvent[];
  nextBeforeId: number | null;
  phase: 'loading' | 'ready' | 'error';
  isLoadingMore: boolean;
}
const empty = (): AgentStreamSnapshot => ({ events: [], nextBeforeId: null, phase: 'loading', isLoadingMore: false });

/** Canonical upserts are ordered by the transport; later payloads replace earlier ones. */
export function upsertAgentStream(existing: readonly AgentStreamActivityEvent[], incoming: readonly AgentStreamActivityEvent[]): AgentStreamActivityEvent[] {
  const rows = new Map(existing.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => a.id - b.id);
}

interface Dependencies {
  read(agentId: string, beforeId: number | null, signal: AbortSignal): Promise<AgentStreamActivityListResponse>;
  retain(scope: string, holder: string): { release(): void };
  onFrame(listener: (frame: ServerFrame) => void): () => void;
  onStatus(listener: (status: WsClientStatus) => void): () => void;
}

export function createAgentStreamCache(deps: Dependencies) {
  const entries = new Map<string, ReturnType<typeof createEntry>>();

  function createEntry(userId: string, agentId: string) {
    let snapshot = empty();
    const listeners = new Set<() => void>();
    const scope = agentActivityScope(agentId);
    let release: (() => void) | undefined;
    let offFrame: (() => void) | undefined;
    let offStatus: (() => void) | undefined;
    let request: AbortController | undefined;
    let buffer: AgentStreamActivityEvent[] = [];
    let acknowledged = false;
    let epoch: TransportEpoch | undefined;
    let lastSeq: TransportSeq | undefined;
    let denied = false;

    const publish = (value: AgentStreamSnapshot) => {
      snapshot = value;
      for (const listener of listeners) listener();
    };
    const cancel = () => { request?.abort(); request = undefined; buffer = []; };
    const detach = () => {
      cancel(); acknowledged = false;
      release?.(); release = undefined;
      offFrame?.(); offFrame = undefined;
      offStatus?.(); offStatus = undefined;
    };
    const deny = () => {
      denied = true;
      detach();
      publish({ ...empty(), phase: 'error' });
    };

    async function read(beforeId: number | null) {
      if (!acknowledged || denied) return;
      cancel();
      const controller = new AbortController();
      request = controller;
      publish(beforeId === null ? empty() : { ...snapshot, isLoadingMore: true });
      try {
        const page = await deps.read(agentId, beforeId, controller.signal);
        if (request !== controller || controller.signal.aborted) return;
        const base = beforeId === null ? page.events : upsertAgentStream(page.events, snapshot.events);
        publish({ events: upsertAgentStream(base, buffer), nextBeforeId: page.next_before_id, phase: 'ready', isLoadingMore: false });
      } catch (error) {
        if (request !== controller || controller.signal.aborted) return;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          deny();
          return;
        }
        publish({ ...snapshot, events: upsertAgentStream(snapshot.events, buffer), phase: beforeId === null ? 'error' : snapshot.phase, isLoadingMore: false });
      } finally {
        if (request === controller) { request = undefined; buffer = []; }
      }
    }

    const attach = () => {
      denied = false;
      offFrame = deps.onFrame(frame => {
        if (frame.type === 'error') {
          if ((frame.code === 'forbidden' && frame.scope === scope)
            || frame.code === 'auth_failed' || frame.code === 'auth_required') deny();
          return;
        }
        if (!('scope' in frame) || frame.scope !== scope) return;
        if (frame.type === 'subscribed') {
          acknowledged = true;
          if (epoch !== frame.epoch) lastSeq = undefined;
          epoch = frame.epoch;
          void read(null);
        } else if (frame.type === 'snapshot_required') {
          epoch = frame.epoch;
          lastSeq = frame.currentSeq;
          void read(null);
        } else if (frame.type === 'event' && frame.kind === 'agent_stream_activity') {
          if (epoch !== frame.epoch) {
            epoch = frame.epoch;
            lastSeq = undefined;
            void read(null);
          }
          // The transport deliberately redelivers duplicates; do not replay an old refinement.
          if (lastSeq !== undefined && frame.seq <= lastSeq) return;
          lastSeq = frame.seq;
          const parsed = AgentStreamActivityEventSchema.safeParse(frame.payload);
          if (!parsed.success || parsed.data.agent_id !== agentId) return;
          if (request) buffer.push(parsed.data);
          else if (acknowledged && snapshot.phase === 'ready') publish({ ...snapshot, events: upsertAgentStream(snapshot.events, [parsed.data]) });
        }
      });
      offStatus = deps.onStatus(status => {
        if (status !== 'connected') {
          acknowledged = false;
          cancel();
        }
      });
      const handle = deps.retain(scope, `agent-activity:${userId}:${agentId}`);
      release = () => handle.release();
    };

    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        if (listeners.size === 1) attach();
        return () => {
          listeners.delete(listener);
          if (listeners.size === 0) { detach(); snapshot = empty(); }
        };
      },
      loadEarlier: async () => {
        if (!request && snapshot.nextBeforeId !== null) await read(snapshot.nextBeforeId);
      },
      clear() { deny(); },
    };
  }

  return {
    get(userId: string, agentId: string) {
      const key = JSON.stringify([userId, agentId]);
      let entry = entries.get(key);
      if (!entry) { entry = createEntry(userId, agentId); entries.set(key, entry); }
      return entry;
    },
    clear() { for (const entry of entries.values()) entry.clear(); entries.clear(); },
  };
}

export const agentStreamCache = createAgentStreamCache({
  read: (agentId, beforeId, signal) => api<AgentStreamActivityListResponse>(
    `${apiPaths.agentActivity(agentId)}?limit=100${beforeId === null ? '' : `&before_id=${beforeId}`}`, { signal },
  ),
  retain: (scope, holder) => interestRegistry.retain(scope, holder),
  onFrame: onWsFrame,
  onStatus: listener => eventWsClient.onStatus(listener),
});
