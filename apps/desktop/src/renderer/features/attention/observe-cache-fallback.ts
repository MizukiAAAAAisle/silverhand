import type { QueryClient } from '@tanstack/react-query';
import type { ObserveDto } from '@silverhand/shared';
import { invalidateMessageUnreadQueries } from '@/features/channels/message-unread';
import { favoritesKey } from '@/features/favorites/hooks';
import { eventWsClient, type WsClientStatus } from '@/lib/ws-client';

/**
 * `observe()` normally clears unread badges through the post-commit
 * `unread_updated` viewer-scope event. If the event websocket is currently not
 * connected, that patch cannot arrive, so reconcile the unread-bearing caches by
 * REST invalidation. The healthy websocket path remains the zero-refetch S1
 * projection.
 */
export function shouldRefetchUnreadAfterObserve(
  result: ObserveDto | undefined,
  status: WsClientStatus,
): boolean {
  return result?.changed === true && status !== 'connected';
}

export function reconcileUnreadAfterObserveIfRealtimeUnavailable(
  qc: QueryClient,
  result: ObserveDto | undefined,
  status: WsClientStatus = eventWsClient.getStatus(),
): boolean {
  if (!shouldRefetchUnreadAfterObserve(result, status)) return false;
  invalidateMessageUnreadQueries(qc);
  void qc.invalidateQueries({ queryKey: favoritesKey });
  return true;
}
