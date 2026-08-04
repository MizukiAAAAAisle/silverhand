/**
 * #task:1761 — socket-level behavior of the event-WS epoch admission.
 *
 * Pins (structure only, never copy):
 *   1. Default build (relocation-v1 §6 raised the minimum to the current
 *      epoch): only a current epoch header connects; no header and a malformed
 *      one are both the pre-epoch generation and are refused.
 *   2. Raised minimum via the test seam: a pre-epoch upgrade is refused with a
 *      REAL structured HTTP 426 — status code AND a JSON body that parses as
 *      UpgradeRequiredBody (Cindy round-2: the body must not be dropped on the
 *      floor).
 *   3. A current-epoch upgrade still connects.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  DESKTOP_API_EPOCH_HEADER,
  DESKTOP_SERVER_API_EPOCH,
  EVENT_WS_SESSION_COOKIE,
  UpgradeRequiredBodySchema,
} from '@silverhand/shared';
import {
  EVENT_WS_PATH,
  installEventWebSocketServer,
  type EventWsServerController,
} from '../../src/ws/ws-server.js';
import { buildTestApp, type TestApp } from '../utils/app.js';

describe('event WebSocket epoch admission (#task:1761)', () => {
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

  async function open(minimum?: number): Promise<string> {
    t = buildTestApp();
    httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    controller = installEventWebSocketServer(httpServer, t.ctx, {
      pingIntervalMs: 0,
      desktopApiEpochMinimum: minimum,
    });
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
    return `ws://127.0.0.1:${port}${EVENT_WS_PATH}`;
  }

  type UpgradeOutcome =
    | { kind: 'open' }
    | { kind: 'rejected'; status: number; body: string };

  async function attempt(url: string, epochHeader?: string): Promise<UpgradeOutcome> {
    const token = t!.ctx.authSessions.issueSession({ userId: 'local' }).userToken;
    const headers: Record<string, string> = {
      Origin: new URL(url.replace(/^ws/, 'http')).origin,
      Cookie: `${EVENT_WS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    };
    if (epochHeader !== undefined) headers[DESKTOP_API_EPOCH_HEADER] = epochHeader;
    const ws = new WebSocket(url, { headers });
    sockets.push(ws);
    return new Promise<UpgradeOutcome>((resolve, reject) => {
      ws.once('open', () => resolve({ kind: 'open' }));
      ws.once('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            kind: 'rejected',
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      });
      ws.once('error', err => {
        // `unexpected-response` supersedes error for HTTP rejections; a raw
        // error here means the test harness itself broke.
        if (!sockets.includes(ws)) return;
        reject(err);
      });
    });
  }

  it('the default minimum admits a current epoch and refuses missing / malformed ones', async () => {
    const url = await open();
    expect((await attempt(url, String(DESKTOP_SERVER_API_EPOCH))).kind).toBe('open');
    // relocation-v1 §6 closed the observation bridge: absent and unparseable
    // both normalize to epoch 0, which is now below the minimum.
    expect((await attempt(url)).kind).toBe('rejected');
    expect((await attempt(url, 'garbage')).kind).toBe('rejected');
  });

  it('the explicit minimum seam refuses a pre-epoch upgrade with a structured HTTP 426 body', async () => {
    const url = await open(DESKTOP_SERVER_API_EPOCH);
    const outcome = await attempt(url);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.status).toBe(426);
    const body = UpgradeRequiredBodySchema.parse(JSON.parse(outcome.body));
    expect(body.reason).toBe('client_too_old');
    expect(body.server_api_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
    expect(body.minimum_client_epoch).toBe(DESKTOP_SERVER_API_EPOCH);
  });

  it('a current-epoch upgrade still connects under the explicit minimum seam', async () => {
    const url = await open(DESKTOP_SERVER_API_EPOCH);
    expect((await attempt(url, String(DESKTOP_SERVER_API_EPOCH))).kind).toBe('open');
  });
});
