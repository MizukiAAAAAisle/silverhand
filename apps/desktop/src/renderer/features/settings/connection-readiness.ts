import type { WsClientStatus } from '@/lib/ws-client';
import type { BackendInfoSnapshot } from '@/features/hosts/hooks';

/**
 * Desktop→Server connection readiness — the derivation the
 * ConnectionPane consumes to decide (a) the persistent status pip,
 * and (b) whether a save-in-progress banner may be dismissed.
 *
 * The pane MUST NOT confuse local IPC freshness (a
 * `backendInfoQuery.dataUpdatedAt` bump) with real Desktop→Server
 * reachability — the local `backend:info` IPC always resolves regardless
 * of whether the (new) backend origin is reachable, so treating it as a
 * "ready" signal would silently dismiss the banner on a save-then-fail.
 *
 * The real signals differ by mode:
 *   - **remote**: the renderer's event WS re-dials the new backend after
 *     save (`eventWsClient.disconnect() + .connect()`). A `connected`
 *     status observed AFTER save started is authoritative — no live WS,
 *     no reachability.
 *   - **embedded**: the daemon's outbound WS re-attaches. The main-
 *     process-owned `local_host_ws_attached_at` on `BackendInfo` moves
 *     forward when that attach lands; while the (new) backend is
 *     unreachable it stays at its old value or NULL. This IS a real
 *     lifecycle timestamp — not the IPC's own freshness clock. It is
 *     paired with `local_host_status` because a stale `attachedAt` on a
 *     terminal-state row (`revoked`/`error`/`failed`) is NOT proof of
 *     reachability, and a pre-claim `unclaimed` row has no attach to
 *     wait for.
 *
 * Purely derivational so both signals + the falsifier are unit-testable
 * without React or WS wiring. Consumers (`ConnectionPane`) still owe
 * one thing this file cannot express: opting into
 * `useBackendInfoSnapshot({ pollWhileConnecting: true })` so that
 * `attachedAt`/`localHostStatus` actually re-enter React Query cache
 * during the connecting window. Without the poll opt-in the values
 * this projection reads never change, and a correct pure function
 * settles on a stale answer forever. That debt is **embedded-only**:
 * in remote mode the projection above reads only `wsStatus`, and the
 * hook deliberately refuses to poll (`#task:1628` — `attachedAt` never
 * moves there, so the poll would run forever and buy nothing).
 */
export type DesktopServerMode = 'embedded' | 'remote';

export type DesktopServerConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'offline';

/**
 * The subset of `BackendInfoSnapshot.local_host_status` this projection
 * reads. Aliased type-only from the hooks module so a future enum
 * extension fails loud at every call site (which is what we want)
 * instead of silently drifting past a duplicated union.
 */
export type LocalHostStatus = BackendInfoSnapshot['local_host_status'];

export interface DesktopServerReadinessInput {
  /** Deployment mode of the active backend. */
  mode: DesktopServerMode;
  /** `BackendInfo.local_host_ws_attached_at` — the daemon's last
   *  successful attach to the backend. NULL when the daemon has never
   *  attached in this session. Falsifier signal for embedded mode. */
  attachedAt: number | null;
  /** `BackendInfo.local_host_status`. Required for embedded proofs so
   *  a stale `attachedAt` on a terminal row does not read as connected,
   *  and a pre-claim row is not treated as an in-flight attach. */
  localHostStatus: LocalHostStatus;
  /** Renderer event WS status. Falsifier signal for remote mode
   *  (renderer transport IS Desktop→Server in remote deployments). */
  wsStatus: WsClientStatus;
  /** The last observed `wsStatus === 'connected'` transition timestamp,
   *  or NULL if the WS has never connected in this session. Consumers
   *  bump this on `onStatus` in `useEffect`; the pure function makes no
   *  assumption about how it is captured. */
  wsConnectedAt: number | null;
  /** Wall-clock at which the current save mutation was accepted, or
   *  NULL when no save is in progress. */
  savedAt: number | null;
}

/**
 * Steady-state Desktop→Server connection view for the persistent status
 * pip. Consumes the mode-specific truth source:
 *   - embedded: `local_host_status` + `attachedAt` together —
 *     `claimed + attachedAt` → connected; `claimed + null` → connecting
 *     (the daemon-outbound-attach window is real, so surfacing that
 *     mid-state is truthful); anything else (`unclaimed`, `revoked`,
 *     `error`, `failed`) → offline, even when `attachedAt` still holds
 *     a value from before the terminal transition.
 *   - remote: renderer event WS status.
 * Never claims `connected` without observation.
 */
export function desktopServerConnectionStatus(input: {
  mode: DesktopServerMode;
  attachedAt: number | null;
  localHostStatus: LocalHostStatus;
  wsStatus: WsClientStatus;
}): DesktopServerConnectionStatus {
  if (input.mode === 'remote') {
    switch (input.wsStatus) {
      case 'connected':
        return 'connected';
      case 'connecting':
      case 'authenticating':
        return 'connecting';
      case 'idle':
      case 'disconnected':
        return 'offline';
    }
  }
  if (input.localHostStatus !== 'claimed') return 'offline';
  return input.attachedAt !== null ? 'connected' : 'connecting';
}

/**
 * True iff we have an authoritative Desktop→Server proof observed
 * AFTER the current save started AND still holds right now. The banner
 * may be dismissed when this returns true; otherwise the banner MUST
 * remain so the user sees that the save's connectivity has not yet
 * been verified (or has since dropped).
 *
 * Returns false when no save is in progress (`savedAt === null`) —
 * there is nothing to dismiss.
 *
 * Remote proof requires BOTH the historical transition
 * (`wsConnectedAt >= savedAt`) AND the current-state gate
 * (`wsStatus === 'connected'`). A "was briefly connected then dropped"
 * WS is not proof of reachability — with only the historical check the
 * banner would clear while the pip flips back to Offline in the same
 * paint, which is worse than not clearing at all.
 *
 * Embedded proof additionally requires `localHostStatus === 'claimed'`
 * — a stale `attachedAt` sitting on a `revoked`/`error`/`failed` row
 * (or an `unclaimed` row that never attached) is not proof of
 * reachability for the freshly-saved URL.
 */
export function isDesktopServerReadyAfterSave(
  input: DesktopServerReadinessInput,
): boolean {
  if (input.savedAt === null) return false;
  if (input.mode === 'remote') {
    return (
      input.wsStatus === 'connected' &&
      input.wsConnectedAt !== null &&
      input.wsConnectedAt >= input.savedAt
    );
  }
  if (input.localHostStatus !== 'claimed') return false;
  return input.attachedAt !== null && input.attachedAt >= input.savedAt;
}
