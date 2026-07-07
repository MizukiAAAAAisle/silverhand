import { Socket } from 'node:net';
import {
  MAX_FRAME_BYTES,
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  encodeOutboundFrame,
  splitNdjson,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type ResponseError,
} from '@silverhand/host';
import type { HostWsAttachment } from '../ws/host-ws-server.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './outbound-frame-adapter.js';

export interface EmbeddedUnixOutboundFrameAdapterOptions {
  /** Path to the daemon's `daemon-outbound.sock`. */
  socketPath: string;
  /**
   * The backend-known local host id. Embedded has exactly one local
   * host connection; `sendCommand` for any other host id fails fast with
   * `transport_no_connection` (the adapter never trusts a daemon-declared
   * host id — local-host ownership is authoritative on the backend).
   */
  hostId: string;
  /** Forward daemon events into the backend fanout. */
  onEvent?: (
    hostId: string,
    event: OutboundDaemonToServerEventFrame,
    connectionId: string,
  ) => void;
  /** Notify the backend that the live connection dropped. */
  onDisconnect?: (hostId: string, connectionId: string) => void;
  /** Per-command response timeout. */
  commandTimeoutMs?: number;
  logger?: {
    info: (meta: Record<string, unknown>, msg: string) => void;
    warn: (meta: Record<string, unknown>, msg: string) => void;
    error: (meta: Record<string, unknown>, msg: string) => void;
  };
}

interface PendingCommand {
  id: string;
  kind: OutboundServerCommandKind;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 1_000;

/**
 * D5.a-2 — embedded backend implementation of {@link OutboundFrameAdapter}
 * over a local Unix socket carrying the SAME outbound frame envelope as
 * the standalone WSS path.
 *
 * The backend INITIATES this connection (the daemon listens on
 * `daemon-outbound.sock`); that is the inverse of standalone, where the
 * daemon dials the backend's WSS. Either way the frame envelope, command
 * schemas, error taxonomy, and the {@link OutboundFrameAdapter} surface
 * are identical — which is the whole point of D5.a. This adapter passes
 * the same `runOutboundFrameAdapterContract` the standalone adapter does.
 *
 * Liveness model (per D5.a design §4.4): no app-level heartbeat. The
 * adapter relies on Unix-socket `close`/`error` events; a half-open
 * socket is not a concern under the same-uid local threat model.
 *
 * Security posture mirrors the WSS server: an inbound frame that fails
 * the per-command response schema is a PROTOCOL VIOLATION — the
 * connection is dropped and every pending command rejects
 * `transport_disconnected`. A buggy/compromised daemon therefore cannot
 * smuggle a foreign typed error code (e.g. an `agent_materialize`-scoped
 * code on a `runtime_status` response) up to the route layer. This is the
 * behavior the shared contract's negative typed-error pin enforces.
 */
export class EmbeddedUnixOutboundFrameAdapter implements OutboundFrameAdapter {
  private readonly socketPath: string;
  private readonly hostId: string;
  private readonly commandTimeoutMs: number;
  private readonly onEvent?: EmbeddedUnixOutboundFrameAdapterOptions['onEvent'];
  private readonly onDisconnect?: EmbeddedUnixOutboundFrameAdapterOptions['onDisconnect'];
  private readonly logger?: EmbeddedUnixOutboundFrameAdapterOptions['logger'];

  private socket: Socket | null = null;
  private connectionId: string | null = null;
  private attachedAt: number | null = null;
  private connectionSeq = 0;
  private commandSeq = 0;
  private readBuffer = '';
  private readonly pending = new Map<string, PendingCommand>();
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;

  constructor(opts: EmbeddedUnixOutboundFrameAdapterOptions) {
    this.socketPath = opts.socketPath;
    this.hostId = opts.hostId;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.onEvent = opts.onEvent;
    this.onDisconnect = opts.onDisconnect;
    this.logger = opts.logger;
  }

  /**
   * Open the Unix socket to the daemon's outbound frame server. Resolves
   * once connected; mints a fresh `connectionId` for this attachment.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('EmbeddedUnixOutboundFrameAdapter is closed');
    }
    if (this.socket) return;
    this.clearReconnectTimer();
    const socket = new Socket();
    socket.setEncoding('utf8');
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off('connect', onConnect);
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect(this.socketPath);
    });

    this.socket = socket;
    this.connectionId = `embedded-unix-${this.hostId}-conn-${++this.connectionSeq}`;
    this.attachedAt = Date.now();
    this.readBuffer = '';
    this.reconnectAttempt = 0;

    socket.on('data', chunk => this.onData(chunk));
    socket.on('close', () => this.onSocketClosed('socket_closed'));
    socket.on('error', err => {
      this.logger?.warn(
        { hostId: this.hostId, err: err.message },
        'embedded-unix: socket error',
      );
      if (!socket.destroyed) {
        socket.destroy();
      }
      this.onSocketClosed('socket_error');
    });
  }

  activeConnectionCount(): number {
    return this.socket ? 1 : 0;
  }

  connectedHostIds(): string[] {
    return this.socket ? [this.hostId] : [];
  }

  connectionIdForHost(hostId: string): string | null {
    if (hostId !== this.hostId) return null;
    return this.connectionId;
  }

  getAttachment(hostId: string): HostWsAttachment | null {
    if (hostId !== this.hostId || !this.socket || !this.connectionId) {
      return null;
    }
    return {
      hostId: this.hostId,
      connectionId: this.connectionId,
      attachedAt: this.attachedAt ?? 0,
      hostname: null,
    };
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    if (hostId !== this.hostId) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_no_connection',
          `embedded outbound adapter only serves local host ${this.hostId}, not ${hostId}`,
          { hostId, commandKind: kind },
        ),
      );
    }
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_no_connection',
          `host ${hostId} is not connected to the daemon outbound socket`,
          { hostId, commandKind: kind },
        ),
      );
    }
    if (
      opts?.expectedConnectionId &&
      this.connectionId !== opts.expectedConnectionId
    ) {
      return Promise.reject(
        new HostWsCommandTransportError(
          'transport_disconnected',
          `host ${hostId} outbound connection changed before ${kind}`,
          { hostId, commandKind: kind },
        ),
      );
    }

    const id = `embedded-unix-${this.hostId}-${++this.commandSeq}`;
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
          { hostId, commandKind: kind, requestId: id },
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
          { hostId, commandKind: kind, requestId: id },
        ),
      );
    }

    return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? this.commandTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HostWsCommandTransportError(
            'transport_timeout',
            `outbound command ${kind} timed out after ${timeoutMs}ms`,
            { hostId, commandKind: kind, requestId: id },
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        id,
        kind,
        timer,
        resolve: value => resolve(value as OutboundServerCommandResult<K>),
        reject,
      });
      // NDJSON: the outbound envelope encoder does not append a newline
      // (WSS uses message boundaries); the local socket is line-delimited,
      // so add the delimiter here.
      socket.write(`${encoded}\n`, err => {
        if (!err) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(
          new HostWsCommandTransportError(
            'transport_send_failed',
            err.message,
            { hostId, commandKind: kind, requestId: id },
          ),
        );
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    const socket = this.socket;
    if (!socket) {
      this.rejectAllPending('adapter closed');
      return;
    }
    await new Promise<void>(resolve => {
      socket.once('close', () => resolve());
      socket.end();
      // Backstop: if the peer never acks the FIN, force teardown.
      const timer = setTimeout(() => socket.destroy(), 200);
      timer.unref?.();
    });
  }

  private onData(chunk: string | Buffer): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const { frames, leftover, overflow } = splitNdjson(this.readBuffer, text);
    this.readBuffer = leftover;
    if (overflow) {
      this.protocolViolation(`inbound frame exceeded MAX_FRAME_BYTES=${MAX_FRAME_BYTES}`);
      return;
    }
    for (const line of frames) {
      if (!this.handleFrame(line)) return; // protocol violation tore down
    }
  }

  /** Returns false if the frame was a protocol violation (connection torn down). */
  private handleFrame(line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.protocolViolation('inbound frame was not valid JSON');
      return false;
    }

    const response =
      OutboundDaemonToServerCommandResponseFrameSchema.safeParse(parsed);
    if (response.success) {
      this.handleCommandResponse(response.data);
      return true;
    }

    const heartbeat = OutboundHeartbeatFrameSchema.safeParse(parsed);
    if (heartbeat.success) {
      // No app-level heartbeat for the local transport; ignore daemon
      // heartbeats rather than treating them as a violation.
      return true;
    }

    const event = OutboundDaemonToServerEventFrameSchema.safeParse(parsed);
    if (event.success) {
      if (this.connectionId) {
        this.onEvent?.(this.hostId, event.data, this.connectionId);
      }
      return true;
    }

    // Anything else — including a command_response carrying a typed error
    // code that the per-command schema does NOT declare — is a protocol
    // violation. The connection drops and pending commands fail as
    // transport_disconnected; the foreign code never reaches the route.
    this.protocolViolation('invalid daemon-to-server frame');
    return false;
  }

  private handleCommandResponse(
    frame:
      | { id: string; kind: OutboundServerCommandKind; result: unknown }
      | { id: string; kind: OutboundServerCommandKind; error: { code: string; message: string } },
  ): void {
    const pending = this.pending.get(frame.id);
    if (!pending) {
      this.logger?.warn(
        { hostId: this.hostId, requestId: frame.id, commandKind: frame.kind },
        'embedded-unix: command response with no pending request',
      );
      return;
    }
    if (pending.kind !== frame.kind) {
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      pending.reject(
        new HostWsCommandTransportError(
          'transport_response_mismatch',
          `outbound command response kind mismatch: expected ${pending.kind}, got ${frame.kind}`,
          { hostId: this.hostId, commandKind: pending.kind, requestId: frame.id },
        ),
      );
      this.protocolViolation('command_response_kind_mismatch');
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if ('error' in frame) {
      // Per-command typed wire error — surface its code intact (e.g. the
      // agent_materialize typed codes). The schema parse above already
      // guaranteed this code is valid for THIS command kind. Reuse the
      // same `HostWsCommandResponseError` the standalone path throws so
      // the route layer maps wire errors identically across transports;
      // the `code` param is narrowly typed for the generic 5, so widen
      // through `unknown` to admit the validated per-command typed codes.
      pending.reject(
        new HostWsCommandResponseError(
          frame.error.code as unknown as ResponseError['code'],
          frame.error.message,
          {
            hostId: this.hostId,
            commandKind: frame.kind,
            requestId: frame.id,
          },
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private protocolViolation(reason: string): void {
    this.logger?.warn(
      { hostId: this.hostId, reason },
      'embedded-unix: protocol violation; tearing down connection',
    );
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    this.onSocketClosed('protocol_violation');
  }

  private onSocketClosed(reason: string): void {
    const connectionId = this.connectionId;
    const hadSocket = this.socket !== null;
    if (!hadSocket && this.pending.size === 0) return;
    this.socket = null;
    this.connectionId = null;
    this.attachedAt = null;
    this.rejectAllPending(`host ${this.hostId} outbound socket disconnected (${reason})`);
    if (connectionId) {
      this.onDisconnect?.(this.hostId, connectionId);
    }
    this.scheduleReconnect(reason);
  }

  private rejectAllPending(message: string): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(
        new HostWsCommandTransportError('transport_disconnected', message, {
          hostId: this.hostId,
          commandKind: entry.kind,
          requestId: entry.id,
        }),
      );
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || this.reconnectTimer) return;
    const attempt = ++this.reconnectAttempt;
    const delayMs = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 4),
    );
    this.logger?.warn(
      { hostId: this.hostId, reason, attempt, delayMs },
      'embedded-unix: socket disconnected; scheduling reconnect',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(err => {
        this.logger?.warn(
          {
            hostId: this.hostId,
            reason,
            attempt,
            err: err instanceof Error ? err.message : String(err),
          },
          'embedded-unix: reconnect failed',
        );
        this.scheduleReconnect('reconnect_failed');
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
