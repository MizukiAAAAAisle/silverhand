import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BackendContext } from '../context.js';
import { EventWsConnection, type EventWsConnectionOptions } from './ws-connection.js';

export const EVENT_WS_PATH = '/api/ws/events';

export interface EventWsServerOptions extends EventWsConnectionOptions {
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
    if (closing) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const connection = new EventWsConnection(ws, ctx, opts);
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
