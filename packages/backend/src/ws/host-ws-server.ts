import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  OUTBOUND_PROTOCOL_VERSION,
  encodeOutboundFrame,
  type OutboundFrame,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundHeartbeatFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type ResponseError,
} from '@silverhand/host';
import {
  HOST_CONNECTION_CHANGED_EVENT,
  HOST_WS_CLOSE_REASON_DISCONNECTED,
  HOST_WS_CLOSE_REASON_REVOKED,
  HOST_WS_CLOSE_REASON_UPDATE_REQUIRED,
  apiPaths,
  type HostConnectionChangedEvent,
} from '@silverhand/shared';
import { HostTokenService } from '../auth/host-token.js';
import type { BackendContext, BackendDeploymentMode } from '../context.js';
import { HostRepo } from '../repos/host-repo.js';

export const HOST_WS_PATH = apiPaths.hostConnect;

export interface HostWsServerOptions {
  path?: string;
  maxPayloadBytes?: number;
  shutdownGraceMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  commandTimeoutMs?: number;
  eventSink?: HostWsEventSink;
}

export interface HostWsAttachment {
  /** Host id for the live outbound websocket connection. */
  hostId: string;
  /** Per-connection id minted by the server on upgrade. Stable for the
   *  life of one websocket; a replacement connection mints a new one.
   *  Use to distinguish stale vs fresh attachments. */
  connectionId: string;
  /** Epoch ms when the daemon's COMPATIBLE `ready` frame landed and the host
   *  was registered (#task:1966 — not the raw upgrade). This is "post-auth,
   *  post-compatibility, post-registration" so callers can rely on the
   *  attachment being usable (sendCommand will find the connection)
   *  the moment they observe a non-null snapshot. */
  attachedAt: number;
  /** Diagnostic-only daemon-reported name from the ready event. Never used for
   *  identity, routing, or dedupe. */
  hostname: string | null;
  /**
   * Feature capabilities the daemon advertised in its `ready`/hello frame
   * (#task:1486). Belongs to THIS live connection generation only — a
   * replacement connection re-reports its own, and disconnect drops the whole
   * record, so a stale binary's capabilities can never be reused. Populated in
   * the same tick the attachment is created, because the attachment IS the
   * `ready` frame's effect (#task:1966). Consumers treat an unknown token as
   * absent; `runtime.codex.reasoning.v1` here is what lets the backend send a
   * non-baseline reasoning token to this daemon.
   */
  capabilities: readonly string[];
}

/**
 * #task:1631 — why the LAST authenticated connection attempt for a host was
 * refused, when it was refused for a reason the daemon cannot recover from by
 * retrying. This is **not** a fifth `availability` value and **not** a second
 * liveness source. The host is plainly `disconnected`; this record only answers
 * the follow-up question "is that offline state self-healing?".
 *
 * Recorded only **after** host-token authentication succeeded, so it can never
 * be attributed to an unrelated or hostile dialer. Cleared when the host next
 * sends a valid `ready` frame — presence therefore means "still unresolved",
 * and a stale daemon that reconnect-loops keeps the record continuously set
 * instead of flickering once per attempt.
 */
export interface HostWsAdmissionFailure {
  kind: 'protocol_mismatch';
  /**
   * The connection generation that was refused. Compared INSIDE the controller
   * against the private transport slot (#task:1966): while the refused socket
   * still holds the slot the refusal explains this host's state, and once a
   * different dialer has taken it the record is withheld because that daemon may
   * be a fixed one that has simply not handshaken yet. Consumers therefore never
   * compare generations themselves — `getAdmissionFailure` already returns
   * `null` in the second case.
   */
  connectionId: string;
  /** Wire protocol version the daemon offered in its `ready` frame. */
  offeredProtocolVersion: number;
  /** Version this server accepts (`OUTBOUND_PROTOCOL_VERSION`). */
  expectedProtocolVersion: number;
  /** Epoch ms of the refused attempt. */
  observedAt: number;
}

export interface HostWsServerController {
  activeConnectionCount(): number;
  /** Hosts with a live ATTACHMENT — i.e. a connection that passed the
   *  compatibility gate by sending a valid `ready` (#task:1966). A daemon whose
   *  handshake is being refused holds a transport slot (`connectionIdForHost`)
   *  but is deliberately absent here: broadcasting to it is undeliverable work,
   *  and counting it as connected is what turned a refusal loop into fleet-wide
   *  business traffic. */
  connectedHostIds(): string[];
  /**
   * The live ATTACHMENT generation for `hostId`, or `null` when this host has no
   * attachment (#task:1966). Consumers — `OutboundFrameAdapter`,
   * `CompositeOutboundFrameAdapter.findLiveAdapter`, the host-status read model,
   * `create-agent`, the workspace data plane — all read a non-null value as "a
   * usable generation", so it must never name a socket that is merely
   * authenticated: the raw transport slot is private to this module.
   */
  connectionIdForHost(hostId: string): string | null;
  /**
   * The most recent UNRESOLVED admission failure for `hostId`, or `null` when
   * the last authenticated attempt was not refused for a known terminal reason
   * (the ordinary-offline case). Already discriminated against the refused
   * generation: a record whose socket has since been replaced by a different
   * dialer reads as `null`, so callers never have to time the read or compare
   * generations themselves. Memory-only and process-local, like `getAttachment`
   * — a server restart forgets it and the next connection attempt
   * re-establishes the fact.
   */
  getAdmissionFailure(hostId: string): HostWsAdmissionFailure | null;
  /**
   * Returns a snapshot of the currently-active outbound websocket
   * attachment for `hostId`, or `null` when no live connection exists.
   *
   * **Independent of `eventSink`**: this registry tracks the websocket's
   * ATTACHMENT lifecycle — created when the daemon's compatible `ready` frame
   * lands, cleared on connection close — regardless of whether an `eventSink` is
   * wired. That is what makes it the correct readiness signal when event
   * projection is intentionally ignored for the co-located embedded local host:
   * the `ready` FRAME still arrives on the host-ws for that host, only its
   * business events are ignored.
   *
   * **Replacement-safe**: when a new connection replaces an existing
   * one for the same host, the previous connection's `close` cleanup
   * compares its captured `connectionId` against the current registry
   * entry and skips deletion if a fresh connection has already taken
   * the slot. Callers can compare `connectionId` between snapshots to
   * detect a reattach.
   */
  getAttachment(hostId: string): HostWsAttachment | null;
  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>>;
  /**
   * Close the live outbound websocket for `hostId`. Returns `true` when a live
   * transport connection existed and was kicked, `false` when none was
   * registered (idempotent).
   *
   * Deliberately the one PUBLIC method that reads the raw transport slot rather
   * than the attachment (#task:1966): a revoke or an availability kick must also
   * be able to close a socket whose handshake is still unresolved — that socket
   * holds the host's slot and, left alone, would keep dialing on a credential the
   * user just withdrew. It grants no data-plane reachability, so it cannot
   * reintroduce the pre-`ready` "online" window the other readers close.
   *
   * `HOST_WS_CLOSE_REASON_REVOKED` is used after credentials are revoked.
   * `HOST_WS_CLOSE_REASON_DISCONNECTED` is an availability-axis kick that
   * preserves credentials; the daemon treats both reasons as terminal for the
   * current config so it does not immediately reconnect with the same token.
   */
  disconnectHost(hostId: string, reason?: HostWsDisconnectReason): boolean;
  close(): Promise<void>;
}

export type HostWsDisconnectReason =
  | typeof HOST_WS_CLOSE_REASON_REVOKED
  | typeof HOST_WS_CLOSE_REASON_DISCONNECTED;

export interface HostWsEventSink {
  onEvent(
    hostId: string,
    event: OutboundDaemonToServerEventFrame,
    connectionId: string,
  ): void;
  onDisconnect?(hostId: string, connectionId: string): void;
}

interface AuthenticatedHost {
  hostId: string;
  userId: string;
  credentialId: string;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export type HostWsCommandTransportErrorCode =
  | 'transport_no_connection'
  | 'transport_timeout'
  | 'transport_disconnected'
  | 'transport_send_failed'
  | 'transport_invalid_command'
  | 'transport_response_mismatch';

export class HostWsCommandTransportError extends Error {
  constructor(
    readonly code: HostWsCommandTransportErrorCode,
    message: string,
    readonly details: {
      hostId: string;
      commandKind?: OutboundServerCommandKind;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = 'HostWsCommandTransportError';
  }
}

export class HostWsCommandResponseError extends Error {
  constructor(
    readonly code: ResponseError['code'],
    message: string,
    readonly details: {
      hostId: string;
      commandKind: OutboundServerCommandKind;
      requestId: string;
    },
  ) {
    super(message);
    this.name = 'HostWsCommandResponseError';
  }
}

export function installHostWebSocketServer(
  server: HttpServer,
  ctx: BackendContext,
  opts: HostWsServerOptions = {},
): HostWsServerController {
  const path = opts.path ?? HOST_WS_PATH;
  const shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
  const connections = new Map<WebSocket, HostWsConnection>();
  // TRANSPORT slot map: one raw authenticated socket per host, taken at upgrade.
  // PRIVATE to this module — its only readers are the 409 slot conflict, the
  // revoke / disconnect kick, the admission-failure generation compare, and
  // `sendCommand`'s liveness check against the attachment. It is never exposed as
  // a business generation: "authenticated" is not "admitted" (#task:1966).
  const connectionsByHost = new Map<string, HostWsConnection>();
  // ATTACHMENT registry — the business fact "this host is connected", and the one
  // state every public reader resolves through. Intentionally independent of
  // `opts.eventSink`: the co-located embedded local host projects runtime EVENTS
  // over the Unix-socket transport, so attachment must not be a function of the
  // `eventSink` pipeline — but the `ready` FRAME itself does arrive on this
  // websocket for that host too, which is why gating on it is safe there.
  //
  // #task:1966 — an entry is created when the daemon's COMPATIBLE `ready` frame
  // lands, not on upgrade, and cleared in the `close` listener only when the
  // captured `connectionId` is still the registered one (replacement-safe). Raw
  // socket open/close is transport-internal: a daemon whose handshake is refused
  // never becomes an attachment, so it never moves `markActivated`, never
  // publishes `host_connection_changed`, and never appears in
  // `connectedHostIds()`.
  const attachmentsByHost = new Map<string, HostWsAttachment>();
  // #task:1631 — outlives the connection it describes on purpose: the whole
  // point is to explain an offline host, which by definition has no live
  // connection left to carry the reason. Keyed by host (not connection) and
  // cleared only by a valid `ready`, so a stale daemon reconnect-loop keeps it
  // continuously set rather than clearing it once per attempt.
  const admissionFailuresByHost = new Map<string, HostWsAdmissionFailure>();
  const commandIdPrefix = `hostws-${randomUUID()}`;
  let commandSeq = 0;
  let connectionSeq = 0;
  let closing = false;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = requestPathname(req);
    if (pathname !== path) return;
    ctx.metrics?.observeHostWsConnection('upgrade', 'attempt');
    if (!isWebSocketUpgrade(req)) {
      ctx.metrics?.observeHostWsConnection('upgrade', 'invalid_upgrade');
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (closing) {
      ctx.metrics?.observeHostWsConnection('upgrade', 'server_closing');
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const auth = authenticateHost(req, ctx);
    if (!auth.ok) {
      ctx.metrics?.observeHostWsConnection(
        'upgrade',
        `auth_${auth.statusCode}`,
      );
      rejectUpgrade(socket, auth.statusCode, auth.reason);
      return;
    }
    // One transport slot per host. The slot — not the attachment — is the
    // conflict authority (#task:1966): a second dialer must be refused while the
    // first socket is still alive, including while its handshake is still
    // unresolved. This is byte-for-byte the state the pre-#1966 check read, since
    // back then the attachment was created in this very handler.
    const existingConnection = connectionsByHost.get(auth.host.hostId);
    if (existingConnection) {
      ctx.metrics?.observeHostWsConnection('upgrade', 'already_connected');
      rejectUpgrade(socket, 409, 'Conflict', {
        error: 'computer already connected',
        error_code: 'computer_already_connected',
        connected_host_name:
          attachmentsByHost.get(auth.host.hostId)?.hostname ?? null,
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      ctx.metrics?.observeHostWsConnection('upgrade', 'accepted');
      ctx.metrics?.changeHostWsConnections('websocket_open', 1);
      const connectionId = `${commandIdPrefix}-conn-${++connectionSeq}`;
      const connection = new HostWsConnection(ws, ctx, auth.host, {
        connectionId,
        pingIntervalMs: opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
        pongTimeoutMs: opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
        commandTimeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        nextCommandId: () => `${commandIdPrefix}-${++commandSeq}`,
        eventSink: opts.eventSink,
        deploymentMode: ctx.deploymentMode,
        updateAttachmentReady: (hostname, capabilities) => {
          // #task:1966 — the compatibility gate's one write. A valid `ready` is
          // what CREATES the attachment (and only then announces the change); a
          // repeat `ready` on the same connection just refreshes the reported
          // facts, so the viewer event does not fire twice for one generation.
          const current = attachmentsByHost.get(auth.host.hostId);
          if (current) {
            if (current.connectionId !== connectionId) return;
            attachmentsByHost.set(auth.host.hostId, {
              ...current,
              hostname,
              capabilities,
            });
            return;
          }
          // `attachedAt` is captured here (not from any DB column) so phase-2
          // boot watchdogs can use it as the `expectAttachSince` lower bound
          // without coordinating with `hosts.last_seen_at` clock drift.
          const attachedAt = Date.now();
          attachmentsByHost.set(auth.host.hostId, {
            hostId: auth.host.hostId,
            connectionId,
            attachedAt,
            hostname,
            capabilities,
          });
          publishHostConnectionChanged(ctx, auth.host.userId, {
            host_id: auth.host.hostId,
          });
        },
        recordAdmissionFailure: failure => {
          // #task:1966 — the refusal no longer rides on an attachment edge (a
          // never-attached connection has none), so the ONE state transition
          // "this host's offline state just became non-self-healing" is announced
          // here, once. Announcing it is what keeps `/api/hosts/:id/status`'s
          // terminal `admission_failure` a PUSH: without it the human would wait
          // for the next unrelated invalidation, and #task:1631's precise "update
          // Silverhand on this computer" copy would sit behind a generic Offline.
          //
          // Deduped on `previous`, not on a timer: the record is cleared only by
          // a valid `ready`, so a reconnect loop finds it already set and stays
          // silent — one event per unresolved episode per host, whatever the
          // daemon does. No attachment check is needed: the 409 slot conflict
          // admits one socket per host at a time and the `close` listener drops
          // the slot and the attachment in the same tick, so a host cannot hold a
          // live attachment while a refusal is being recorded.
          const previous = admissionFailuresByHost.get(auth.host.hostId);
          admissionFailuresByHost.set(auth.host.hostId, failure);
          if (previous) return;
          publishHostConnectionChanged(ctx, auth.host.userId, {
            host_id: auth.host.hostId,
          });
        },
        clearAdmissionFailure: () => {
          admissionFailuresByHost.delete(auth.host.hostId);
        },
      });
      connections.set(ws, connection);
      connectionsByHost.set(auth.host.hostId, connection);
      // `markActivated` stays HERE, on the authenticated upgrade (#task:1966
      // deliberately did NOT move it). It stamps the LIFECYCLE axis — "a machine
      // holding this credential reached us", which is what flips a draft
      // `pending → attached` and what `last_seen_at` means — and
      // `docs/user-managed-computer-v1.md` already forbids reading it as
      // readiness (the live gate is the attachment). Gating it on `ready` would
      // strand the Add-computer dialog on "waiting for connection" for exactly
      // the incompatible daemon whose terminal reason we want the user to read.
      new HostRepo(ctx.db).markActivated(auth.host.hostId);
      // No attachment and no `host_connection_changed` here: the upgrade proves
      // the CREDENTIAL, not that this daemon speaks our protocol. Everything on
      // the SESSION axis waits for the compatibility gate in
      // `updateAttachmentReady`, which is also why the announcement can no longer
      // race ahead of `capabilities`.
      ws.on('close', (code, reason) => {
        ctx.metrics?.changeHostWsConnections('websocket_open', -1);
        ctx.metrics?.observeHostWsClose(
          code,
          classifyHostWsCloseReason(code, reason),
        );
        connections.delete(ws);
        if (connectionsByHost.get(auth.host.hostId) === connection) {
          connectionsByHost.delete(auth.host.hostId);
        }
        // Replacement-safe: only clear if the registered attachment is
        // the one this `close` belongs to. When a new connection has
        // already overwritten the slot, the stale `close` is a no-op.
        // A refused handshake never created one, so a mismatch loop publishes
        // nothing on either edge (#task:1966).
        const current = attachmentsByHost.get(auth.host.hostId);
        if (current && current.connectionId === connectionId) {
          attachmentsByHost.delete(auth.host.hostId);
          publishHostConnectionChanged(ctx, auth.host.userId, {
            host_id: auth.host.hostId,
          });
        }
      });
      wss.emit('connection', ws, req);
      connection.start();
    });
  };

  server.on('upgrade', onUpgrade);

  return {
    activeConnectionCount: () => connections.size,
    connectedHostIds: () => [...attachmentsByHost.keys()],
    // Every business reader below resolves through the ATTACHMENT registry, so a
    // socket that is authenticated but has not passed the compatibility gate is
    // invisible to the runtime data plane (#task:1966, @Cindy MUST FIX): the
    // generation token, the readiness snapshot and the command path must agree,
    // otherwise `connectionIdForHost != null` would license `agent_materialize`
    // and runtime commands into a socket the server is about to refuse.
    connectionIdForHost: hostId =>
      attachmentsByHost.get(hostId)?.connectionId ?? null,
    getAttachment: hostId => attachmentsByHost.get(hostId) ?? null,
    getAdmissionFailure: hostId => {
      const failure = admissionFailuresByHost.get(hostId);
      if (!failure) return null;
      // The refused-generation discrimination (#task:1631) lives HERE, on the
      // private transport slot, because it is a question about admission and not
      // about readiness: "has a DIFFERENT socket since taken the slot?" A public
      // readiness accessor cannot answer it — under the compatibility gate a
      // mid-handshake replacement is deliberately not an attachment yet, so
      // asking `connectionIdForHost` would report the stale refusal as this
      // host's state for the whole handshake window.
      const slot = connectionsByHost.get(hostId);
      if (slot && slot.connectionId !== failure.connectionId) return null;
      return failure;
    },
    sendCommand: (hostId, kind, params, commandOpts) => {
      const startedAt = performance.now();
      const attachment = attachmentsByHost.get(hostId);
      const slot = attachment ? connectionsByHost.get(hostId) : undefined;
      // Not "is there a socket" but "is there a socket this server has agreed to
      // speak to". A pre-`ready` or refused generation is reported as
      // `transport_no_connection` — the same fail-fast the callers already
      // handle — rather than being written to and silently dropped on close.
      const connection =
        attachment && slot && slot.connectionId === attachment.connectionId
          ? slot
          : undefined;
      if (!connection) {
        return observeDaemonCommand(
          ctx,
          kind,
          startedAt,
          Promise.reject(
            new HostWsCommandTransportError(
              'transport_no_connection',
              `host ${hostId} is not connected to outbound websocket`,
              { hostId, commandKind: kind },
            ),
          ),
        );
      }
      if (
        commandOpts?.expectedConnectionId &&
        connection.connectionId !== commandOpts.expectedConnectionId
      ) {
        return observeDaemonCommand(
          ctx,
          kind,
          startedAt,
          Promise.reject(
            new HostWsCommandTransportError(
              'transport_disconnected',
              `host ${hostId} websocket connection changed before ${kind}`,
              {
                hostId,
                commandKind: kind,
              },
            ),
          ),
        );
      }
      return observeDaemonCommand(
        ctx,
        kind,
        startedAt,
        connection.sendCommand(kind, params, commandOpts),
      );
    },
    disconnectHost: (hostId, reason = HOST_WS_CLOSE_REASON_REVOKED) => {
      const connection = connectionsByHost.get(hostId);
      if (!connection) return false;
      if (reason === HOST_WS_CLOSE_REASON_DISCONNECTED) {
        connection.closeForDisconnect();
      } else {
        connection.closeForRevoke();
      }
      // The `close` listener registered in the upgrade
      // handler will clean `connectionsByHost` and
      // `attachmentsByHost` on the same tick the underlying
      // socket fires its close event. We do NOT pre-clean here
      // because that would race with the per-connection
      // bookkeeping (which compares connectionId against the
      // current registry entry to stay replacement-safe).
      return true;
    },
    close: async () => {
      if (closing) return;
      closing = true;
      server.off('upgrade', onUpgrade);

      const closeWaits = [...connections.entries()].map(([ws, connection]) => {
        connection.closeForShutdown();
        return waitForClose(ws);
      });

      const terminateAfterGrace = delay(shutdownGraceMs).then(() => {
        for (const connection of connections.values()) {
          connection.terminate();
        }
      });
      await Promise.race([Promise.allSettled(closeWaits), terminateAfterGrace]);
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}

function publishHostConnectionChanged(
  ctx: BackendContext,
  ownerUserId: string,
  payload: HostConnectionChangedEvent,
): void {
  ctx.events.publishToScope(
    `viewer:${ownerUserId}`,
    HOST_CONNECTION_CHANGED_EVENT,
    payload,
  );
}

interface PendingCommand {
  id: string;
  kind: OutboundServerCommandKind;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class HostWsConnection {
  readonly connectionId: string;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly nextCommandId: () => string;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private cleanedUp = false;
  private readyProtocolVersion: string | null = null;
  private loggedNoEventSink = false;
  private readonly deploymentMode: BackendDeploymentMode;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: BackendContext,
    private readonly host: AuthenticatedHost,
    opts: {
      connectionId: string;
      pingIntervalMs: number;
      pongTimeoutMs: number;
      commandTimeoutMs: number;
      nextCommandId: () => string;
      eventSink?: HostWsEventSink;
      deploymentMode: BackendDeploymentMode;
      updateAttachmentReady: (
        hostname: string,
        capabilities: readonly string[],
      ) => void;
      recordAdmissionFailure: (failure: HostWsAdmissionFailure) => void;
      clearAdmissionFailure: () => void;
    },
  ) {
    this.connectionId = opts.connectionId;
    this.pingIntervalMs = opts.pingIntervalMs;
    this.pongTimeoutMs = opts.pongTimeoutMs;
    this.commandTimeoutMs = opts.commandTimeoutMs;
    this.nextCommandId = opts.nextCommandId;
    this.eventSink = opts.eventSink;
    this.deploymentMode = opts.deploymentMode;
    this.updateAttachmentReady = opts.updateAttachmentReady;
    this.recordAdmissionFailure = opts.recordAdmissionFailure;
    this.clearAdmissionFailure = opts.clearAdmissionFailure;
  }

  private readonly eventSink?: HostWsEventSink;
  private readonly recordAdmissionFailure: (
    failure: HostWsAdmissionFailure,
  ) => void;
  private readonly clearAdmissionFailure: () => void;
  private readonly updateAttachmentReady: (
    hostname: string,
    capabilities: readonly string[],
  ) => void;

  start(): void {
    this.ws.on('message', data => this.handleMessage(data));
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', err => {
      this.ctx.logger.warn(
        { err, hostId: this.host.hostId },
        'host-ws: connection error',
      );
      this.cleanup();
    });
    this.ctx.logger.info(
      {
        hostId: this.host.hostId,
        userId: this.host.userId,
        credentialId: this.host.credentialId,
      },
      'host-ws: connected',
    );
    this.startHeartbeat();
  }

  closeForShutdown(): void {
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1001, 'server_shutdown');
    }
  }

  closeForReplacement(): void {
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket was replaced`,
    );
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1000, 'host_connection_replaced');
    }
  }

  /**
   * D4.c C2 — close the websocket because the host's credentials
   * were revoked. Uses RFC 6455 close code `1008` (Policy
   * Violation) with reason `host_revoked`. The credential is
   * already revoked at the DB layer when this fires, and the
   * daemon's current outbound client (`packages/host/src/daemon/
   * outbound-client.ts:349`) reconnects on every close code; the
   * reconnect attempt is rejected at upgrade-auth because the
   * token verifier no longer accepts the revoked credential. The
   * `1008/host_revoked` close-frame is therefore a forward-looking
   * label so a future daemon close-handler can branch on this
   * code to suppress reconnect (D3.e / D4.d follow-up). What this
   * call buys today is **immediate disconnect** — the renderer's
   * BackendInfo flips on the next attachment heartbeat instead of
   * waiting for the daemon to lose its current socket on its own.
   */
  closeForRevoke(): void {
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket was closed because credentials were revoked`,
    );
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1008, HOST_WS_CLOSE_REASON_REVOKED);
    }
  }

  /**
   * Availability-axis disconnect: the server intentionally releases the current
   * live attachment while keeping credentials valid. The daemon must not
   * immediately reconnect with the same config, but a later manual command or a
   * changed app-managed config may reconnect.
   */
  closeForDisconnect(): void {
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket was disconnected by server request`,
    );
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1000, HOST_WS_CLOSE_REASON_DISCONNECTED);
    }
  }

  terminate(): void {
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket was terminated`,
    );
    this.cleanup();
    if (this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.terminate();
    }
  }

  sendCommand<K extends OutboundServerCommandKind>(
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number },
  ): Promise<OutboundServerCommandResult<K>> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_disconnected',
          `host ${this.host.hostId} websocket is not open`,
          { hostId: this.host.hostId, commandKind: kind },
        ),
      );
    }
    const id = this.nextCommandId();
    const frame = {
      direction: 'server_to_daemon',
      type: 'command',
      id,
      kind,
      params,
    };
    const parsed = OutboundServerToDaemonCommandFrameSchema.safeParse(frame);
    if (!parsed.success) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_invalid_command',
          `invalid outbound command ${kind}: ${parsed.error.errors
            .map(e => e.path.join('.'))
            .join(', ')}`,
          { hostId: this.host.hostId, commandKind: kind, requestId: id },
        ),
      );
    }
    let encoded: string;
    try {
      encoded = encodeOutboundFrame(parsed.data);
    } catch (err) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_invalid_command',
          (err as Error).message,
          {
            hostId: this.host.hostId,
            commandKind: kind,
            requestId: id,
          },
        ),
      );
    }

    return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.commandTimeoutMs;
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(
          new HostWsCommandTransportError(
            'transport_timeout',
            `outbound command ${kind} timed out after ${timeoutMs}ms`,
            { hostId: this.host.hostId, commandKind: kind, requestId: id },
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pendingCommands.set(id, {
        id,
        kind,
        timer,
        resolve: value => resolve(value as OutboundServerCommandResult<K>),
        reject,
      });
      try {
        this.ws.send(encoded, err => {
          if (!err) return;
          const pending = this.pendingCommands.get(id);
          if (!pending) return;
          this.pendingCommands.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new HostWsCommandTransportError(
              'transport_send_failed',
              err.message,
              {
                hostId: this.host.hostId,
                commandKind: kind,
                requestId: id,
              },
            ),
          );
        });
      } catch (err) {
        const pending = this.pendingCommands.get(id);
        if (!pending) return;
        this.pendingCommands.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new HostWsCommandTransportError(
            'transport_send_failed',
            (err as Error).message,
            {
              hostId: this.host.hostId,
              commandKind: kind,
              requestId: id,
            },
          ),
        );
      }
    });
  }

  private handleMessage(data: RawData): void {
    if (this.cleanedUp) return;
    const frame = parseJsonFrame(data);
    if (!frame) {
      this.closeWithProtocolError('frame must be a JSON object');
      return;
    }

    const offeredProtocolVersion = readyFrameProtocolVersion(frame);
    if (
      offeredProtocolVersion !== null &&
      offeredProtocolVersion !== String(OUTBOUND_PROTOCOL_VERSION)
    ) {
      this.ctx.metrics?.observeHostWsProtocolMismatch(
        offeredProtocolVersion,
        String(OUTBOUND_PROTOCOL_VERSION),
      );
      // #task:1631 — the metric is fleet-wide; this records the same refusal
      // per-host so the offline Computer can say WHY it will stay offline.
      // Only a well-formed-but-wrong version qualifies: `'invalid'` means the
      // frame wasn't a readable `ready` at all, which is a corrupt-dialer
      // signal, not an actionable "upgrade your daemon" fact.
      //
      // #task:1966 changed how the human learns it, not whether: the refusal has
      // no attachment edge to announce, so the FIRST record for a host publishes
      // `host_connection_changed` on its own (see `recordAdmissionFailure` in the
      // registry) and the reconnect loop behind it publishes nothing. Recorded
      // BEFORE the close on purpose — it is the only data source for the terminal
      // "update Silverhand on this computer" copy, and it outlives the connection
      // so the read does not have to be timed.
      const offered = Number(offeredProtocolVersion);
      if (Number.isSafeInteger(offered)) {
        this.recordAdmissionFailure({
          kind: 'protocol_mismatch',
          connectionId: this.connectionId,
          offeredProtocolVersion: offered,
          expectedProtocolVersion: OUTBOUND_PROTOCOL_VERSION,
          observedAt: Date.now(),
        });
        this.ctx.logger.warn(
          {
            hostId: this.host.hostId,
            connectionId: this.connectionId,
            offeredProtocolVersion: offered,
            expectedProtocolVersion: OUTBOUND_PROTOCOL_VERSION,
          },
          'host-ws: refused daemon on incompatible wire protocol',
        );
        // #task:1966 — close with the DIAGNOSABLE reason instead of falling
        // through to the generic frame error. A version we can read but do not
        // speak is not a transient failure: no retry against this server can
        // succeed until the daemon binary changes, so the reason has to carry
        // that so the daemon can stop retrying. A version we cannot even read
        // keeps the generic path below (corrupt dialer, still retryable).
        this.closeWithProtocolError(HOST_WS_CLOSE_REASON_UPDATE_REQUIRED);
        return;
      }
    }

    const response =
      OutboundDaemonToServerCommandResponseFrameSchema.safeParse(frame);
    if (response.success) {
      this.handleCommandResponse(response.data);
      return;
    }

    const heartbeat = OutboundHeartbeatFrameSchema.safeParse(frame);
    if (heartbeat.success) {
      this.handleHeartbeat(heartbeat.data);
      return;
    }

    const event = OutboundDaemonToServerEventFrameSchema.safeParse(frame);
    if (event.success) {
      this.handleDaemonEvent(event.data);
      return;
    }

    this.closeWithProtocolError('invalid daemon-to-server frame');
  }

  private closeWithProtocolError(reason: string): void {
    this.cleanup();
    if (
      this.ws.readyState === WebSocket.OPEN ||
      this.ws.readyState === WebSocket.CONNECTING
    ) {
      this.ws.close(1002, reason);
    }
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    if (this.readyProtocolVersion !== null) {
      this.ctx.metrics?.changeHostWsReadyConnections(
        this.readyProtocolVersion,
        -1,
      );
      this.readyProtocolVersion = null;
    }
    this.clearPingTimer();
    this.clearPongTimer();
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket disconnected`,
    );
    if (!this.shouldIgnoreEventSink()) {
      this.eventSink?.onDisconnect?.(this.host.hostId, this.connectionId);
    }
  }

  private handleDaemonEvent(frame: OutboundDaemonToServerEventFrame): void {
    if (frame.kind === 'ready') {
      // #task:1631 — a schema-valid `ready` proves this daemon speaks our wire
      // version, which is the ONLY thing that resolves a recorded
      // protocol-mismatch refusal. Clearing here (rather than on authenticated
      // upgrade) is what keeps a stale daemon's reconnect loop from flickering
      // the reason off between attempts.
      this.clearAdmissionFailure();
      if (this.readyProtocolVersion === null) {
        this.readyProtocolVersion = String(frame.protocol_version);
        this.ctx.metrics?.changeHostWsReadyConnections(
          this.readyProtocolVersion,
          1,
        );
      }
      this.ctx.metrics?.observeHostWsConnection(
        'ready',
        `protocol_${frame.protocol_version}`,
      );
      // Record the daemon's advertised capabilities on THIS live attachment
      // (#task:1486). Replacement-safe via the connectionId guard in the
      // callback; disconnect drops the whole record. Unknown tokens are kept
      // verbatim (consumers match by exact token).
      this.updateAttachmentReady(
        frame.host_descriptor.name,
        frame.capabilities,
      );
    }
    if (this.shouldIgnoreEventSink()) {
      if (!this.loggedNoEventSink) {
        this.loggedNoEventSink = true;
        this.ctx.logger.info(
          {
            hostId: this.host.hostId,
            connectionId: this.connectionId,
            eventKind: frame.kind,
            deploymentMode: this.deploymentMode,
            coLocatedHostId: this.ctx.coLocatedHostId,
          },
          'host-ws: outbound event ignored (embedded co-located host uses local outbound socket)',
        );
      }
      return;
    }
    if (!this.eventSink) {
      // Production boot wires the shared fanout into host-ws. If a test
      // or custom bootstrap omits it, warn in standalone where WS is the
      // only event ingress; embedded uses the co-located guard above for
      // the one host that must stay on the Unix-socket path.
      if (!this.loggedNoEventSink) {
        this.loggedNoEventSink = true;
        if (this.deploymentMode === 'embedded') {
          this.ctx.logger.info(
            {
              hostId: this.host.hostId,
              connectionId: this.connectionId,
              eventKind: frame.kind,
              deploymentMode: this.deploymentMode,
            },
            'host-ws: outbound event ignored (no fanout sink configured)',
          );
        } else {
          this.ctx.logger.warn(
            {
              hostId: this.host.hostId,
              connectionId: this.connectionId,
              eventKind: frame.kind,
              deploymentMode: this.deploymentMode,
            },
            'host-ws: outbound daemon event received without fanout sink; backend is misconfigured',
          );
        }
      }
      return;
    }
    try {
      this.eventSink.onEvent(this.host.hostId, frame, this.connectionId);
    } catch (err) {
      this.ctx.logger.error(
        {
          err: (err as Error).message,
          hostId: this.host.hostId,
          eventKind: frame.kind,
        },
        'host-ws: outbound daemon event fanout failed',
      );
      this.ws.close(1011, 'event_fanout_failed');
    }
  }

  private shouldIgnoreEventSink(): boolean {
    return (
      this.deploymentMode === 'embedded' &&
      this.ctx.coLocatedHostId === this.host.hostId
    );
  }

  private handleCommandResponse(
    frame: OutboundDaemonToServerCommandResponseFrame,
  ): void {
    const pending = this.pendingCommands.get(frame.id);
    if (!pending) {
      this.ctx.logger.warn(
        {
          hostId: this.host.hostId,
          requestId: frame.id,
          commandKind: frame.kind,
        },
        'host-ws: received command response with no pending request',
      );
      return;
    }
    if (pending.kind !== frame.kind) {
      this.pendingCommands.delete(frame.id);
      clearTimeout(pending.timer);
      pending.reject(
        new HostWsCommandTransportError(
          'transport_response_mismatch',
          `outbound command response kind mismatch: expected ${pending.kind}, got ${frame.kind}`,
          {
            hostId: this.host.hostId,
            commandKind: pending.kind,
            requestId: frame.id,
          },
        ),
      );
      this.closeWithProtocolError('command_response_kind_mismatch');
      return;
    }
    this.pendingCommands.delete(frame.id);
    clearTimeout(pending.timer);
    if ('error' in frame) {
      pending.reject(
        new HostWsCommandResponseError(frame.error.code, frame.error.message, {
          hostId: this.host.hostId,
          commandKind: frame.kind,
          requestId: frame.id,
        }),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private rejectPendingDisconnected(message: string): void {
    if (this.pendingCommands.size === 0) return;
    const pending = [...this.pendingCommands.values()];
    this.pendingCommands.clear();
    for (const command of pending) {
      clearTimeout(command.timer);
      command.reject(
        new HostWsCommandTransportError('transport_disconnected', message, {
          hostId: this.host.hostId,
          commandKind: command.kind,
          requestId: command.id,
        }),
      );
    }
  }

  private handleHeartbeat(frame: OutboundHeartbeatFrame): void {
    if (frame.direction !== 'daemon_to_server') {
      this.closeWithProtocolError('wrong_direction_heartbeat');
      return;
    }
    if (frame.kind === 'ping') {
      this.send({
        direction: 'server_to_daemon',
        type: 'heartbeat',
        kind: 'pong',
        ts: Date.now(),
        echo_ts: frame.ts,
      });
      return;
    }
    this.clearPongTimer();
  }

  private startHeartbeat(): void {
    if (this.pingIntervalMs <= 0) return;
    this.pingTimer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      const ts = Date.now();
      this.send({
        direction: 'server_to_daemon',
        type: 'heartbeat',
        kind: 'ping',
        ts,
      });
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.ctx.logger.warn(
          { hostId: this.host.hostId, timeoutMs: this.pongTimeoutMs },
          'host-ws: heartbeat timeout',
        );
        this.ws.close(1008, 'heartbeat_timeout');
      }, this.pongTimeoutMs);
      this.pongTimer.unref?.();
    }, this.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private send(frame: OutboundFrame): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(encodeOutboundFrame(frame));
    } catch (err) {
      this.ctx.logger.warn(
        { err, hostId: this.host.hostId },
        'host-ws: send failed',
      );
    }
  }

  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}

function observeDaemonCommand<T>(
  ctx: BackendContext,
  command: OutboundServerCommandKind,
  startedAt: number,
  result: Promise<T>,
): Promise<T> {
  return result.then(
    value => {
      ctx.metrics?.observeDaemonCommand(
        command,
        'ok',
        performance.now() - startedAt,
      );
      return value;
    },
    err => {
      ctx.metrics?.observeDaemonCommand(
        command,
        daemonCommandOutcome(err),
        performance.now() - startedAt,
      );
      throw err;
    },
  );
}

function daemonCommandOutcome(
  err: unknown,
): 'timeout' | 'disconnected' | 'error' {
  if (err instanceof HostWsCommandTransportError) {
    if (err.code === 'transport_timeout') return 'timeout';
    if (
      err.code === 'transport_no_connection' ||
      err.code === 'transport_disconnected'
    ) {
      return 'disconnected';
    }
  }
  return 'error';
}

function classifyHostWsCloseReason(code: number, rawReason: Buffer): string {
  const reason = rawReason.toString('utf8');
  if (reason === 'server_shutdown') return 'server_shutdown';
  if (reason === HOST_WS_CLOSE_REASON_REVOKED) return 'host_revoked';
  if (reason === HOST_WS_CLOSE_REASON_DISCONNECTED) return 'host_disconnected';
  if (reason === 'host_connection_replaced') return 'host_connection_replaced';
  if (reason === 'heartbeat_timeout') return 'heartbeat_timeout';
  // Split out of the generic `protocol_error` bucket (#task:1966): this one is
  // the fleet's "daemon needs upgrading" signal, and it is the only protocol
  // close the daemon treats as terminal — collapsing it into `protocol_error`
  // would hide exactly the population the suppression is meant to shrink.
  if (reason === HOST_WS_CLOSE_REASON_UPDATE_REQUIRED) return 'update_required';
  if (code === 1002) return 'protocol_error';
  if (code === 1000) return 'normal';
  if (reason === '') return 'no_reason';
  return 'other';
}

function readyFrameProtocolVersion(frame: object): string | null {
  const candidate = frame as Record<string, unknown>;
  if (
    candidate.direction !== 'daemon_to_server' ||
    candidate.type !== 'event' ||
    candidate.kind !== 'ready'
  ) {
    return null;
  }
  const version = candidate.protocol_version;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > 100
  ) {
    return 'invalid';
  }
  return String(version);
}

type HostAuthResult =
  | { ok: true; host: AuthenticatedHost }
  | { ok: false; statusCode: number; reason: string };

function authenticateHost(
  req: IncomingMessage,
  ctx: BackendContext,
): HostAuthResult {
  const token = bearerToken(req.headers.authorization);
  if (!token) {
    return { ok: false, statusCode: 401, reason: 'Unauthorized' };
  }

  const verified = new HostTokenService(ctx.db).verifyHostToken(token);
  if (!verified.ok) {
    return { ok: false, statusCode: 401, reason: 'Unauthorized' };
  }

  const hosts = new HostRepo(ctx.db);
  const host = hosts.get(verified.hostId);
  if (!host) {
    return { ok: false, statusCode: 401, reason: 'Unauthorized' };
  }
  const userManagedRemote =
    host.kind === 'remote' &&
    host.provisioning_source === 'user_invite' &&
    host.user_id !== null;
  if (host.kind !== 'local' && !userManagedRemote) {
    return { ok: false, statusCode: 403, reason: 'Forbidden' };
  }

  return {
    ok: true,
    host: {
      hostId: verified.hostId,
      userId: verified.userId,
      credentialId: verified.credentialId,
    },
  };
}

function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
}

function requestPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function parseJsonFrame(data: RawData): unknown | null {
  try {
    const parsed = JSON.parse(rawDataToString(data)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  reason: string,
  body?: Record<string, unknown>,
): void {
  if (!body) {
    socket.write(
      `HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      `Connection: close\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      `\r\n` +
      payload,
  );
  socket.destroy();
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    ws.once('close', () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
