/**
 * #task:808 — backend dispatch layer for `host_status`.
 *
 * Sibling to `workspace-data-plane.ts` but kept as its own module because
 * `host_status` is NOT a workspace data-plane intent: it talks about the
 * host as a whole (OS / daemon version / active agent set) rather than
 * per-workspace path resolution. The outcome shape mirrors the data-plane
 * one but the failure taxonomy is much narrower — every failure here is a
 * transport-level liveness signal (the host isn't reachable, or the RPC
 * blew up). There are no daemon-business typed codes for this intent.
 *
 * Why the explicit narrow union rather than reusing `DataPlaneFailure`:
 * the route translates dispatch outcomes into the renderer-facing
 * `HostStatusResponse` discriminated union (`available` / `disconnected` /
 * `unreachable` / `revoked`), and `host_status` doesn't need any of the
 * data-plane's typed codes (`workspace_not_provisioned`, `invalid_path`,
 * etc.). Keeping a narrow `HostStatusFailureReason` enum here makes the
 * route's switch exhaustive and prevents an unrelated data-plane code
 * from accidentally surfacing on the ComputerPane wire.
 */
import type { HostStatusResult } from '@silverhand/host';
import type { HostUnreachableReason } from '@silverhand/shared';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';

const HOST_STATUS_TIMEOUT_MS = 10_000;

export type HostStatusOutcome =
  | { kind: 'ok'; result: HostStatusResult }
  | {
      kind: 'disconnected';
    }
  | {
      kind: 'unreachable';
      reason: HostUnreachableReason;
      message: string;
    };

/**
 * #task:1587 — single-flight dispatcher for `host_status`.
 *
 * A renderer-side refetch storm (poll × event invalidation, no client
 * coordination) can turn one host's status into hundreds of concurrent
 * identical RPCs against a single daemon — the 2026-07-21 incident put
 * 675 concurrent `host_status` on one connection, 627 of which burned
 * the full 10s timeout and 560 answered after their waiters were gone.
 * The daemon-facing fix is to admit at most ONE in-flight `host_status`
 * per (host, connection generation); every concurrent caller shares
 * that dispatch's outcome, success or failure.
 *
 * Generation binding is the correctness core, not an optimization:
 * the in-flight entry is keyed on the `connectionId` resolved at entry
 * creation, and that same id is pinned as `expectedConnectionId` on the
 * underlying send. A daemon reconnect mints a new connectionId, so
 * requests arriving after the flip key to a NEW entry (fresh RPC to the
 * new daemon), while the old entry's send fails fast on the id mismatch
 * and its waiters see a transport outcome — never data from a daemon
 * generation they didn't ask about.
 *
 * Outcome promises never reject (every failure is mapped into the
 * `HostStatusOutcome` union), so sharing one promise across waiters
 * cannot leak unhandled rejections. Entries are removed on settle
 * (identity-checked, so a slow settle can't evict a successor entry);
 * the map holds only genuinely in-flight work.
 */
export class HostStatusSingleFlight {
  private readonly inflight = new Map<string, Promise<HostStatusOutcome>>();

  dispatch(
    adapter: OutboundFrameAdapter | null,
    hostId: string,
  ): Promise<HostStatusOutcome> {
    const connectionId = adapter?.connectionIdForHost(hostId) ?? null;
    if (!adapter || !connectionId) {
      return Promise.resolve({ kind: 'disconnected' });
    }
    return this.dispatchKeyed(adapter, hostId, connectionId);
  }

  /**
   * Admission keyed on a caller-resolved connection generation. Callers
   * that cache the outcome per generation (the host-status read model)
   * MUST use this form: resolving the id here again could observe a
   * newer connection than the caller keyed on, and the shared outcome
   * would be filed under the wrong generation.
   */
  dispatchKeyed(
    adapter: OutboundFrameAdapter,
    hostId: string,
    connectionId: string,
  ): Promise<HostStatusOutcome> {
    const key = `${hostId}\u0000${connectionId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const entry = dispatchHostStatusToConnection(adapter, hostId, connectionId);
    this.inflight.set(key, entry);
    const cleanup = () => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    entry.then(cleanup, cleanup);
    return entry;
  }

  /** Test seam: number of in-flight entries (leak assertion). */
  inflightCount(): number {
    return this.inflight.size;
  }
}

/**
 * Dispatch one `host_status` RPC against a specific connection
 * generation and map every failure into the outcome union.
 *
 * `connectionId` is the generation the caller resolved (and keyed on)
 * BEFORE calling; it is pinned as `expectedConnectionId` so a
 * connection replaced between resolution and send fails fast instead
 * of silently answering from the new daemon.
 *
 * Transport errors map to the typed reasons the renderer can render:
 *   - `transport_no_connection` / `transport_disconnected` → `'disconnected'`
 *     outcome (no `reason`; UI renders "offline since last_seen_at")
 *   - `transport_timeout` → `'unreachable'` with `reason: 'timeout'`
 *   - other transport / response errors → `'unreachable'` with
 *     `reason: 'protocol_error'` or `'daemon_unreachable'`
 *
 * `host_status` declares no typed wire errors today — any
 * `HostWsCommandResponseError` we ever see here is generic
 * (`internal_error` / `unknown_intent` / etc.) and is treated as a
 * protocol-layer problem (the daemon answered but in a way the renderer
 * cannot interpret).
 */
async function dispatchHostStatusToConnection(
  adapter: OutboundFrameAdapter,
  hostId: string,
  connectionId: string,
): Promise<HostStatusOutcome> {
  try {
    const result = await adapter.sendCommand(hostId, 'host_status', {}, {
      timeoutMs: HOST_STATUS_TIMEOUT_MS,
      expectedConnectionId: connectionId,
    });
    return { kind: 'ok', result };
  } catch (err) {
    if (err instanceof HostWsCommandTransportError) {
      if (
        err.code === 'transport_no_connection' ||
        err.code === 'transport_disconnected'
      ) {
        return { kind: 'disconnected' };
      }
      if (err.code === 'transport_timeout') {
        return {
          kind: 'unreachable',
          reason: 'timeout',
          message: err.message,
        };
      }
      return {
        kind: 'unreachable',
        reason: 'daemon_unreachable',
        message: err.message,
      };
    }
    if (err instanceof HostWsCommandResponseError) {
      // Daemon answered with a generic transport-taxonomy error
      // (`internal_error` / `unknown_intent` / `invalid_params` / ...).
      // `host_status` declares no daemon-business typed codes, so any
      // typed code arriving here is itself a protocol drift — surface as
      // protocol_error so the renderer doesn't pretend it's a recoverable
      // transient.
      return {
        kind: 'unreachable',
        reason: 'protocol_error',
        message: err.message,
      };
    }
    return {
      kind: 'unreachable',
      reason: 'daemon_unreachable',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
