import type { WsClientStatus } from '@/lib/ws-client';
import type { BackendInfoSnapshot } from '@/features/hosts/hooks';
import type { LocalHostWsAttachment } from '../../../preload/api';

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
 * The real signal differs by WHERE the attachment registry lives, which
 * `BackendInfo.local_host_ws_attachment` now states outright
 * (`#task:1630`) instead of leaving it to each consumer to remember:
 *   - **attachment not observable** (remote deployment): the renderer's
 *     event WS re-dials the new backend after save
 *     (`eventWsClient.disconnect() + .connect()`). A `connected` status
 *     observed AFTER save started is authoritative — no live WS, no
 *     reachability. The attach timestamp is unavailable here, not
 *     merely absent.
 *   - **attachment observable** (embedded deployment): the daemon's
 *     outbound WS re-attaches and `attached_at` moves forward when that
 *     lands; while the (new) backend is unreachable it stays at its old
 *     value or NULL. This IS a real lifecycle timestamp — not the IPC's
 *     own freshness clock. It is paired with `local_host_status` because
 *     a stale `attachedAt` on a terminal-state row
 *     (`revoked`/`error`/`failed`) is NOT proof of reachability, and a
 *     pre-claim `unclaimed` row has no attach to wait for.
 *   - **no snapshot at all** (query pending / `backend:info` answered
 *     `null` pre-bootstrap): neither of the above is knowable, so both
 *     projections answer with the absence — pip `unknown`, never ready.
 *     This third case is a query state, so it is represented by a NULL
 *     observation rather than by an arm of the domain type; inventing
 *     `{ observable: false }` for it silently hands authority to the
 *     renderer WS, which in embedded is a local socket that says
 *     `connected` immediately.
 *
 * Purely derivational so both signals + the falsifier are unit-testable
 * without React or WS wiring. Consumers (`ConnectionPane`) still owe
 * one thing this file cannot express: opting into
 * `useBackendInfoSnapshot({ pollWhileConnecting: true })` so that
 * `attached_at`/`localHostStatus` actually re-enter React Query cache
 * during the connecting window. Without the poll opt-in the values
 * this projection reads never change, and a correct pure function
 * settles on a stale answer forever. That debt exists only on the
 * observable arm: when the attachment is unobservable the projection
 * reads only `wsStatus`, and the hook deliberately refuses to poll
 * (`#task:1628` — `attached_at` never moves there, so the poll would run
 * forever and buy nothing).
 */
export type DesktopServerMode = 'embedded' | 'remote';

export type DesktopServerConnectionStatus =
  | 'connected'
  | 'connecting'
  | 'offline'
  /**
   * No `BackendInfo` observed yet (`#task:1630` forward fix). NOT a
   * connection state — the absence of one. The pane renders no status
   * word for it: "Connecting…" would be a claim about the daemon we
   * have not made, and "Offline" a claim about the server we cannot
   * make. See {@link DesktopServerObservation}.
   */
  | 'unknown';

/**
 * The subset of `BackendInfoSnapshot.local_host_status` this projection
 * reads. Aliased type-only from the hooks module so a future enum
 * extension fails loud at every call site (which is what we want)
 * instead of silently drifting past a duplicated union.
 */
export type LocalHostStatus = BackendInfoSnapshot['local_host_status'];

/**
 * The two `BackendInfo` facts these projections read, as ONE value —
 * because they are one observation. Passing them separately let a
 * consumer pair a real `localHostStatus` with an invented attachment
 * (`?? { observable: false }`), which reads as "this deployment cannot
 * observe attachments" rather than "we have not looked yet", and is the
 * defect Cindy + Norman caught in `e82f8a23`.
 *
 * `null` is the only representation of "no snapshot yet" — a query
 * state, deliberately unrepresentable inside the domain arms.
 */
export interface DesktopServerObservation {
  attachment: LocalHostWsAttachment;
  localHostStatus: LocalHostStatus;
}

export interface DesktopServerReadinessInput {
  /** `BackendInfo`'s attachment + local host status, or NULL when no
   *  snapshot has been observed yet. On the observable arm
   *  `localHostStatus` is what stops a stale `attached_at` on a terminal
   *  row from reading as connected; on the unobservable arm the renderer
   *  WS is the only authority (`#task:1630`). */
  observation: DesktopServerObservation | null;
  /** Renderer event WS status. Falsifier signal when the attachment is
   *  unobservable (renderer transport IS Desktop→Server in remote
   *  deployments). */
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
 * pip. Consumes whichever truth source actually exists here:
 *   - no observation yet: `unknown` — the pane shows no status word. An
 *     embedded first frame is the reason: with a fabricated
 *     `{ observable: false }` this function would trust the renderer WS,
 *     which in embedded talks to LOCAL main and reports `connected`
 *     within a tick, so the pip would read Connected and then walk
 *     BACKWARDS to Connecting… once the real snapshot landed.
 *   - attachment observable (embedded): `local_host_status` +
 *     `attached_at` together — `claimed + attached_at` → connected;
 *     `claimed + null` → connecting (the daemon-outbound-attach window is
 *     real, so surfacing that mid-state is truthful); anything else
 *     (`unclaimed`, `revoked`, `error`, `failed`) → offline, even when
 *     `attached_at` still holds a value from before the terminal
 *     transition.
 *   - attachment unobservable (remote): renderer event WS status — the
 *     attach timestamp is not merely absent here, it is unreadable, so
 *     reading it would answer "connecting" forever (`#task:1010`).
 * Never claims `connected` without observation.
 */
export function desktopServerConnectionStatus(input: {
  observation: DesktopServerObservation | null;
  wsStatus: WsClientStatus;
}): DesktopServerConnectionStatus {
  if (input.observation === null) return 'unknown';
  const { attachment, localHostStatus } = input.observation;
  if (!attachment.observable) {
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
  if (localHostStatus !== 'claimed') return 'offline';
  return attachment.attached_at !== null ? 'connected' : 'connecting';
}

/**
 * True iff we have an authoritative Desktop→Server proof observed
 * AFTER the current save started AND still holds right now. The banner
 * may be dismissed when this returns true; otherwise the banner MUST
 * remain so the user sees that the save's connectivity has not yet
 * been verified (or has since dropped).
 *
 * Returns false when no save is in progress (`savedAt === null`) —
 * there is nothing to dismiss. Also false when no snapshot has been
 * observed yet (`observation === null`): "we cannot see" is not proof.
 *
 * Remote proof (unobservable attachment) requires BOTH the historical
 * transition (`wsConnectedAt >= savedAt`) AND the current-state gate
 * (`wsStatus === 'connected'`). A "was briefly connected then dropped"
 * WS is not proof of reachability — with only the historical check the
 * banner would clear while the pip flips back to Offline in the same
 * paint, which is worse than not clearing at all.
 *
 * Embedded proof (observable attachment) additionally requires
 * `localHostStatus === 'claimed'` — a stale `attached_at` sitting on a
 * `revoked`/`error`/`failed` row (or an `unclaimed` row that never
 * attached) is not proof of reachability for the freshly-saved URL.
 */
export function isDesktopServerReadyAfterSave(
  input: DesktopServerReadinessInput,
): boolean {
  if (input.savedAt === null) return false;
  if (input.observation === null) return false;
  const { attachment, localHostStatus } = input.observation;
  if (!attachment.observable) {
    return (
      input.wsStatus === 'connected' &&
      input.wsConnectedAt !== null &&
      input.wsConnectedAt >= input.savedAt
    );
  }
  if (localHostStatus !== 'claimed') return false;
  const attachedAt = attachment.attached_at;
  return attachedAt !== null && attachedAt >= input.savedAt;
}
