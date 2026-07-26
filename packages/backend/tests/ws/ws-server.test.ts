import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  EVENT_WS_SESSION_COOKIE,
  EMBEDDED_BOOTSTRAP_FILENAME,
  authPaths,
  decodeTransportEpoch,
  decodeTransportSeq,
  type ClientFrame,
  type ServerConfig,
  type ServerFrame,
} from '@silverhand/shared';
import {
  resolveBackendDataPaths,
} from '@silverhand/shared/app-data-layout';
import { startBackend, type RunningBackend } from '../../src/index.js';
import { EVENT_WS_PATH, installEventWebSocketServer } from '../../src/ws/ws-server.js';
import type { EventWsServerController, EventWsServerOptions } from '../../src/ws/ws-server.js';
import { PresenceRegistry } from '../../src/presence/presence-registry.js';
import { UserRepo } from '../../src/repos/user-repo.js';
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

  it('authenticates with a session cookie', async () => {
    t = buildTestApp();
    server = await openServer(t);

    const { ws, authenticated } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    expect(authenticated).toMatchObject({
      type: 'authenticated',
      viewerId: 'local',
      epoch: t.ctx.events.epoch,
    });
  });

  it('uses the session subject instead of the legacy viewer setting for WS', async () => {
    t = buildTestApp();
    t.ctx.db.prepare(`DELETE FROM app_settings WHERE key = 'viewer_user_id'`).run();

    server = await openServer(t);
    const { ws, authenticated } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    expect(authenticated).toMatchObject({
      type: 'authenticated',
      viewerId: 'local',
      epoch: t.ctx.events.epoch,
    });
  });

  it('rejects retired server-config token cookies before upgrade', async () => {
    t = buildTestApp();
    server = await openServer(t);

    await expect(
      connectAuthenticated(server.url, t.legacyServerAuthToken),
    ).rejects.toThrow();
  });

  it('rejects websocket upgrades without the backend origin', async () => {
    t = buildTestApp();
    server = await openServer(t);

    await expect(
      connectAuthenticated(
        server.url,
        t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
        { origin: 'http://evil.example' },
      ),
    ).rejects.toThrow();
  });

  it('accepts configured public origins for event websocket upgrades', async () => {
    t = buildTestApp();
    t.ctx.serverConfig = {
      ...t.ctx.serverConfig,
      event_ws_allowed_origins: ['https://proxy.example.test/'],
    };
    server = await openServer(t);

    const { ws, authenticated } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
      { origin: 'https://proxy.example.test' },
    );
    sockets.push(ws);

    expect(authenticated).toMatchObject({
      type: 'authenticated',
      viewerId: 'local',
    });
  });

  it('subscribes to app scope and receives scoped events', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    const subscribedFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: 'app' });
    const subscribed = await subscribedFrame;
    expect(subscribed).toMatchObject({
      type: 'subscribed',
      scope: 'app',
      epoch: t.ctx.events.epoch,
      seq: 1,
    });

    const eventFrame = readFrame(ws);
    t.ctx.events.publishToScope('app', 'workspace_list_changed', { ok: true });
    const event = await eventFrame;
    expect(event).toMatchObject({
      type: 'event',
      scope: 'app',
      seq: 2,
      epoch: t.ctx.events.epoch,
      kind: 'workspace_list_changed',
      payload: { ok: true },
    });
  });

  it('publishes human presence transitions from websocket lifecycle', async () => {
    t = buildTestApp();
    t.ctx.presence = new PresenceRegistry({
      events: t.ctx.events,
      users: new UserRepo(t.ctx.db),
      offlineGraceMs: 0,
      logger: t.ctx.logger,
    });
    const publishSpy = vi.spyOn(t.ctx.events, 'publishToScope');
    server = await openServer(t);

    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);
    expect(publishSpy).toHaveBeenCalledWith('app', 'user_presence', {
      user_id: 'local',
      presence: 'online',
      last_seen_at: null,
    });

    const closed = waitForClose(ws);
    ws.close();
    await closed;
    await new Promise(resolve => setTimeout(resolve, 5));

    expect(publishSpy).toHaveBeenCalledWith('app', 'user_presence', {
      user_id: 'local',
      presence: 'offline',
      last_seen_at: expect.any(Number),
    });
    expect(new UserRepo(t.ctx.db).get('local')?.last_seen_at).toEqual(
      expect.any(Number),
    );
  });

  it('rewrites viewer:self and forbids subscribing to another viewer', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
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
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
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

  it('subscribes to the conversation side-channel scope and receives publishSide fanout', async () => {
    t = buildTestApp();
    const conversationId = await createWorkspaceAndConversation(t);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    // The side scope authorizes through the same canViewConversation gate as the
    // message stream (permissions.ts::parseWsScope + canSubscribeScope). Without
    // the Stage-2 parse addition this would come back `unknown_scope`.
    const subscribedFrame = readFrame(ws);
    sendFrame(ws, { type: 'subscribe', scope: `conversation-side:${conversationId}` });
    expect(await subscribedFrame).toMatchObject({
      type: 'subscribed',
      scope: `conversation-side:${conversationId}`,
    });

    const eventFrame = readFrame(ws);
    t.ctx.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    });
    expect(await eventFrame).toMatchObject({
      type: 'event',
      scope: `conversation-side:${conversationId}`,
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    });
  });

  it('fans out HTTP-posted conversation messages over subscribed WS scopes', async () => {
    t = buildTestApp();
    const conversationId = await createWorkspaceAndConversation(t);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
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
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    const replayedFrames = readFrames(ws, 2);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: t.ctx.events.epoch, lastSeq: decodeTransportSeq(0) } },
    });

    const [firstEvent, secondEvent] = await replayedFrames;
    expect(firstEvent).toMatchObject({ type: 'event', scope: 'app', seq: 1 });
    expect(secondEvent).toMatchObject({ type: 'event', scope: 'app', seq: 2 });
  });

  it('requires snapshot on epoch mismatch', async () => {
    t = buildTestApp();
    t.ctx.events.publishToScope('app', 'a', null);
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    const snapshotFrame = readFrame(ws);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: decodeTransportEpoch('old-epoch'), lastSeq: decodeTransportSeq(0) } },
    });

    expect(await snapshotFrame).toMatchObject({
      type: 'snapshot_required',
      scope: 'app',
      reason: 'epoch_mismatch',
      // Stage-2 §6: stamp the current server epoch + transport seq so the client
      // can commit its resume floor after reconcile (never stream_head_seq).
      epoch: t.ctx.events.epoch,
      currentSeq: t.ctx.events.currentSeq('app'),
    });
  });

  it('requires snapshot when the replay gap exceeds the buffer', async () => {
    t = buildTestApp();
    for (let i = 0; i < 201; i++) {
      t.ctx.events.publishToScope('app', 'ev', { i });
    }
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
    sockets.push(ws);

    const snapshotFrame = readFrame(ws);
    sendFrame(ws, {
      type: 'resume',
      scopes: { app: { epoch: t.ctx.events.epoch, lastSeq: decodeTransportSeq(0) } },
    });

    expect(await snapshotFrame).toMatchObject({
      type: 'snapshot_required',
      scope: 'app',
      reason: 'gap_too_large',
      // Stage-2 §6: transport seq baseline (the current transport counter, not
      // stream_head_seq).
      epoch: t.ctx.events.epoch,
      currentSeq: t.ctx.events.currentSeq('app'),
    });
  });

  it('closes active WebSocket clients during server shutdown', async () => {
    t = buildTestApp();
    server = await openServer(t);
    const { ws } = await connectAuthenticated(
      server.url,
      t.ctx.authSessions.issueSession({ userId: 'local' }).userToken,
    );
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
      refresh_token: null,
      child_sessions: {
        max_concurrent_per_parent: null,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };
    // Cleanup Commit B removed the in-process `ConversationManager`
    // runtime; embedded boot now dials the daemon's local outbound frame
    // socket for runtime/materialize (D5.a R4 unification). This test
    // exercises ws shutdown end-to-end (orthogonal to the runtime host),
    // so we point `outboundSocketPath` at a tmp path with no daemon
    // behind it — the adapter connect is best-effort (async, non-blocking)
    // and the test never spawns an agent, so no runtime intent is sent.
    runningBackend = await startBackend({
      mode: 'embedded',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: config,
      silverhandCliLauncher: { command: 'true', args: [] },
      logger: { info() {}, warn() {}, error() {} },
      outboundSocketPath: join(tmp, 'daemon-outbound.sock'),
    });

    const bootstrapToken = readFileSync(
      join(tmp, EMBEDDED_BOOTSTRAP_FILENAME),
      'utf8',
    ).trim();
    const bootstrapRes = await fetch(`${runningBackend.url}${authPaths.embeddedBootstrap}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: bootstrapToken }),
    });
    expect(bootstrapRes.status).toBe(200);
    const bootstrap = await bootstrapRes.json() as { user_token: string };

    const { ws } = await connectAuthenticated(
      runningBackend.url.replace(/^http:/, 'ws:') + EVENT_WS_PATH,
      bootstrap.user_token,
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
  const backendOrigin = `http://127.0.0.1:${port}`;
  // Mirror the embedded seed `startBackend` performs at bind time: the desktop
  // pins the WS `Origin` to the origin it reaches this backend at, so the
  // allowlist must trust that origin. These tests use `installEventWebSocketServer`
  // directly (no `startBackend`), so seed it here. Merge (don't overwrite) so a
  // test that pre-declares extra allowed origins keeps them.
  t.ctx.serverConfig = {
    ...t.ctx.serverConfig,
    url: backendOrigin,
    event_ws_allowed_origins: [
      ...(t.ctx.serverConfig.event_ws_allowed_origins ?? []),
      backendOrigin,
    ],
  };
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

async function connectAuthenticated(
  url: string,
  token: string,
  opts: { origin?: string } = {},
): Promise<{ ws: WebSocket; authenticated: ServerFrame }> {
  const origin = opts.origin ?? wsOrigin(url);
  const ws = new WebSocket(url, {
    headers: {
      Origin: origin,
      Cookie: `${EVENT_WS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
  });
  const authenticatedFrame = readFrame(ws);
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
  const authenticated = await authenticatedFrame;
  expect(authenticated.type).toBe('authenticated');
  return { ws, authenticated };
}

function wsOrigin(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.origin;
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
