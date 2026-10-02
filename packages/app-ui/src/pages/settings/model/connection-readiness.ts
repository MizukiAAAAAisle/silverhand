import type { WsClientStatus } from "@/lib/ws-client";
import type { BackendInfoSnapshot } from "@/features/computers/hooks/hooks";
import type { LocalHostWsAttachment } from "@silverhand/client";

export type DesktopServerMode = "embedded" | "remote";

export type DesktopServerConnectionStatus = "connected" | "connecting" | "offline" | "unknown";

/**
 * The subset of `BackendInfoSnapshot.local_host_status` this projection
 * reads. Aliased type-only from the hooks module so a future enum
 * extension fails loud at every call site (which is what we want)
 * instead of silently drifting past a duplicated union.
 */
export type LocalHostStatus = BackendInfoSnapshot["local_host_status"];

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
  if (input.observation === null) return "unknown";
  const { attachment, localHostStatus } = input.observation;
  if (!attachment.observable) {
    switch (input.wsStatus) {
      case "connected":
        return "connected";
      case "connecting":
      case "authenticating":
        return "connecting";
      case "idle":
      case "disconnected":
        return "offline";
    }
  }
  if (localHostStatus !== "claimed") return "offline";
  return attachment.attached_at !== null ? "connected" : "connecting";
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
export function isDesktopServerReadyAfterSave(input: DesktopServerReadinessInput): boolean {
  if (input.savedAt === null) return false;
  if (input.observation === null) return false;
  const { attachment, localHostStatus } = input.observation;
  if (!attachment.observable) {
    return (
      input.wsStatus === "connected" &&
      input.wsConnectedAt !== null &&
      input.wsConnectedAt >= input.savedAt
    );
  }
  if (localHostStatus !== "claimed") return false;
  const attachedAt = attachment.attached_at;
  return attachedAt !== null && attachedAt >= input.savedAt;
}
