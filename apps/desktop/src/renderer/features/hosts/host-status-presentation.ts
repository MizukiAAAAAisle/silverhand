/**
 * `#task:808` slice 4 — UI mapper for `HostStatusResponse` arms.
 *
 * Sibling to `connection-state.ts` but a deliberately separate file
 * because the source data is different: `connection-state.ts` works on
 * `BackendInfoSnapshot` (LOCAL host only, via the IPC backend-info
 * snapshot) and powers the Settings → Connection pane's pill;
 * `host-status-presentation.ts` works on the wire-shape
 * `HostStatusResponse` returned by `GET /api/hosts/:id/status` for ANY
 * host (forward-compatible with future remote hosts — shiki: "功能应是
 * hosts 主语的通用功能，不是 local only").
 *
 * Why a fresh mapper rather than collapsing both into one:
 *   - The two surfaces have different sources of truth. The local pane
 *     reads a privileged daemon-attachment snapshot the renderer always
 *     has; the per-host detail reads the public HTTP arm that any host
 *     could reasonably return. Merging would force one to fake fields
 *     it doesn't have, blurring the boundary.
 *   - The `availability` enum carries a `revoked` arm with no parallel
 *     in `local_host_status` (the local pane has `revoked` as a status
 *     value, but it's never accompanied by an `unreachable_reason`).
 *   - Forward compat: when remote-host support lands, the right pane
 *     will render every host through this mapper without any
 *     local/remote branching at the component layer.
 *
 * Tone keys stay aligned with `connection-state.ts` (`accent` /
 * `success` / `muted` / `warning` / `error`) so the same Tailwind
 * utilities (`text-success` etc.) work in both surfaces, and theme
 * tokens (warm-script.css / forza6.css) need no new definitions.
 */
import type {
  HostStatusResponse,
  HostUnreachableReason,
} from '@silverhand/shared';
import { computerCopy } from './computer-copy';

export type HostStatusTone =
  | 'accent'
  | 'success'
  | 'muted'
  | 'warning'
  | 'error';

export interface HostStatusView {
  /** Short product label rendered as a pill next to the host name.
   *  Speaks user terms ("Connected", "Offline", "Revoked") rather than
   *  daemon/RPC terms. */
  label: string;
  /** Optional secondary line — currently used to surface the typed
   *  `unreachable.reason` ("timed out", "couldn't reach the daemon")
   *  or the registration-only "(0 agents online)" string. `null` when
   *  not applicable. */
  detail: string | null;
  /** Token-key for the pill's border + text color. Matches
   *  `connection-state.ts` so consumers reuse the same `text-{tone}` /
   *  `border-{tone}` Tailwind utilities. */
  tone: HostStatusTone;
}

/**
 * Map an `unreachable.reason` to a user-readable secondary line.
 * Daemon-language reasons stay in the wire shape; the renderer never
 * displays them verbatim.
 */
export function describeUnreachableReason(
  reason: HostUnreachableReason,
): string {
  switch (reason) {
    case 'timeout':
      return 'The computer took too long to answer. Try refreshing.';
    case 'daemon_unreachable':
      return 'Could not reach this computer. Make sure it is connected.';
    case 'protocol_error':
      return 'This computer sent an unexpected response.';
    default: {
      // Exhaustive — adding a new reason on the schema side fails the
      // typecheck here loud-and-early rather than rendering an empty
      // detail line.
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

/**
 * Compute the pill view for a `HostStatusResponse`. The detail view
 * still renders `data.agents[]` and the snapshot card independently —
 * this function only describes the **availability** of the host as a
 * whole.
 */
export function describeHostStatus(
  status: HostStatusResponse,
): HostStatusView {
  switch (status.availability) {
    case 'available':
      return {
        label: computerCopy.availabilityConnected,
        detail: null,
        tone: 'success',
      };
    case 'disconnected':
      return {
        label: computerCopy.availabilityOffline,
        detail:
          'This computer is not connected right now. Registered agents are shown but cannot run.',
        tone: 'muted',
      };
    case 'unreachable':
      return {
        label: computerCopy.availabilityUnreachable,
        detail: describeUnreachableReason(status.reason),
        tone: 'warning',
      };
    case 'revoked':
      return {
        label: computerCopy.lifecycleRevoked,
        detail:
          'This computer has been revoked. Re-add it to use it again.',
        tone: 'muted',
      };
    default: {
      // Exhaustive over the discriminator — a new arm on the schema
      // fails the typecheck rather than silently falling through.
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/**
 * Pure helper: format an `uptime_ms` integer as a short string for the
 * snapshot card ("12s", "3m", "2h 14m", "5d 6h"). Always relative — the
 * detail view shows wall-clock `started_at` separately if needed.
 */
export function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes - hours * 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
