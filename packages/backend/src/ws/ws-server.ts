import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { apiPaths, EVENT_WS_SESSION_COOKIE } from '@silverhand/shared';
import type { BackendContext } from '../context.js';
import { EventWsConnection, type EventWsConnectionOptions } from './ws-connection.js';

export const EVENT_WS_PATH = apiPaths.eventWebSocket;

export interface EventWsServerOptions extends Omit<EventWsConnectionOptions, 'viewerUserId'> {
  path?: string;
  maxPayloadBytes?: number;
  shutdownGraceMs?: number;
}

export interface EventWsServerController {
  activeConnectionCount(): number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 1_500;

export function installEventWebSocketServer(
  server: HttpServer,
  ctx: BackendContext,
  opts: EventWsServerOptions = {},
): EventWsServerController {
  const path = opts.path ?? EVENT_WS_PATH;
  const shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });
  const connections = new Map<WebSocket, EventWsConnection>();
  let closing = false;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = requestPathname(req);
    if (pathname !== path) return;
    if (!isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!hasExpectedOrigin(req, ctx)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const viewerUserId = resolveViewerUserIdFromCookie(req, ctx);
    if (!viewerUserId) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const connectionId = randomUUID();
      const connection = new EventWsConnection(ws, ctx, {
        ...opts,
        viewerUserId,
      });
      connections.set(ws, connection);
      ctx.presence.onConnect(viewerUserId, connectionId);
      ws.on('close', () => {
        connections.delete(ws);
        ctx.presence.onDisconnect(viewerUserId, connectionId);
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
      ctx.presence.dispose();
    },
  };
}

function isWebSocketUpgrade(req: IncomingMessage): boolean {
  return String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
}

function hasExpectedOrigin(req: IncomingMessage, ctx: BackendContext): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  return eventWsAllowedOrigins(ctx).has(origin);
}

function eventWsAllowedOrigins(ctx: BackendContext): Set<string> {
  // Trust ONLY the explicit security allowlist — never derive trust from
  // `serverConfig.url` (that conflates the server's own identity URL with "which
  // browser origins may connect"). Standalone populates the allowlist from
  // `SILVERHAND_EVENT_WS_ALLOWED_ORIGINS`; embedded seeds its finalized loopback
  // origin at bind time (`startBackend`). See `docs/server-env-config.md`.
  const origins = new Set<string>();
  for (const configured of ctx.serverConfig.event_ws_allowed_origins ?? []) {
    origins.add(new URL(configured).origin);
  }
  return origins;
}

function resolveViewerUserIdFromCookie(
  req: IncomingMessage,
  ctx: BackendContext,
): string | null {
  const token = parseCookie(req.headers.cookie ?? '')[EVENT_WS_SESSION_COOKIE]?.trim();
  if (!token) return null;
  const session = ctx.authSessions.validateSessionToken(token);
  return session.ok ? session.session.user_id : null;
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function requestPathname(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function rejectUpgrade(socket: Duplex, statusCode: number, reason: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return Promise.resolve();
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
