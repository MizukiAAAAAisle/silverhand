/**
 * D4.c C6 — two-daemon isolation e2e.
 *
 * Spins up the real `host-ws-server` multiplexer + a real
 * `OutboundRuntimeEventFanout` and attaches two raw WebSocket
 * clients, each authenticated as a different host. Asserts the
 * five host-isolation invariants C1-C5 collectively imply:
 *
 *   I1 simultaneous attach
 *       Both connections succeed, `activeConnectionCount` is 2,
 *       `connectionIdForHost(X) !== connectionIdForHost(Y)`, both
 *       non-null.
 *
 *   I2 SSE fanout isolation (bidirectional)
 *       Daemon X emits a legitimate `runtime_parsed_event` for its
 *       own `(conv X, agent X)` → publisher records ONE event on
 *       conv X, zero on conv Y. Daemon Y emits its own → publisher
 *       records ONE event on conv Y, zero on conv X. Cindy
 *       `vz7fAB040wHP0XfD` tightening (3): bidirectional rules out a
 *       map / recorder helper that only works one way.
 *
 *   I3 perimeter under live multiplex (fresh fixture)
 *       Daemon X emits a frame referencing host Y's agent + conv. C5
 *       perimeter must drop + warn, with NO state slot lazy-created
 *       in the fanout's `states` Map. Cindy tightening (1): use a
 *       fresh fixture (zero state baseline) so attach ≠ state slot
 *       and the post-mismatch `states.size === 0` is unambiguous.
 *
 *   I4 outbound command routing
 *       Backend dispatches `runtime_status` to host Y. Daemon Y's
 *       socket recorder receives a frame with the matching command
 *       id + kind; daemon X's recorder, drained over a bounded
 *       window, contains NO frame with that command id or that
 *       kind. Cindy tightening (2): assertions are correlation-id
 *       scoped, not "X received nothing" — heartbeat / maintenance
 *       frames must not fail the test.
 *
 *   I5 disconnect isolation
 *       Daemon X disconnects (raw `ws.close()`). Once the server
 *       observes the close: `connectionIdForHost(X)` becomes null,
 *       `connectionIdForHost(Y)` is unchanged, and daemon Y's
 *       legitimate event still flows to conv Y SSE. (Single
 *       direction is sufficient — we're proving cleanup of one
 *       host's slot doesn't touch the other; symmetry is implied.)
 *
 * Out of scope (deferred to C9 / acceptance):
 *   - Real driver / agent CLI subprocess.
 *   - Full `runtime_start` spawn round-trip.
 *   - Inbox replay round-trip.
 *   - DB-level commit verification.
 *
 * R4 boundary: this IPC is local supervisor/control, not
 * server↔daemon formal semantics. C6 only verifies the WS
 * multiplexer is host-isolated; no wire envelope shape change, no
 * new wire fields.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  KNOWN_CAPABILITIES_V1,
  encodeOutboundFrame,
  type OutboundDaemonToServerEventFrame,
} from '@silverhand/host';
import type { BackendLogger } from '../../src/context.js';
import { HostTokenService } from '../../src/auth/host-token.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import { OutboundRuntimeEventFanout } from '../../src/runtime/outbound-event-fanout.js';
import {
  HOST_WS_PATH,
  installHostWebSocketServer,
  type HostWsServerController,
} from '../../src/ws/host-ws-server.js';
import { buildTestApp, type TestApp } from '../utils/app.js';

interface RecordedSocket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
}

interface TwoDaemonFixture {
  t: TestApp;
  httpServer: HttpServer;
  controller: HostWsServerController;
  fanout: OutboundRuntimeEventFanout;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  warns: Array<{ obj: unknown; msg: string | undefined }>;
  hostX: HostInfo;
  hostY: HostInfo;
  cleanup(): Promise<void>;
}

interface HostInfo {
  id: string;
  hostToken: string;
  channelId: string;
  agentId: string;
}

async function makeTwoDaemonFixture(): Promise<TwoDaemonFixture> {
  const t = buildTestApp({ deploymentMode: 'standalone' });
  const db = t.ctx.db;

  // Host X = the bootstrapped local host (already claimed by the
  // viewer in `openTestDb`).
  const hostXRow = new HostRepo(db).getOwnedLocalForUser(t.viewerUserId)!;
  // Host Y = a second local host owned by `teammate` (a fixture
  // user seeded by `openTestDb`). The owner doesn't matter for the
  // multiplexer; we only need a distinct host id.
  const hostYRow = new HostRepo(db).create('local-teammate', 'local', {
    userId: 'teammate',
    installationId: 'install-teammate',
    lastSeenAt: Date.now(),
  });

  // Issue a long-lived host token for each.
  const tokens = new HostTokenService(db);
  const hostXToken = tokens.issueHostToken({ hostId: hostXRow.id }).hostToken;
  const hostYToken = tokens.issueHostToken({ hostId: hostYRow.id }).hostToken;

  // Seed a workspace + channel + agent owned by each host. We use
  // the repos directly — going through HTTP routes adds noise
  // (host-mismatch preflight is C3's coverage, not C6's).
  const workspacesRoot = join(tmpdir(), 'silverhand-c6-two-daemon');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);

  const wsXRow = workspaces.insert({
    name: 'c6-x',
    description: null,
    workspacePath: workspaces.workspacePathFor('c6-x'),
    workspaceHostId: hostXRow.id,
  });
  const channelX = conversations.insertChannel({
    workspaceId: wsXRow.id,
    workspacePath: wsXRow.workspace_path,
    title: 'c6-x',
  });
  const agentX = agents.create(
    { name: 'c6-agent-x', runtime: 'claude', host_id: hostXRow.id },
    hostXRow.id,
    t.viewerUserId,
  );
  conversations.addAgent(channelX.id, agentX.id);

  const wsYRow = workspaces.insert({
    name: 'c6-y',
    description: null,
    workspacePath: workspaces.workspacePathFor('c6-y'),
    workspaceHostId: hostYRow.id,
  });
  const channelY = conversations.insertChannel({
    workspaceId: wsYRow.id,
    workspacePath: wsYRow.workspace_path,
    title: 'c6-y',
  });
  const agentY = agents.create(
    { name: 'c6-agent-y', runtime: 'claude', host_id: hostYRow.id },
    hostYRow.id,
    'teammate',
  );
  conversations.addAgent(channelY.id, agentY.id);

  // Recording publisher + buffered logger so we can inspect SSE
  // publications and warn frames without a real ScopeEventBus
  // subscription. The fanout's contract is "publish on the
  // EventPublisher we hand it"; injecting a recorder here matches
  // what `outbound-event-fanout.test.ts` already does.
  const events: TwoDaemonFixture['events'] = [];
  const publisher: EventPublisher = {
    publish: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
  };
  const warns: TwoDaemonFixture['warns'] = [];
  const logger: BackendLogger = {
    info: () => {},
    warn: (obj, msg) => warns.push({ obj, msg }),
    error: () => {},
  };

  // Open the real HTTP server + WS multiplexer, then build the
  // fanout against it. The `transport: () => controller` indirection
  // matches production wiring (the fanout is constructed before the
  // controller in some boot paths).
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  let controller: HostWsServerController | null = null;
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => controller,
    logger,
    silverhandDir: join(tmpdir(), 'silverhand-c6-silverhand'),
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    serverUrl: () => 'http://127.0.0.1:1',
    proxyPolicy: () => ({ url: null, allowlist: [] }),
    activityLog: null,
  });
  controller = installHostWebSocketServer(httpServer, t.ctx, {
    eventSink: fanout,
    pingIntervalMs: 0,
  });

  await new Promise<void>(resolve =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );

  return {
    t,
    httpServer,
    controller: controller!,
    fanout,
    events,
    warns,
    hostX: {
      id: hostXRow.id,
      hostToken: hostXToken,
      channelId: channelX.id,
      agentId: agentX.id,
    },
    hostY: {
      id: hostYRow.id,
      hostToken: hostYToken,
      channelId: channelY.id,
      agentId: agentY.id,
    },
    cleanup: async () => {
      await controller!.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      t.cleanup();
    },
  };
}

function fixtureUrl(fix: TwoDaemonFixture): string {
  const port = (fix.httpServer.address() as AddressInfo).port;
  return `ws://127.0.0.1:${port}${HOST_WS_PATH}`;
}

async function connectAndRecord(
  url: string,
  hostToken: string,
): Promise<RecordedSocket> {
  const ws = new WebSocket(url, {
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.off('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      ws.off('open', onOpen);
      reject(err);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
  const frames: Array<Record<string, unknown>> = [];
  // Async recorder — pushes every JSON-decodable frame into the
  // buffer. Tests await on `untilFrame(rec, predicate)` to block
  // until a specific frame lands.
  ws.on('message', (data: RawData) => {
    const text = data.toString('utf8');
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      frames.push(parsed);
    } catch {
      // ignore non-JSON frames — production daemons never send
      // those; if they appear they're outside our test surface.
    }
  });
  return { ws, frames };
}

async function untilFrame(
  rec: RecordedSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 1_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = rec.frames.find(predicate);
    if (hit) return hit;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('untilFrame: predicate did not match within timeout');
}

async function settle(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function legitimateParsedEvent(
  conversationId: string,
  agentId: string,
  sessionId: string,
): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_parsed_event',
    conversation_id: conversationId,
    agent_id: agentId,
    parsed: { kind: 'session_init', sessionId },
    ts: 1700000000000,
  };
}

function readyEvent(daemonPid: number): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: 1,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: `instance-${daemonPid}`,
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    daemon_pid: daemonPid,
    started_at: 1700000000000,
  };
}

function fanoutStatesSize(fanout: OutboundRuntimeEventFanout): number {
  return (fanout as unknown as { states: Map<string, unknown> }).states.size;
}

describe('D4.c C6 — two-daemon isolation e2e', () => {
  let fix: TwoDaemonFixture | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    sockets.length = 0;
    await fix?.cleanup();
    fix = null;
  });

  // ── I1 simultaneous attach ───────────────────────────────────

  it('I1 — both daemons attach simultaneously with distinct connection ids', async () => {
    fix = await makeTwoDaemonFixture();
    const url = fixtureUrl(fix);

    const recX = await connectAndRecord(url, fix.hostX.hostToken);
    sockets.push(recX.ws);
    const recY = await connectAndRecord(url, fix.hostY.hostToken);
    sockets.push(recY.ws);

    expect(fix.controller.activeConnectionCount()).toBe(2);
    const connX = fix.controller.connectionIdForHost(fix.hostX.id);
    const connY = fix.controller.connectionIdForHost(fix.hostY.id);
    expect(connX).not.toBeNull();
    expect(connY).not.toBeNull();
    expect(connX).not.toBe(connY);
  });

  // ── I2 SSE fanout isolation (bidirectional) ─────────────────

  it('I2 — daemon X event publishes to conv X only; daemon Y event publishes to conv Y only (bidirectional)', async () => {
    fix = await makeTwoDaemonFixture();
    const url = fixtureUrl(fix);

    const recX = await connectAndRecord(url, fix.hostX.hostToken);
    sockets.push(recX.ws);
    const recY = await connectAndRecord(url, fix.hostY.hostToken);
    sockets.push(recY.ws);

    // Daemon X emits its own legitimate frame.
    recX.ws.send(
      encodeOutboundFrame(
        legitimateParsedEvent(fix.hostX.channelId, fix.hostX.agentId, 'sess-x'),
      ),
    );
    // Wait for the publish to land.
    await waitFor(() =>
      fix!.events.some(
        e => e.conv === fix!.hostX.channelId && e.kind === 'agent_event',
      ),
    );

    // Daemon Y emits its own legitimate frame.
    recY.ws.send(
      encodeOutboundFrame(
        legitimateParsedEvent(fix.hostY.channelId, fix.hostY.agentId, 'sess-y'),
      ),
    );
    await waitFor(() =>
      fix!.events.some(
        e => e.conv === fix!.hostY.channelId && e.kind === 'agent_event',
      ),
    );

    const onConvX = fix.events.filter(
      e => e.conv === fix!.hostX.channelId && e.kind === 'agent_event',
    );
    const onConvY = fix.events.filter(
      e => e.conv === fix!.hostY.channelId && e.kind === 'agent_event',
    );
    // Each conv saw EXACTLY its own event — no cross-pollination.
    expect(onConvX.length).toBe(1);
    expect(onConvY.length).toBe(1);
    // No perimeter warns on the legitimate path.
    expect(perimeterWarns(fix.warns)).toEqual([]);
  });

  // ── I3 perimeter under live multiplex (fresh fixture) ───────

  it('I3 — cross-host event from daemon X targeting host Y agent/conv is dropped; states.size stays 0 (fresh fixture, attach != state slot)', async () => {
    // Cindy `vz7fAB040wHP0XfD` tightening (1): fresh fixture so
    // there is zero baseline state slot. Attach itself does NOT
    // create a state slot — that only happens on
    // `stateForHost(hostId)` inside an admitted event. With no
    // legitimate event sent first, post-mismatch `states.size`
    // must be exactly 0.
    fix = await makeTwoDaemonFixture();
    const url = fixtureUrl(fix);

    const recX = await connectAndRecord(url, fix.hostX.hostToken);
    sockets.push(recX.ws);
    const recY = await connectAndRecord(url, fix.hostY.hostToken);
    sockets.push(recY.ws);

    // Sanity: attach alone hasn't built a fanout state slot.
    expect(fanoutStatesSize(fix.fanout)).toBe(0);

    // Daemon X sends a frame referencing host Y's agent + conv.
    // C5 step (2) `agent.host_id !== hostId` rejects.
    recX.ws.send(
      encodeOutboundFrame(
        legitimateParsedEvent(
          fix.hostY.channelId,
          fix.hostY.agentId,
          'sess-cross',
        ),
      ),
    );

    // Wait for the perimeter warn to land (proxy for "the frame
    // was processed").
    await waitFor(() =>
      fix!.warns.some(
        w =>
          isRecord(w.obj) &&
          w.obj.action === 'outbound_event_perimeter_mismatch',
      ),
    );

    // Drop confirmed: zero SSE on either conv, zero state slot,
    // warn carries the C5 reason taxonomy.
    expect(fix.events).toEqual([]);
    expect(fanoutStatesSize(fix.fanout)).toBe(0);
    const warns = perimeterWarns(fix.warns);
    expect(warns.length).toBe(1);
    expect(warns[0]!.obj).toMatchObject({
      connectionHostId: fix.hostX.id,
      agentId: fix.hostY.agentId,
      agentHostId: fix.hostY.id,
      reason: 'agent_host_mismatch',
      action: 'outbound_event_perimeter_mismatch',
    });
  });

  // ── I4 outbound command routing ─────────────────────────────

  it('I4 — controller.sendCommand(hostY, ...) routes ONLY to daemon Y; daemon X recorder never sees the same command id (Cindy tightening: id-scoped, not "received nothing")', async () => {
    fix = await makeTwoDaemonFixture();
    const url = fixtureUrl(fix);

    const recX = await connectAndRecord(url, fix.hostX.hostToken);
    sockets.push(recX.ws);
    const recY = await connectAndRecord(url, fix.hostY.hostToken);
    sockets.push(recY.ws);

    // Dispatch runtime_status to host Y. The controller writes the
    // command frame to host Y's WS — daemon Y receives + responds.
    const pending = fix.controller.sendCommand(
      fix.hostY.id,
      'runtime_status',
      {},
      { timeoutMs: 1_000 },
    );

    // Wait until daemon Y observes the runtime_status command.
    const cmdFrame = await untilFrame(
      recY,
      f =>
        f.direction === 'server_to_daemon' &&
        f.type === 'command' &&
        f.kind === 'runtime_status',
    );
    const cmdId = cmdFrame.id as string;

    // Reply on daemon Y's socket so the controller promise resolves.
    recY.ws.send(
      encodeOutboundFrame({
        direction: 'daemon_to_server',
        type: 'command_response',
        id: cmdId,
        kind: 'runtime_status',
        result: { runtimes: [] },
      }),
    );
    await pending;

    // Bounded settle window so any in-flight maintenance frame on
    // daemon X has a chance to arrive before we assert.
    await settle(50);

    // Cindy tightening (2): assertion is correlation-id /
    // kind-scoped, NOT "X received zero frames". Heartbeat,
    // close-frame echoes, or other non-targeted frames must not
    // fail the test.
    const xSawTarget = recX.frames.find(
      f => f.id === cmdId || (f.type === 'command' && f.kind === 'runtime_status'),
    );
    expect(xSawTarget).toBeUndefined();
  });

  // ── I5 disconnect isolation ─────────────────────────────────

  it('I5 — daemon X disconnect clears host X slot only; daemon Y stays attached and its events still publish', async () => {
    fix = await makeTwoDaemonFixture();
    const url = fixtureUrl(fix);

    const recX = await connectAndRecord(url, fix.hostX.hostToken);
    sockets.push(recX.ws);
    const recY = await connectAndRecord(url, fix.hostY.hostToken);
    sockets.push(recY.ws);

    const connY = fix.controller.connectionIdForHost(fix.hostY.id);
    expect(connY).not.toBeNull();

    // Drive a legitimate daemon X event so host X actually has a
    // fanout state slot to clear on disconnect (otherwise the
    // disconnect path is a no-op for the cache and we'd be
    // testing nothing).
    recX.ws.send(
      encodeOutboundFrame(
        legitimateParsedEvent(fix.hostX.channelId, fix.hostX.agentId, 'sess-x'),
      ),
    );
    await waitFor(() =>
      fix!.events.some(
        e => e.conv === fix!.hostX.channelId && e.kind === 'agent_event',
      ),
    );

    // Disconnect daemon X.
    recX.ws.close();
    await waitFor(
      () => fix!.controller.connectionIdForHost(fix!.hostX.id) === null,
    );

    // Y's connection is unchanged — same connectionId, still
    // active.
    expect(fix.controller.connectionIdForHost(fix.hostY.id)).toBe(connY);
    expect(fix.controller.activeConnectionCount()).toBe(1);

    // Y can still drive a legitimate event end-to-end.
    const eventsBefore = fix.events.length;
    recY.ws.send(
      encodeOutboundFrame(
        legitimateParsedEvent(
          fix.hostY.channelId,
          fix.hostY.agentId,
          'sess-y-after-x-disconnect',
        ),
      ),
    );
    await waitFor(() =>
      fix!.events.some(
        (e, i) =>
          i >= eventsBefore &&
          e.conv === fix!.hostY.channelId &&
          e.kind === 'agent_event',
      ),
    );
    expect(perimeterWarns(fix.warns)).toEqual([]);
  });
});

// ── helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function perimeterWarns(
  warns: ReadonlyArray<{ obj: unknown; msg: string | undefined }>,
): Array<{ obj: unknown; msg: string | undefined }> {
  return warns.filter(
    w =>
      isRecord(w.obj) &&
      (w.obj.action === 'outbound_event_perimeter_mismatch' ||
        w.obj.action === 'outbound_event_unknown_agent'),
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: predicate did not become true within timeout');
}

// `readyEvent` is exported for symmetry with single-host tests but
// currently unused — daemon-level frames are not exercised in the
// isolation invariants. Keeping the helper makes future host-level
// tests (D5) shorter.
void readyEvent;
