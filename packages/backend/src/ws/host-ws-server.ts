import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundHeartbeatFrameSchema,
  OutboundServerToDaemonCommandFrameSchema,
  encodeOutboundFrame,
  type OutboundFrame,
  type OutboundDaemonToServerCommandResponseFrame,
  type OutboundHeartbeatFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type ResponseError,
} from '@silverhand/host';
import { apiPaths } from '@silverhand/shared';
import { HostTokenService } from '../auth/host-token.js';
import type { BackendContext } from '../context.js';
import { HostRepo } from '../repos/host-repo.js';

export const HOST_WS_PATH = apiPaths.hostConnect;

export interface HostWsServerOptions {
  path?: string;
  maxPayloadBytes?: number;
  shutdownGraceMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  commandTimeoutMs?: number;
}

export interface HostWsServerController {
  activeConnectionCount(): number;
  connectedHostIds(): string[];
  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number },
  ): Promise<OutboundServerCommandResult<K>>;
  close(): Promise<void>;
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
  const connectionsByHost = new Map<string, HostWsConnection>();
  const commandIdPrefix = `hostws-${randomUUID()}`;
  let commandSeq = 0;
  let closing = false;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = requestPathname(req);
    if (pathname !== path) return;
    if (!isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }

    const auth = authenticateHost(req, ctx);
    if (!auth.ok) {
      rejectUpgrade(socket, auth.statusCode, auth.reason);
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      const previous = connectionsByHost.get(auth.host.hostId);
      previous?.closeForReplacement();
      const connection = new HostWsConnection(ws, ctx, auth.host, {
        pingIntervalMs: opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
        pongTimeoutMs: opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
        commandTimeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        nextCommandId: () => `${commandIdPrefix}-${++commandSeq}`,
      });
      connections.set(ws, connection);
      connectionsByHost.set(auth.host.hostId, connection);
      ws.on('close', () => {
        connections.delete(ws);
        if (connectionsByHost.get(auth.host.hostId) === connection) {
          connectionsByHost.delete(auth.host.hostId);
        }
      });
      wss.emit('connection', ws, req);
      connection.start();
    });
  };

  server.on('upgrade', onUpgrade);

  return {
    activeConnectionCount: () => connections.size,
    connectedHostIds: () => [...connectionsByHost.keys()],
    sendCommand: (hostId, kind, params, commandOpts) => {
      const connection = connectionsByHost.get(hostId);
      if (!connection) {
        return Promise.reject(
          new HostWsCommandTransportError(
            'transport_no_connection',
            `host ${hostId} is not connected to outbound websocket`,
            { hostId, commandKind: kind },
          ),
        );
      }
      return connection.sendCommand(kind, params, commandOpts);
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
      await Promise.race([
        Promise.allSettled(closeWaits),
        terminateAfterGrace,
      ]);
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}

interface PendingCommand {
  id: string;
  kind: OutboundServerCommandKind;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class HostWsConnection {
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly nextCommandId: () => string;
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: BackendContext,
    private readonly host: AuthenticatedHost,
    opts: {
      pingIntervalMs: number;
      pongTimeoutMs: number;
      commandTimeoutMs: number;
      nextCommandId: () => string;
    },
  ) {
    this.pingIntervalMs = opts.pingIntervalMs;
    this.pongTimeoutMs = opts.pongTimeoutMs;
    this.commandTimeoutMs = opts.commandTimeoutMs;
    this.nextCommandId = opts.nextCommandId;
  }

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
          { hostId: this.host.hostId, commandKind: kind, requestId: id },
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
              { hostId: this.host.hostId, commandKind: kind, requestId: id },
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
            { hostId: this.host.hostId, commandKind: kind, requestId: id },
          ),
        );
      }
    });
  }

  private handleMessage(data: RawData): void {
    const frame = parseJsonFrame(data);
    if (!frame) {
      this.closeWithProtocolError('frame must be a JSON object');
      return;
    }

    const response = OutboundDaemonToServerCommandResponseFrameSchema.safeParse(frame);
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
      // D2.d wires backend fanout. D2.a only gates the frame shape.
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
    this.clearPingTimer();
    this.clearPongTimer();
    this.rejectPendingDisconnected(
      `host ${this.host.hostId} websocket disconnected`,
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

type HostAuthResult =
  | { ok: true; host: AuthenticatedHost }
  | { ok: false; statusCode: number; reason: string };

function authenticateHost(req: IncomingMessage, ctx: BackendContext): HostAuthResult {
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
  if (host.kind !== 'local') {
    return { ok: false, statusCode: 403, reason: 'Forbidden' };
  }

  hosts.touchLastSeen(host.id);
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

function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
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
