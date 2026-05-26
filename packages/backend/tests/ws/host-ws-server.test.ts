import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  KNOWN_CAPABILITIES_V1,
  OUTBOUND_PROTOCOL_VERSION,
} from '@silverhand/host';
import { apiPaths } from '@silverhand/shared';
import { HostTokenService } from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HOST_WS_PATH,
  installHostWebSocketServer,
  type HostWsServerController,
  type HostWsServerOptions,
} from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

interface TestHostWsServer {
  url: string;
  controller: HostWsServerController;
  close(): Promise<void>;
}

describe('host outbound WebSocket server', () => {
  let t: TestApp | null = null;
  let server: TestHostWsServer | null = null;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets = [];
    await server?.close();
    server = null;
    t?.cleanup();
    t = null;
  });

  it('exposes a non-upgrade route that does not accept user-session auth', async () => {
    t = buildTestApp();

    const res = await http(t).get(apiPaths.hostConnect);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'host websocket requires a websocket upgrade',
    });
  });

  it('accepts a valid long-lived local host token on upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local');
    expect(host).not.toBeNull();
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host!.id,
    });

    const before = new HostRepo(t.ctx.db).get(host!.id)!.last_seen_at;
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    expect(server.controller.activeConnectionCount()).toBe(1);
    const after = new HostRepo(t.ctx.db).get(host!.id)!.last_seen_at;
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThanOrEqual(before ?? 0);
  });

  it('rejects missing, unknown, and revoked host tokens before upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    new HostTokenService(t.ctx.db).revokeCredential(issued.credential.id);

    await expect(connectHost(server.url, null)).rejects.toThrow(
      /unexpected response 401/,
    );
    await expect(connectHost(server.url, 'not-a-token')).rejects.toThrow(
      /unexpected response 401/,
    );
    await expect(connectHost(server.url, issued.hostToken)).rejects.toThrow(
      /unexpected response 401/,
    );
  });

  it('rejects user-session bearer tokens before upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const userSessionToken = t.ctx.authSessions.issueSession({
      userId: 'local',
    }).userToken;

    await expect(connectHost(server.url, userSessionToken)).rejects.toThrow(
      /unexpected response 401/,
    );
  });

  it('rejects non-local hosts even with a valid host token', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const remote = new HostRepo(t.ctx.db).create('future-remote', 'remote', {
      userId: 'local',
      installationId: 'remote-install',
    });
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: remote.id,
    });

    await expect(connectHost(server.url, issued.hostToken)).rejects.toThrow(
      /unexpected response 403/,
    );
  });

  it('gates daemon-to-server frame shape after authentication', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const host = new HostRepo(t.ctx.db).getOwnedLocalForUser('local')!;
    const issued = new HostTokenService(t.ctx.db).issueHostToken({
      hostId: host.id,
    });
    const ws = await connectHost(server.url, issued.hostToken);
    sockets.push(ws);

    ws.send(JSON.stringify({
      direction: 'daemon_to_server',
      type: 'event',
      kind: 'ready',
      protocol_version: OUTBOUND_PROTOCOL_VERSION,
      daemon_version: '0.0.0-test',
      daemon_id: 'local',
      instance_id: 'instance-1',
      host_descriptor: { name: 'local', kind: 'local' },
      capabilities: [...KNOWN_CAPABILITIES_V1],
      daemon_pid: 123,
      started_at: 1700000000000,
    }));

    await expect(noCloseWithin(ws, 25)).resolves.toBeUndefined();

    ws.send(JSON.stringify({
      direction: 'server_to_daemon',
      type: 'event',
      kind: 'runtime_state',
    }));

    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1002);
  });
});

async function openServer(
  t: TestApp,
  opts: HostWsServerOptions = {},
): Promise<TestHostWsServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const controller = installHostWebSocketServer(httpServer, t.ctx, opts);
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  t.ctx.serverConfig = { ...t.ctx.serverConfig, url: `http://127.0.0.1:${port}` };
  return {
    url: `ws://127.0.0.1:${port}${HOST_WS_PATH}`,
    controller,
    close: async () => {
      await controller.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function connectHost(url: string, token: string | null): Promise<WebSocket> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const ws = new WebSocket(url, { headers });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }) => {
      cleanup();
      reject(new Error(`unexpected response ${res.statusCode ?? 'unknown'}`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpectedResponse);
  });
  return ws;
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return { code: 1000, reason: '' };
  return new Promise(resolve => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function noCloseWithin(ws: WebSocket, ms: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onClose = (code: number) => {
      cleanup();
      reject(new Error(`closed early ${code}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('close', onClose);
    };
    ws.once('close', onClose);
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
