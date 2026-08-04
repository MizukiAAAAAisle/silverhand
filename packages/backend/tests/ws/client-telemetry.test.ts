/**
 * #task:1530 — desktop release telemetry on the event-WS connect.
 *
 * The desktop sends an optional `X-Silverhand-Client-Info` header on the WS
 * upgrade; the server logs ONE structured `desktop_client_connected` line after
 * the authenticated accept. Telemetry is fail-open — a valid, missing, or
 * malformed header must all still connect. Pins:
 *   1. valid header → connects; logs status=valid + normalized release fields.
 *   2. no header → connects; logs status=missing, no release fields (observe
 *      old desktops).
 *   3. malformed header → connects; logs status=invalid, and NEVER echoes the
 *      raw header value into the log.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  CLIENT_INFO_HEADER,
  EVENT_WS_SESSION_COOKIE,
  serializeClientInfoHeader,
  type ClientInfo,
} from '@silverhand/shared';
import { EVENT_WS_PATH, installEventWebSocketServer } from '../../src/ws/ws-server.js';
import type { EventWsServerController } from '../../src/ws/ws-server.js';
import { buildTestApp, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

const VALID_CLIENT_INFO: ClientInfo = {
  client_surface: 'desktop',
  deployment: 'remote-only',
  app_version: '0.1.0',
  build_commit: 'a'.repeat(40),
  build_dirty: false,
  platform: 'darwin',
  arch: 'arm64',
  installation_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};

describe('event WebSocket desktop release telemetry (#task:1530)', () => {
  let t: TestApp | null = null;
  let controller: EventWsServerController | null = null;
  let httpServer: HttpServer | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets.length = 0;
    await controller?.close();
    controller = null;
    if (httpServer?.listening) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
    }
    httpServer = null;
    t?.cleanup();
    t = null;
  });

  async function open(): Promise<{ url: string; infoSpy: ReturnType<typeof vi.fn> }> {
    t = buildTestApp();
    const infoSpy = vi.fn();
    // Capture the structured connect log while leaving other logging intact.
    t.ctx.logger = { ...t.ctx.logger, info: infoSpy } as typeof t.ctx.logger;
    httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    controller = installEventWebSocketServer(httpServer, t.ctx, { pingIntervalMs: 0 });
    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    t.ctx.serverConfig = {
      ...t.ctx.serverConfig,
      url: origin,
      event_ws_allowed_origins: [
        ...(t.ctx.serverConfig.event_ws_allowed_origins ?? []),
        origin,
      ],
    };
    return { url: `ws://127.0.0.1:${port}${EVENT_WS_PATH}`, infoSpy };
  }

  async function connect(url: string, clientInfoHeader?: string): Promise<WebSocket> {
    const token = t!.ctx.authSessions.issueSession({ userId: 'local' }).userToken;
    const headers: Record<string, string> = {
      ...CURRENT_DESKTOP_EPOCH_HEADERS,
      Origin: new URL(url.replace(/^ws/, 'http')).origin,
      Cookie: `${EVENT_WS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    };
    if (clientInfoHeader !== undefined) headers[CLIENT_INFO_HEADER] = clientInfoHeader;
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`unexpected response ${res.statusCode ?? '?'}`)),
      );
    });
    return ws;
  }

  function connectLog(infoSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const call = infoSpy.mock.calls.find(
      ([payload]) =>
        payload && (payload as { action?: string }).action === 'desktop_client_connected',
    );
    expect(call, 'expected a desktop_client_connected log line').toBeTruthy();
    return call![0] as Record<string, unknown>;
  }

  it('valid header → connects and logs normalized release fields', async () => {
    const { url, infoSpy } = await open();
    await connect(url, serializeClientInfoHeader(VALID_CLIENT_INFO));
    // give the synchronous handleUpgrade log a tick to settle
    await new Promise(r => setTimeout(r, 5));
    const log = connectLog(infoSpy);
    expect(log).toMatchObject({
      action: 'desktop_client_connected',
      user_id: 'local',
      client_info_status: 'valid',
      deployment: 'remote-only',
      app_version: '0.1.0',
      build_commit: 'a'.repeat(40),
      build_dirty: false,
      platform: 'darwin',
      arch: 'arm64',
      installation_id: VALID_CLIENT_INFO.installation_id,
    });
    expect(typeof log.connection_id).toBe('string');
  });

  it('no header → still connects and logs status=missing without release fields', async () => {
    const { url, infoSpy } = await open();
    await connect(url);
    await new Promise(r => setTimeout(r, 5));
    const log = connectLog(infoSpy);
    expect(log.client_info_status).toBe('missing');
    expect(log.app_version).toBeUndefined();
    expect(log.installation_id).toBeUndefined();
  });

  it('malformed header → still connects, logs status=invalid, never echoes raw header', async () => {
    const { url, infoSpy } = await open();
    const raw = '{"client_surface":"desktop","evil":"' + 'x'.repeat(50) + '"}';
    await connect(url, raw);
    await new Promise(r => setTimeout(r, 5));
    const log = connectLog(infoSpy);
    expect(log.client_info_status).toBe('invalid');
    expect(log.app_version).toBeUndefined();
    // the raw header value must never appear anywhere in the structured log
    expect(JSON.stringify(log)).not.toContain('evil');
  });
});
