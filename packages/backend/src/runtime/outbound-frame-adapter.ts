import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import {
  HostWsCommandTransportError,
  type HostWsAttachment,
  type HostWsCommandTransportErrorCode,
  type HostWsServerController,
} from '../ws/host-ws-server.js';

/**
 * D5.a — the single backend-facing port for server→daemon outbound
 * frame traffic.
 *
 * Before D5.a the backend reached the daemon two different ways:
 *
 * - **standalone**: daemon opens an authenticated WSS to the backend;
 *   commands ride the outbound frame envelope through
 *   {@link HostWsServerController}.
 * - **embedded**: the backend held a `HostClient` and spoke a *local
 *   daemon RPC* protocol (`{ id, intent, params }`) over a Unix socket —
 *   a second expression of the same runtime semantics. That is the R4
 *   drift D5 closes.
 *
 * `OutboundFrameAdapter` is the contract both transports implement so
 * the backend dispatch path (`OutboundRuntimeEventFanout`, route
 * readiness checks, the D4.d `agent_materialize` flow) never branches on
 * deployment mode. The transport may differ (WSS vs local Unix socket);
 * the frame envelope, command schemas, error taxonomy, and backend
 * dispatch must not.
 *
 * The contract is intentionally the transport-neutral subset of
 * {@link HostWsServerController}: attachment liveness plus command send.
 * WS-only concerns — credential-revoke kick (`disconnectHost`) — stay on
 * the controller and are not part of the formal server↔daemon surface.
 *
 * D5.a-1 ships the interface, the standalone implementation
 * ({@link StandaloneOutboundFrameAdapter}), and the cross-impl contract
 * harness. The embedded local-Unix implementation lands in D5.a-2 and
 * must pass the same harness.
 */
export interface OutboundFrameAdapter {
  /**
   * Number of hosts with a live ATTACHMENT (0 or 1 in embedded) — never a raw
   * socket count. Since #task:1966 an authenticated-but-unadmitted dialer is
   * transport-internal on every implementation: standalone counts attachments
   * created by a compatible `ready`, and embedded has no separately-versioned
   * dialer to admit (the co-located daemon ships in the same binary), so its
   * socket IS the admitted edge.
   */
  activeConnectionCount(): number;
  /** Host ids with a live ATTACHMENT right now — same population as
   *  `activeConnectionCount()`, and the only meaning of "connected" this port
   *  exposes. */
  connectedHostIds(): string[];
  /**
   * Per-attachment id for `hostId`'s current USABLE generation, or `null` when
   * the host has no attachment (an authenticated dialer awaiting or failing
   * admission reads as `null`). A replacement attachment mints a new id, so
   * callers can compare ids across snapshots to detect a reattach (the same
   * reattach-race guard D4.d's `agent_materialize` dispatch relies on).
   */
  connectionIdForHost(hostId: string): string | null;
  /**
   * Snapshot of the current live ATTACHMENT for `hostId`, or `null` when the
   * host has none. Independent of any event-sink wiring. It tracks the
   * attachment lifecycle — NOT the underlying transport's: a socket that is
   * merely authenticated has no snapshot here, which is what makes a non-null
   * value a valid readiness signal in both modes.
   */
  getAttachment(hostId: string): HostWsAttachment | null;
  /**
   * Send one server→daemon command and await its correlated response.
   *
   * Transport failures reject with {@link OutboundFrameTransportError}
   * (the `transport_*` family). Daemon-returned command errors reject
   * with the per-command wire error, preserving its code (e.g. the D4.d
   * `agent_materialize` typed codes). `expectedConnectionId`, when given,
   * fails fast before dispatch if the live attachment has been replaced.
   */
  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>>;
  /**
   * Release adapter-owned transport resources. Implementations that only
   * *view* a transport owned elsewhere (e.g. the standalone adapter,
   * which projects a controller owned by the server bootstrap) treat this
   * as a no-op rather than double-closing.
   */
  close(): Promise<void>;
}

/**
 * Transport-neutral aliases for the outbound-frame transport error.
 *
 * The concrete class currently lives in `host-ws-server.ts` for historical
 * reasons (it predates the adapter split). Adapters and the contract
 * harness should reference these neutral names; a later slice may relocate
 * the class itself, but the public name callers depend on is stable here.
 */
export const OutboundFrameTransportError = HostWsCommandTransportError;
export type OutboundFrameTransportError = HostWsCommandTransportError;
export type OutboundFrameTransportErrorCode = HostWsCommandTransportErrorCode;

/**
 * Standalone implementation: a thin, behavior-preserving projection of a
 * live {@link HostWsServerController} onto the {@link OutboundFrameAdapter}
 * port.
 *
 * Holds an *accessor* rather than the controller directly because the
 * controller is constructed only after the HTTP server begins listening
 * and may legitimately be `null` before then (e.g. a route readiness
 * probe during boot). Read accessors degrade to "no connection" defaults
 * in that window; `sendCommand` rejects with `transport_no_connection`,
 * matching what the controller itself returns for an unconnected host.
 */
export class StandaloneOutboundFrameAdapter implements OutboundFrameAdapter {
  constructor(private readonly controller: () => HostWsServerController | null) {}

  activeConnectionCount(): number {
    return this.controller()?.activeConnectionCount() ?? 0;
  }

  connectedHostIds(): string[] {
    return this.controller()?.connectedHostIds() ?? [];
  }

  connectionIdForHost(hostId: string): string | null {
    return this.controller()?.connectionIdForHost(hostId) ?? null;
  }

  getAttachment(hostId: string): HostWsAttachment | null {
    return this.controller()?.getAttachment(hostId) ?? null;
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    const controller = this.controller();
    if (!controller) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_no_connection',
          `outbound frame adapter: host websocket server is not installed`,
          { hostId, commandKind: kind },
        ),
      );
    }
    return controller.sendCommand(hostId, kind, params, opts);
  }

  async close(): Promise<void> {
    // The controller's lifecycle is owned by the backend server bootstrap
    // (`installHostWebSocketServer` + shutdown). This adapter only *views*
    // it, so closing here would double-close the WS server. No-op by
    // design; ownership stays with the bootstrap.
  }
}

/**
 * Composite adapter for deployments that can have more than one outbound
 * transport live at the same time. Embedded desktop now has exactly this shape:
 * the app-managed default computer is reached through the local Unix adapter,
 * while user-managed computers launched by `silverhand-daemon connect` attach
 * to the same backend over WS. Callers must still see one
 * {@link OutboundFrameAdapter} port and route by host id, not by provisioning
 * source.
 */
export class CompositeOutboundFrameAdapter implements OutboundFrameAdapter {
  constructor(private readonly adapters: readonly OutboundFrameAdapter[]) {}

  activeConnectionCount(): number {
    return this.adapters.reduce(
      (count, adapter) => count + adapter.activeConnectionCount(),
      0,
    );
  }

  connectedHostIds(): string[] {
    return [...new Set(this.adapters.flatMap(adapter => adapter.connectedHostIds()))];
  }

  connectionIdForHost(hostId: string): string | null {
    return this.findLiveAdapter(hostId)?.connectionIdForHost(hostId) ?? null;
  }

  getAttachment(hostId: string): HostWsAttachment | null {
    return this.findLiveAdapter(hostId)?.getAttachment(hostId) ?? null;
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    const adapter = this.findLiveAdapter(hostId);
    if (!adapter) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_no_connection',
          `no outbound transport is connected for host ${hostId}`,
          { hostId, commandKind: kind },
        ),
      );
    }
    return adapter.sendCommand(hostId, kind, params, opts);
  }

  async close(): Promise<void> {
    await Promise.all(this.adapters.map(adapter => adapter.close()));
  }

  private findLiveAdapter(hostId: string): OutboundFrameAdapter | null {
    return this.adapters.find(adapter => adapter.connectionIdForHost(hostId) !== null) ?? null;
  }
}
