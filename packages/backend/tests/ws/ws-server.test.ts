import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { ClientFrame, ServerConfig, ServerFrame } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';
import { EVENT_WS_PATH, installEventWebSocketServer } from '../../src/ws/ws-server.js';
import type { EventWsServerController, EventWsServerOptions } from '../../src/ws/ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

interface TestWsServer {
  url: string;
  controller: EventWsServerController;
  close(): Promise<void>;
}

describe('event WebSocket server', () => {
  let t: TestApp | null = null;
  let server: TestWsServer | null = null;
  let runningBackend: RunningBackend | null = null;
  let tmpCleanup: (() => void) | null = null;
  let sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets = [];
    await server?.close();
    server = null;
    await runningBackend?.close().catch(() => undefined);
    runningBackend = null;
    tmpCleanup?.();
    tmpCleanup = null;
    t?.cleanup();
    t = null;
  });

  it('authenticates with the configured token', async () => {
    t = buildTestApp();
    server = await openServer(t);

    const { ws, authenticated } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    expect(authenticated).toMatchObject({
      type: 'authenticated',
      viewerId: 'local',
      epoch: t.ctx.events.epoch,
    });
  });

  it('rejects non-auth frames before authentication', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const ws = await connect(server.url);
    sockets.push(ws);

    const errorFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: 'app' });

    const error = await errorFrame;
    expect(error).toMatchObject({ type: 'error', code: 'auth_required' });
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('enforces the auth timeout', async () => {
    t = buildTestApp();
    server = await openServer(t, { authTimeoutMs: 20 });
    const ws = await connect(server.url);
    sockets.push(ws);

    const error = await readFrame(ws);
    expect(error).toMatchObject({ type: 'error', code: 'auth_required' });
    const closed = await waitForClose(ws);
    expect(closed.code).toBe(1008);
  });

  it('subscribes to app scope and receives scoped events', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const subscribedFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: 'app' });
    const subscribed = await subscribedFrame;
    expect(subscribed).toMatchObject({
      type: 'subscribed',
      scope: 'app',
      epoch: t.ctx.events.epoch,
      seq: 0,
    });

    const eventFrame = readFrame(ws);
    t.ctx.events.publishToScope('app', 'workspace_list_changed', { ok: true });
    const event = await eventFrame;
    expect(event).toMatchObject({
      type: 'event',
      scope: 'app',
      seq: 1,
      epoch: t.ctx.events.epoch,
      kind: 'workspace_list_changed',
      payload: { ok: true },
    });
  });

  it('rewrites viewer:self and forbids subscribing to another viewer', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const viewerSelfFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: 'viewer:self' });
    expect(await viewerSelfFrame).toMatchObject({
      type: 'subscribed',
      scope: 'viewer:local',
    });

    const forbiddenFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: 'viewer:someone-else' });
    expect(await forbiddenFrame).toMatchObject({
      type: 'error',
      code: 'forbidden',
    });
  });

  it('subscribes to real conversation scopes and receives legacy publish fanout', async () => {
    t = buildTestApp();
    const conversationId = await createWorkspaceAndConversation(t);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const subscribedFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: `conversation:${conversationId}` });
    expect(await subscribedFrame).toMatchObject({
      type: 'subscribed',
      scope: `conversation:${conversationId}`,
    });

    const eventFrame = readFrame(ws);
    t.ctx.events.publish(conversationId, {
      kind: 'message',
      payload: { message: { id: 'm1' } },
    });
    expect(await eventFrame).toMatchObject({
      type: 'event',
      scope: `conversation:${conversationId}`,
      kind: 'message',
      payload: { message: { id: 'm1' } },
    });
  });

  it('fans out HTTP-posted conversation messages over subscribed WS scopes', async () => {
    t = buildTestApp();
    const conversationId = await createWorkspaceAndConversation(t);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const subscribedFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: `conversation:${conversationId}` });
    expect(await subscribedFrame).toMatchObject({
      type: 'subscribed',
      scope: `conversation:${conversationId}`,
    });

    const eventFrame = readFrame(ws);
    const post = await http(t, { 'X-Silverhand-User-Id': 'local' }).post(
      `/api/channels/${conversationId}/messages`,
      { content: 'hello over http' },
    );
    expect(post.status).toBe(201);

    expect(await eventFrame).toMatchObject({
      type: 'event',
      scope: `conversation:${conversationId}`,
      kind: 'message',
      payload: {
        message: {
          conversation_id: conversationId,
          content: 'hello over http',
        },
      },
    });
  });

  it('replays missed events on matching epoch resume', async () => {
    t = buildTestApp();
    t.ctx.events.publishToScope('app', 'a', { n: 1 });
    t.ctx.events.publishToScope('app', 'b', { n: 2 });
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const replayedFrames = readFrames(ws, 2);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: t.ctx.events.epoch, lastSeq: 0 } },
    });

    const [firstEvent, secondEvent] = await replayedFrames;
    expect(firstEvent).toMatchObject({ type: 'event', scope: 'app', seq: 1 });
    expect(secondEvent).toMatchObject({ type: 'event', scope: 'app', seq: 2 });
  });

  it('requires snapshot on epoch mismatch', async () => {
    t = buildTestApp();
    t.ctx.events.publishToScope('app', 'a', null);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const snapshotFrame = readFrame(ws);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: 'old-epoch', lastSeq: 0 } },
    });

    expect(await snapshotFrame).toMatchObject({
      type: 'snapshot_required',
      scope: 'app',
      reason: 'epoch_mismatch',
    });
  });

  it('requires snapshot when the replay gap exceeds the buffer', async () => {
    t = buildTestApp();
    for (let i = 0; i < 201; i++) {
      t.ctx.events.publishToScope('app', 'ev', { i });
    }
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);

    const snapshotFrame = readFrame(ws);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: t.ctx.events.epoch, lastSeq: 0 } },
    });

    expect(await snapshotFrame).toMatchObject({
      type: 'snapshot_required',
      scope: 'app',
      reason: 'gap_too_large',
    });
  });

  it('closes active WebSocket clients during server shutdown', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(server.url, t.authToken);
    sockets.push(ws);
    expect(server.controller.activeConnectionCount()).toBe(1);

    const closed = waitForClose(ws);
    await server.controller.close();

    expect((await closed).code).toBe(1001);
    expect(server.controller.activeConnectionCount()).toBe(0);
  });

  it('startBackend closes active WebSocket clients before HTTP drain', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'silverhand-ws-backend-'));
    tmpCleanup = () => rmSync(tmp, { recursive: true, force: true });
    const config: ServerConfig = {
      mode: 'embedded',
      url: 'http://127.0.0.1:0',
      auth_token: 'c'.repeat(32),
      user_id: null,
      refresh_token: null,
      child_sessions: {
        max_concurrent_per_parent: null,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };
    runningBackend = await startBackend({
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: config,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: { info() {}, warn() {}, error() {} },
    });

    const { ws } = await connectAuthenticated(
      runningBackend.url.replace(/^http:/, 'ws:') + EVENT_WS_PATH,
      config.auth_token,
    );
    sockets.push(ws);
    const closed = waitForClose(ws);

    await runningBackend.close();
    runningBackend = null;

    expect((await closed).code).toBe(1001);
  });
});

async function openServer(
  t: TestApp,
  opts: EventWsServerOptions = {},
): Promise<TestWsServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const controller = installEventWebSocketServer(httpServer, t.ctx, {
    pingIntervalMs: 0,
    ...opts,
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}${EVENT_WS_PATH}`,
    controller,
    close: async () => {
      await controller.close();
      await closeHttpServer(httpServer);
    },
  };
}

async function createWorkspaceAndConversation(t: TestApp): Promise<string> {
  const res = await http(t).post('/api/workspaces', {
    name: `ws-${randomUUID().slice(0, 8)}`,
  });
  expect(res.status).toBe(201);
  const body = await res.json() as { onboarding_channel_id: string };
  return body.onboarding_channel_id;
}

async function connect(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

async function connectAuthenticated(
  url: string,
  token: string,
): Promise<{ ws: WebSocket; authenticated: ServerFrame }> {
  const ws = await connect(url);
  const authenticatedFrame = readFrame(ws);
  sendFrame(ws, { type: 'auth', token });
  const authenticated = await authenticatedFrame;
  expect(authenticated.type).toBe('authenticated');
  return { ws, authenticated };
}

function sendFrame(ws: WebSocket, frame: ClientFrame): void {
  ws.send(JSON.stringify(frame));
}

async function readFrame(ws: WebSocket): Promise<ServerFrame> {
  const data = await new Promise<RawData>((resolve, reject) => {
    ws.once('message', resolve);
    ws.once('error', reject);
  });
  return JSON.parse(data.toString()) as ServerFrame;
}

async function readFrames(ws: WebSocket, count: number): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData) => {
      frames.push(JSON.parse(data.toString()) as ServerFrame);
      if (frames.length === count) {
        cleanup();
        resolve(frames);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
  });
}

async function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return { code: 1000, reason: '' };
  return new Promise(resolve => {
    ws.once('close', (code, reason) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
