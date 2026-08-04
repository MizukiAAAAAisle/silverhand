import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import {
  EVENT_WS_SESSION_COOKIE,
  X_SILVERHAND_PRINCIPAL_HEADER,
  apiPaths,
  decodeTransportSeq,
  encodeUserPrincipalHeader,
  type ClientFrame,
  type ServerFrame,
} from '@silverhand/shared';
import { EVENT_WS_PATH, installEventWebSocketServer } from '../../src/ws/ws-server.js';
import type { EventWsServerController } from '../../src/ws/ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { CURRENT_DESKTOP_EPOCH_HEADERS } from '../utils/desktop-client-epoch.js';

/**
 * Live delivery obeys the CURRENT authorization, not the verdict that was true
 * when the client subscribed (#task:1690).
 *
 * Every case below keeps ONE established WebSocket connection across the
 * authorization change: subscribe as a member, have SOMEONE ELSE end that
 * membership over HTTP, then publish on the same scopes. A reconnect or a
 * client-side `unsubscribe` would prove nothing — the point is precisely that a
 * malicious or wedged client never has to cooperate.
 *
 * The per-scope semantics are the existing ones and are asserted separately,
 * because losing membership is not one fact but two:
 *   - `conversation:<id>` rides `canReadConversation` (public-aware) — a public
 *     channel's content stream SURVIVES, a private one's stops;
 *   - `conversation-side:<id>` rides `canViewConversation` (membership-only) —
 *     it stops for both.
 *
 * The last two cases pin the OTHER entry point: recovery. Live delivery and
 * `resume` are two doors into the same stream, so both must answer from the one
 * `canSubscribeScope` — a second copy of the policy for replay would be a
 * bypass, and the asymmetry inside a single `resume` frame (public content
 * replays, member-only side plane refused) is that shared predicate talking
 * rather than a blanket post-removal stop.
 */

const OWNER = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') };
const VIEWER = 'local';

interface TestWsServer {
  url: string;
  controller: EventWsServerController;
  close(): Promise<void>;
}

describe('WS scope delivery authorization (#task:1690)', () => {
  let t: TestApp | null = null;
  let server: TestWsServer | null = null;
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

  /**
   * A workspace owned by `teammate` with `local` (the WS viewer) as a plain
   * member of one channel of the requested visibility.
   * `seedAllFixtureMemberships: false`: the permissive fixture triggers would
   * seed `local` as `owner`, and the removal route refuses a target who
   * outranks the caller — the gate under test would never be reached.
   */
  async function seedChannel(visibility: 'private' | 'public'): Promise<string> {
    const app = t!;
    const workspaceId = (await (await http(app).post(
      '/api/workspaces',
      { name: 'scope-authz', member_agent_ids: [] },
      { headers: OWNER },
    )).json() as any).workspace.id as string;
    expect(
      (await http(app).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: VIEWER },
        { headers: OWNER },
      )).status,
    ).toBe(201);
    return ((await (await http(app).post(
      apiPaths.workspaceChannels(workspaceId),
      {
        title: 'authz-room',
        member_agent_ids: [],
        member_user_ids: [VIEWER],
        visibility,
      },
      { headers: OWNER },
    )).json() as any).channel.id) as string;
  }

  async function subscribeBothPlanes(channelId: string): Promise<WebSocket> {
    const app = t!;
    const { ws } = await connectAuthenticated(
      server!.url,
      app.ctx.authSessions.issueSession({ userId: VIEWER }).userToken,
    );
    sockets.push(ws);
    for (const scope of [`conversation:${channelId}`, `conversation-side:${channelId}`]) {
      const subscribed = readFrame(ws);
      sendFrame(ws, { type: 'subscribe', scope });
      expect(await subscribed).toMatchObject({ type: 'subscribed', scope });
    }
    return ws;
  }

  /** Remove the viewer from the channel as the workspace owner — a THIRD party. */
  async function removeViewer(channelId: string): Promise<void> {
    const res = await http(t!).del(
      apiPaths.conversationHumanMember(channelId, VIEWER),
      { headers: OWNER },
    );
    expect(res.status).toBe(200);
  }

  /**
   * Put one event on each plane's replay buffer while the viewer is still a
   * member, draining the live copies, so a later `resume` has something it
   * COULD hand back — otherwise "no replay" would prove nothing.
   */
  async function bufferOnePerPlane(ws: WebSocket, channelId: string): Promise<void> {
    const drained = collectFrames(ws);
    t!.ctx.events.publish(channelId, {
      kind: 'message',
      payload: { message: { id: 'buffered' } },
    });
    t!.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'buffered' },
    });
    expect((await drained.settle()).map(frameKey)).toEqual([
      `conversation:${channelId}|message`,
      `conversation-side:${channelId}|agent_status`,
    ]);
  }

  /**
   * Ask to resume BOTH planes from the very beginning of the buffer. Side scope
   * first: a mistakenly-replayed side frame would then arrive BEFORE the content
   * one, so order alone distinguishes "refused" from "merely later".
   */
  function resumeBothPlanes(ws: WebSocket, channelId: string): void {
    const from = { epoch: t!.ctx.events.epoch, lastSeq: decodeTransportSeq(0) };
    sendFrame(ws, {
      type: 'resume',
      scopes: {
        [`conversation-side:${channelId}`]: from,
        [`conversation:${channelId}`]: from,
      },
    });
  }

  it('withholds both planes of a PRIVATE channel from the next frame on', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('private');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);

    const collected = collectFrames(ws);
    await removeViewer(channelId);
    // The removal's OWN post-commit fan-out (member-removed message on the
    // content stream, `conversation_members_changed` on the side plane) is
    // already past the gate: it publishes after the edge is gone.
    t.ctx.events.publish(channelId, { kind: 'message', payload: { message: { id: 'after-1' } } });
    t.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    });

    expect(await collected.settle()).toEqual([]);
  });

  it("keeps a PUBLIC channel's content stream but still cuts its member-only side plane", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('public');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);

    const duringRemoval = collectFrames(ws);
    await removeViewer(channelId);
    // The removal's OWN post-commit fan-out already obeys the new authorization:
    // the member-removed system message rides the content stream, which a public
    // non-member may still read, while `conversation_members_changed` on the
    // member-only side plane is withheld.
    expect((await duringRemoval.settle()).map(frameKey)).toEqual([
      `conversation:${channelId}|message`,
    ]);

    const collected = collectFrames(ws);
    // Side first, then content: if the side frame were merely late rather than
    // withheld, it would arrive BEFORE the content one (the bus fans out
    // synchronously in publish order), so the order pins the drop.
    t.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    });
    t.ctx.events.publish(channelId, { kind: 'message', payload: { message: { id: 'after-1' } } });

    const frames = await collected.settle();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'event',
      scope: `conversation:${channelId}`,
      kind: 'message',
      payload: { message: { id: 'after-1' } },
    });
  });

  it('resumes delivery when the viewer is added back, with no client round-trip', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('private');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);

    await removeViewer(channelId);
    const whileOut = collectFrames(ws);
    t.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'gone' },
    });
    expect(await whileOut.settle()).toEqual([]);

    // Authorization is re-evaluated per frame, so re-entry needs no `subscribe`:
    // the subscription is the client's INTEREST and it never went away.
    const whileBack = collectFrames(ws);
    expect(
      (await http(t).post(
        apiPaths.conversationMembers(channelId),
        { kind: 'human', user_id: VIEWER },
        { headers: OWNER },
      )).status,
    ).toBe(200);
    t.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'back' },
    });
    // The re-add's own fan-out (content message + side roster event) is already
    // flowing again, and so is the probe published right after it — all on the
    // subscription the client never re-declared.
    expect((await whileBack.settle()).map(frameKey)).toEqual([
      `conversation:${channelId}|message`,
      `conversation-side:${channelId}|conversation_members_changed`,
      `conversation-side:${channelId}|agent_status`,
    ]);
  });

  it('keeps delivering to a member who is still authorized (the gate is not a blanket stop)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('private');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);

    const collected = collectFrames(ws);
    t.ctx.events.publish(channelId, { kind: 'message', payload: { message: { id: 'still-here' } } });
    t.ctx.events.publishSide(channelId, {
      kind: 'agent_status',
      payload: { agent_id: 'a1', status: 'active' },
    });

    const frames = await collected.settle();
    expect(frames.map(f => (f as any).scope)).toEqual([
      `conversation:${channelId}`,
      `conversation-side:${channelId}`,
    ]);
  });

  it('answers a resume from the same predicate as live delivery: side plane refused, public content replayed', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('public');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);
    await bufferOnePerPlane(ws, channelId);

    await removeViewer(channelId);
    const collected = collectFrames(ws);
    resumeBothPlanes(ws, channelId);
    const frames = await collected.settle();

    // The member-only plane is refused outright — no replay, and no
    // `snapshot_required` either, which would have been a recovery invitation.
    expect(frames.filter(f => f.type !== 'event')).toEqual([
      {
        type: 'error',
        code: 'forbidden',
        message: `not allowed to subscribe to conversation-side:${channelId}`,
      },
    ]);
    // …while the public content plane still replays what it buffered.
    const replayed = frames.filter(f => f.type === 'event');
    expect(replayed.map(frameKey)).toContain(`conversation:${channelId}|message`);
    expect(new Set(replayed.map(f => (f as any).scope))).toEqual(
      new Set([`conversation:${channelId}`]),
    );
  });

  it('refuses BOTH planes on resume for a private channel (replay is not a second policy)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const channelId = await seedChannel('private');
    server = await openServer(t);
    const ws = await subscribeBothPlanes(channelId);
    await bufferOnePerPlane(ws, channelId);

    await removeViewer(channelId);
    const collected = collectFrames(ws);
    resumeBothPlanes(ws, channelId);
    const frames = await collected.settle();

    expect(frames.filter(f => f.type === 'event')).toEqual([]);
    expect(frames.map(f => (f as any).code)).toEqual(['forbidden', 'forbidden']);
  });
});

async function openServer(t: TestApp): Promise<TestWsServer> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const controller = installEventWebSocketServer(httpServer, t.ctx, { pingIntervalMs: 0 });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const backendOrigin = `http://127.0.0.1:${port}`;
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
      if (httpServer.listening) {
        await new Promise<void>(resolve => httpServer.close(() => resolve()));
      }
    },
  };
}

async function connectAuthenticated(
  url: string,
  token: string,
): Promise<{ ws: WebSocket; authenticated: ServerFrame }> {
  const parsed = new URL(url);
  parsed.protocol = 'http:';
  parsed.pathname = '/';
  const ws = new WebSocket(url, {
    headers: {
      ...CURRENT_DESKTOP_EPOCH_HEADERS,
      Origin: parsed.origin,
      Cookie: `${EVENT_WS_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
  });
  const authenticatedFrame = readFrame(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const authenticated = await authenticatedFrame;
  expect(authenticated.type).toBe('authenticated');
  return { ws, authenticated };
}

function sendFrame(ws: WebSocket, frame: ClientFrame): void {
  ws.send(JSON.stringify(frame));
}

/** `scope|kind` — the two fields that make a frame's identity in these cases. */
function frameKey(frame: ServerFrame): string {
  const f = frame as { scope?: string; kind?: string };
  return `${f.scope ?? frame.type}|${f.kind ?? ''}`;
}

async function readFrame(ws: WebSocket): Promise<ServerFrame> {
  const data = await new Promise<RawData>((resolve, reject) => {
    ws.once('message', resolve);
    ws.once('error', reject);
  });
  return JSON.parse(data.toString()) as ServerFrame;
}

/**
 * Start recording frames NOW and stop after the socket has been quiet long
 * enough that a delivered frame would have arrived (fan-out is synchronous, so
 * this is one macrotask plus slack — the assertion is "nothing came", which
 * needs a window rather than a race against a specific frame).
 */
function collectFrames(ws: WebSocket): { settle(): Promise<ServerFrame[]> } {
  const frames: ServerFrame[] = [];
  const onMessage = (data: RawData) => {
    frames.push(JSON.parse(data.toString()) as ServerFrame);
  };
  ws.on('message', onMessage);
  return {
    async settle() {
      await new Promise<void>(resolve => setTimeout(resolve, 120));
      ws.off('message', onMessage);
      return frames;
    },
  };
}
