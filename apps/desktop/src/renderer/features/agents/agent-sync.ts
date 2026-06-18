import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentChangedEventSchema, type ServerFrame } from '@silverhand/shared';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';

/**
 * What an incoming WS frame means for the `['agents']` query cache:
 *  - `invalidate` — either an app-scope `agent_changed` event (valid
 *    payload) OR an app-scope `snapshot_required` (the server told us this
 *    scope's increments are discontinuous: epoch mismatch / replay gap).
 *  - `null` — anything else (other scopes/kinds, transport frames,
 *    malformed payload).
 * Pure — exported for unit tests. Mirrors `decidePresenceFrameAction`
 * (features/presence/hooks.ts); both refresh paths collapse to one action
 * because the only reconciliation agent queries need is a refetch.
 *
 * Why `snapshot_required` is handled here and NOT left to React Query's
 * `refetchOnReconnect`/`refetchOnWindowFocus`: this is a WS-stream replay
 * signal, not a browser offline→online transition (Cindy review #task:1178).
 * The socket can resume while the browser stays online and the window stays
 * focused, so neither auto-refetch necessarily fires — the only correct
 * recovery for a dropped app-scope delta (e.g. a missed `agent_changed`) is
 * to invalidate on the snapshot signal, exactly as the presence / workspace
 * / task scope hooks do.
 *
 * `agent_changed` is the backend's single propagation signal for any
 * AgentDto mutation (display_name / description / avatar / runtime /
 * model), published on the global `app` scope by `agentService` after a
 * successful write — from BOTH write paths (human `PATCH /api/agents/:id`
 * + avatar upload/delete, and the agent CLI `profile update`). See
 * #task:1178.
 */
export type AgentSyncAction = { kind: 'invalidate' };

export function decideAgentSyncAction(frame: ServerFrame): AgentSyncAction | null {
  if (frame.type === 'snapshot_required') {
    return frame.scope === 'app' ? { kind: 'invalidate' } : null;
  }
  if (
    frame.type !== 'event' ||
    frame.scope !== 'app' ||
    frame.kind !== 'agent_changed'
  ) {
    return null;
  }
  return AgentChangedEventSchema.safeParse(frame.payload).success
    ? { kind: 'invalidate' }
    : null;
}

/**
 * Subscribe to the global `app` scope and invalidate the agent query tree
 * whenever the backend publishes `agent_changed` (or a `snapshot_required`
 * recovery — see {@link decideAgentSyncAction}). **Mount ONCE in the app
 * shell** (next to {@link usePresenceSync}) — it must outlive any single
 * view so an agent edited from anywhere (this client's UI, another window,
 * or an agent's own `silverhand profile update`) refreshes everywhere.
 *
 * One prefix invalidation of `['agents']` covers all three concerns:
 *  - the global list (`['agents']`) — name / runtime / avatar columns;
 *  - the per-agent detail subtree (`['agents', id, ...]`);
 *  - the avatar itself, for free — the object-url effect keys on
 *    `avatar_url`, which carries the `?v=updated_at` cache-buster
 *    (avatar-hooks.ts), so a refetched DTO yields a new URL → new blob.
 *
 * Inactive queries are only marked stale (no refetch until mounted), so
 * the broad prefix is cheap. Renderer mutation `onSuccess` keeps its local
 * fast-path but is no longer the sole propagation mechanism.
 *
 * Note: a combined edit (text + avatar in one request) publishes two
 * `agent_changed` frames; React Query coalesces concurrent invalidations
 * of the same key into a single refetch, so this is harmless.
 */
export function useAgentSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeWsScope('app');
    const unsub = onWsFrame(frame => {
      if (!decideAgentSyncAction(frame)) return;
      void qc.invalidateQueries({ queryKey: ['agents'] });
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}
