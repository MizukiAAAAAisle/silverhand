import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  HOST_CONNECTION_CHANGED_EVENT,
  HostConnectionChangedEventSchema,
  type ServerFrame,
} from '@silverhand/shared';
import {
  isCurrentViewerScope,
  onWsFrame,
  subscribeViewerScope,
} from '@/lib/ws-client';
import {
  backendInfoKey,
  hostsKey,
  hostStatusKey,
} from './hooks';

export type HostConnectionSyncAction =
  | { kind: 'invalidate-all' }
  | { kind: 'invalidate-host'; hostId: string };

/**
 * Host presence is the backend connection registry's projection. WS frames are
 * invalidation signals only; renderer never patches availability from the
 * event payload. On `snapshot_required` we reconcile the whole owner-scoped
 * host tree, because the attach/detach delta that was missed is unknown.
 */
export function decideHostConnectionSyncAction(
  frame: ServerFrame,
  isViewerScope: (scope: string) => boolean = isCurrentViewerScope,
): HostConnectionSyncAction | null {
  if (frame.type === 'snapshot_required') {
    return isViewerScope(frame.scope) ? { kind: 'invalidate-all' } : null;
  }

  if (
    frame.type !== 'event' ||
    frame.kind !== HOST_CONNECTION_CHANGED_EVENT ||
    !isViewerScope(frame.scope)
  ) {
    return null;
  }

  const parsed = HostConnectionChangedEventSchema.safeParse(frame.payload);
  if (!parsed.success) return null;
  return { kind: 'invalidate-host', hostId: parsed.data.host_id };
}

function invalidateHostConnectionQueries(
  qc: QueryClient,
  action: HostConnectionSyncAction,
): void {
  void qc.invalidateQueries({ queryKey: hostsKey });
  void qc.invalidateQueries({ queryKey: backendInfoKey });

  if (action.kind === 'invalidate-all') {
    void qc.invalidateQueries({ queryKey: ['host'] });
    void qc.invalidateQueries({ queryKey: ['host-status'] });
    return;
  }

  void qc.invalidateQueries({ queryKey: ['host', action.hostId] });
  void qc.invalidateQueries({ queryKey: hostStatusKey(action.hostId) });
}

/**
 * Mount once in the app shell. User-managed computer attach/detach is private
 * owner state, so the backend publishes on `viewer:{ownerUserId}`. Active
 * status/detail/list queries refetch immediately; inactive ones are marked
 * stale for the next mount.
 */
export function useHostConnectionSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeViewerScope();
    const unsub = onWsFrame(frame => {
      const action = decideHostConnectionSyncAction(frame);
      if (!action) return;
      invalidateHostConnectionQueries(qc, action);
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}
