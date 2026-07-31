import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { apiPaths, CLIENT_INFO_HEADER, DESKTOP_API_EPOCH_HEADER, EVENT_WS_SESSION_COOKIE, parseClientInfoHeader, parseDesktopApiEpochHeader, UPGRADE_REQUIRED_HTTP_STATUS } from '@silverhand/shared';
import { checkDesktopApiEpochOnUpgrade } from '../auth/desktop-api-epoch.js';
import type { BackendContext } from '../context.js';
import { EventWsConnection, type EventWsConnectionOptions } from './ws-connection.js';

export const EVENT_WS_PATH = apiPaths.eventWebSocket;

export interface EventWsServerOptions extends Omit<EventWsConnectionOptions, 'viewerUserId'> {
  path?: string;
  maxPayloadBytes?: number;
  shutdownGraceMs?: number;
  /** #task:1761 test seam — see DesktopApiEpochOptions in auth/desktop-api-epoch.ts. */
  desktopApiEpochMinimum?: number;
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
    // #task:1761 — desktop API epoch admission (WS half). Same epoch source
    // and normalization as the REST middleware by construction; checked after
    // auth so the gate mirrors the REST position (bearer first, epoch second).
    const epochRejection = checkDesktopApiEpochOnUpgrade(req, {
      minimumClientEpoch: opts.desktopApiEpochMinimum,
    });
    if (epochRejection) {
      ctx.logger.warn(
        {
          action: 'desktop_api_epoch_rejected',
          transport: 'event_ws',
          user_id: viewerUserId,
          minimum_client_epoch: epochRejection.minimum_client_epoch,
        },
        'desktop api epoch: client too old',
      );
      rejectUpgrade(
        socket,
        UPGRADE_REQUIRED_HTTP_STATUS,
        'Upgrade Required',
        epochRejection,
      );
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
      logDesktopClientConnected(ctx, req, viewerUserId, connectionId);
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

/**
 * #task:1530 — emit ONE structured release-telemetry line per authenticated
 * event-WS connect, for fleet version-rollout observability (ECS JSONL log).
 *
 * Called only AFTER the upgrade is authenticated (viewer + connection resolved),
 * so no unauthenticated connect is logged. The client-info header is untrusted:
 * bounded-parsed to `valid | missing | invalid`, and only a `valid` payload
 * contributes normalized fields. `missing` is still logged (observe old desktops
 * that never send the header); `invalid` logs only the status — never the raw
 * header. Telemetry is fail-open: this never rejects or affects the upgrade.
 */
function logDesktopClientConnected(
  ctx: BackendContext,
  req: IncomingMessage,
  viewerUserId: string,
  connectionId: string,
): void {
  const clientInfo = parseClientInfoHeader(req.headers[CLIENT_INFO_HEADER]);
  ctx.logger.info(
    {
      action: 'desktop_client_connected',
      user_id: viewerUserId,
      connection_id: connectionId,
      client_info_status: clientInfo.status,
      // #task:1761 — ADMISSION epoch from the dedicated header (0 = pre-epoch
      // or malformed), logged for every session regardless of telemetry
      // status so the cutoff evidence covers all three telemetry buckets.
      admission_epoch: parseDesktopApiEpochHeader(
        req.headers[DESKTOP_API_EPOCH_HEADER],
      ),
      ...(clientInfo.status === 'valid'
        ? {
            client_surface: clientInfo.value.client_surface,
            deployment: clientInfo.value.deployment,
            app_version: clientInfo.value.app_version,
            build_commit: clientInfo.value.build_commit,
            build_dirty: clientInfo.value.build_dirty,
            platform: clientInfo.value.platform,
            arch: clientInfo.value.arch,
            installation_id: clientInfo.value.installation_id,
            // #task:1761 — observation bridge: per-session epoch distribution.
            // Absent field logs as 0 (pre-epoch generation), matching the
            // admission normalization.
            desktop_api_epoch: clientInfo.value.desktop_api_epoch ?? 0,
          }
        : {}),
    },
    'desktop client connected',
  );
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

function rejectUpgrade(
  socket: Duplex,
  statusCode: number,
  reason: string,
  body?: unknown,
): void {
  // #task:1761 — same JSON-body shape as host-ws-server's reject helper: a
  // structured rejection (e.g. the 426 UpgradeRequiredBody) is written as a
  // real HTTP response body, not dropped on the floor.
  if (body === undefined) {
    socket.write(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`);
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
