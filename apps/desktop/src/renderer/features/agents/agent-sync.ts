import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentChangedEventSchema, type ServerFrame } from '@silverhand/shared';
import { invalidateIdentityCarrierCaches } from '@/features/identity/identity-carrier-caches';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';

/**
 * What an incoming WS frame means for the agent-identity caches:
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
 * AgentDto identity write — a genuine agent creation, or a mutation
 * (display_name / description / avatar / runtime / model) — published on
 * the global `app` scope after a successful commit. Update paths (human
 * `PATCH /api/agents/:id` + avatar upload/delete, and the agent CLI
 * `profile update`) go through `agentService`; the create path is a
 * post-commit effect of provisioning. See #task:1178 / #task:1707.
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
 * Subscribe to the global `app` scope and reseat every cache that carries an
 * agent's identity whenever the backend publishes `agent_changed` (or a
 * `snapshot_required` recovery — see {@link decideAgentSyncAction}). **Mount
 * ONCE in the app shell** (next to {@link usePresenceSync}) — it must outlive
 * any single view so an agent edited from anywhere (this client's UI, another
 * window, or an agent's own `silverhand profile update`) refreshes everywhere.
 *
 * The `['agents']` prefix covers the directory and every per-agent subtree —
 * avatars included, since the object-url effect keys on the `?v=updated_at`
 * cache-buster (avatar-hooks.ts). But the backend also denormalizes
 * `display_name` / `avatar_url` into read models keyed by conversation,
 * workspace, host and message, which no prefix derived from `agent_id` can
 * reach; those live in the shared identity-carrier registry and are reseated
 * here under the `agent` subject kind. #task:1702's user-profile consumer calls
 * the same seam with `human`, so neither axis refetches the other's caches.
 *
 * Inactive queries are only marked stale (no refetch until mounted), so the
 * broad prefixes are cheap. Renderer mutation `onSuccess` keeps its local
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
      invalidateIdentityCarrierCaches(qc, 'agent');
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}
