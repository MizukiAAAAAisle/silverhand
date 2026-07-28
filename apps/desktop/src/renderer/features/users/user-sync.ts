import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { UserChangedEventSchema, type ServerFrame } from '@silverhand/shared';
import { invalidateIdentityCarrierCaches } from '@/features/identity/identity-carrier-caches';
import { reseatViewerFromBackend } from '@/features/me/hooks';
import { getCurrentUserId } from '@/lib/current-user';
import { onWsFrame, subscribeWsScope } from '@/lib/ws-client';

/**
 * What an incoming WS frame means for the human-identity caches. The human
 * counterpart of {@link decideAgentSyncAction} — same app scope, same id-only
 * payload, same two triggers:
 *  - a valid app-scope `user_changed` event → reseat, and we know WHO changed;
 *  - an app-scope `snapshot_required` → this scope's stream is discontinuous
 *    (epoch mismatch / replay gap), so a `user_changed` we never saw may have
 *    been the viewer's own. `userId: null` means "unknown subject" and the
 *    consumer must assume the viewer was involved.
 *
 * Pure — exported for unit tests.
 */
export type UserSyncAction = {
  kind: 'invalidate';
  /** Whose profile changed; `null` when the signal is a replay recovery. */
  userId: string | null;
};

export function decideUserSyncAction(frame: ServerFrame): UserSyncAction | null {
  if (frame.type === 'snapshot_required') {
    return frame.scope === 'app' ? { kind: 'invalidate', userId: null } : null;
  }
  if (
    frame.type !== 'event' ||
    frame.scope !== 'app' ||
    frame.kind !== 'user_changed'
  ) {
    return null;
  }
  const parsed = UserChangedEventSchema.safeParse(frame.payload);
  return parsed.success
    ? { kind: 'invalidate', userId: parsed.data.user_id }
    : null;
}

/**
 * Decide whether a sync action has to re-read the viewer's own record.
 *
 * `['me']` is the one identity cache an invalidation cannot converge (see
 * {@link reseatViewerFromBackend}), so it gets a fetch instead — but only when
 * the change could be the viewer's: some other human renaming themselves must
 * not cost every client an extra `/api/me` round trip. A replay recovery
 * (`userId: null`) counts as "could be", because the frame we lost is exactly
 * the one that would have told us.
 *
 * Pure — exported for unit tests.
 */
export function userSyncTouchesViewer(
  action: UserSyncAction,
  viewerId: string | null,
): boolean {
  if (action.userId === null) return true;
  return viewerId !== null && action.userId === viewerId;
}

/**
 * Subscribe to the global `app` scope and reseat every cache that carries a
 * human's identity whenever the backend publishes `user_changed` (or a
 * `snapshot_required` recovery). **Mount ONCE in the app shell**, next to
 * {@link useAgentSync} — the two isomorphic actors propagate a profile edit the
 * same way and share one carrier registry, each under its own subject kind, so
 * a human avatar change never refetches host status or DM favorites.
 *
 * This is what makes a REMOTE edit visible: a profile changed on another
 * machine never touches this client's mutation caches, so before #task:1702 the
 * roster / directory / Activity / reaction / task copies of that human's name
 * and avatar sat stale until each surface happened to remount (global
 * `refetchOnWindowFocus` is off — `lib/queryClient.ts`).
 *
 * The event is an invalidation signal only; its payload carries no profile
 * fields, so nothing here patches a cache from the frame. Re-reading the
 * existing authorities is also what makes an avatar REPLACEMENT converge — the
 * refetched dto carries the bumped `?v=<updated_at>` cache-buster, so the blob
 * cache sees a new URL.
 */
export function useUserSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const sub = subscribeWsScope('app');
    const unsub = onWsFrame(frame => {
      const action = decideUserSyncAction(frame);
      if (!action) return;
      invalidateIdentityCarrierCaches(qc, 'human');
      if (userSyncTouchesViewer(action, getCurrentUserId())) {
        void reseatViewerFromBackend(qc);
      }
    });
    return () => {
      sub.unsubscribe();
      unsub();
    };
  }, [qc]);
}
