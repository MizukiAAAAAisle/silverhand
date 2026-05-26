import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  OutboundDaemonToServerCommandResponseFrameSchema,
  OutboundDaemonToServerEventFrameSchema,
  OutboundHeartbeatFrameSchema,
  encodeOutboundFrame,
  type OutboundFrame,
  type OutboundHeartbeatFrame,
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
}

export interface HostWsServerController {
  activeConnectionCount(): number;
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
      const connection = new HostWsConnection(ws, ctx, auth.host, {
        pingIntervalMs: opts.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
        pongTimeoutMs: opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS,
      });
      connections.set(ws, connection);
      ws.on('close', () => {
        connections.delete(ws);
      });
      wss.emit('connection', ws, req);
      connection.start();
    });
  };

  server.on('upgrade', onUpgrade);

  return {
    activeConnectionCount: () => connections.size,
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

class HostWsConnection {
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly ctx: BackendContext,
    private readonly host: AuthenticatedHost,
    opts: { pingIntervalMs: number; pongTimeoutMs: number },
  ) {
    this.pingIntervalMs = opts.pingIntervalMs;
    this.pongTimeoutMs = opts.pongTimeoutMs;
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

  terminate(): void {
    this.cleanup();
    if (this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.terminate();
    }
  }

  private handleMessage(data: RawData): void {
    const frame = parseJsonFrame(data);
    if (!frame) {
      this.closeWithProtocolError('frame must be a JSON object');
      return;
    }

    const response = OutboundDaemonToServerCommandResponseFrameSchema.safeParse(frame);
    if (response.success) {
      // D2.c wires command correlation. D2.a only gates the frame shape.
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
    // Reserved for D2.c command waiters.
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
