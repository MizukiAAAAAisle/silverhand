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
 * Dispatch `host_status` to the owning daemon.
 *
 * Resolution rule (matches `resolveOutboundForHost`): when the adapter
 * is missing or has no live connection for `hostId`, the caller treats
 * the host as disconnected — NOT as a 503. The renderer wants to show
 * "device offline" with the persistent host fields (`display_label`,
 * `name`, `kind`) intact, not an error banner.
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
export async function dispatchHostStatus(
  adapter: OutboundFrameAdapter | null,
  hostId: string,
): Promise<HostStatusOutcome> {
  const connectionId = adapter?.connectionIdForHost(hostId) ?? null;
  if (!adapter || !connectionId) {
    return { kind: 'disconnected' };
  }
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
