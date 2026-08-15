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
 *       perimeter must drop + warn, leaving zero residue: no state
 *       slot added to the fanout's `states` Map and no publish on
 *       either conv. Cindy tightening (1) asked for a fresh fixture so
 *       the residue is unambiguous; post-#task:1966 the baseline is no
 *       longer zero (attaching means declaring, and that `ready` is an
 *       admitted event that owns its slot), so the residue is asserted
 *       as a delta against the post-attach baseline.
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
 *   I5 disconnect isolation (cache cleanup, not just controller map)
 *       Daemon X drives the full `ready` → `runtime_status` hydrate
 *       round-trip so the fanout's `RunStateCache` is observably
 *       populated (`getAgentRunStates(convX).length === 1`). Then
 *       daemon X disconnects (raw `ws.close()`). Once the server
 *       observes the close: `connectionIdForHost(X)` becomes null,
 *       `getAgentRunStates(convX) === []` (proof
 *       `state.cache.clearAll()` + `coordinator.clearRuntime` ran on
 *       the disconnect path — Cindy `mZoTQikfvPoJ2C45` P1),
 *       `connectionIdForHost(Y)` is unchanged, daemon Y's
 *       legitimate event still flows to conv Y SSE. We deliberately
 *       do NOT require the `states` Map slot itself to be deleted —
 *       production semantics preserve the slot, and Cindy's review
 *       OK'd that. (Single direction is sufficient — we're proving
 *       cleanup of one host's slot doesn't touch the other; symmetry
 *       is implied.)
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
import { fixedConversationTitle } from '@silverhand/shared';
import { createSqliteHostPersistence } from '../../src/repos/host-uow.js';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  KNOWN_CAPABILITIES_V1,
  encodeOutboundFrame,
  type OutboundDaemonToServerEventFrame,
} from '@silverhand/host';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import type { BackendLogger } from '../../src/context.js';
import { HostTokenService } from '../../src/auth/host-token.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { conversationRuntimePrincipal } from '../../src/auth/runtime-principal.js';
import type { EventPublisher } from '../../src/runtime/event-handler.js';
import { createRuntimeFanoutDbDeps } from '../../src/adapters/runtime-fanout.js';
import { OutboundRuntimeEventFanout } from '../../src/runtime/outbound-event-fanout.js';
import { makeDaemonInstanceKey } from '../../src/runtime/daemon-instance-key.js';
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
  agentTokens: AgentTokenStore;
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
  const tokens = new HostTokenService(createSqliteHostPersistence(db));
  const hostXToken = tokens.issueHostToken({ hostId: hostXRow.id }).hostToken;
  const hostYToken = tokens.issueHostToken({ hostId: hostYRow.id }).hostToken;

  // Seed a workspace + channel + agent owned by each host. We use
  // the repos directly — going through HTTP routes adds noise
  // (host-mismatch preflight is C3's coverage, not C6's).
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);

  const wsXRow = workspaces.insert({
    name: 'c6-x',
    description: null,
  });
  const channelX = conversations.insertChannel({
    workspaceId: wsXRow.id,
    title: fixedConversationTitle('c6-x'),
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
  });
  const channelY = conversations.insertChannel({
    workspaceId: wsYRow.id,
    title: fixedConversationTitle('c6-y'),
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
    publishSide: (conv, payload) =>
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
  const agentTokens = new AgentTokenStore();
  const fanout = new OutboundRuntimeEventFanout({
    ...createRuntimeFanoutDbDeps({ db, events: publisher, logger }),
    events: publisher,
    transport: () => controller,
    logger,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens,
    activityLog: null,
  });
  controller = installHostWebSocketServer(httpServer, t.ctx, {
    hostTokenVerifier: new HostTokenService(createSqliteHostPersistence(t.ctx.db)),
    hosts: new HostRepo(t.ctx.db),
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
    agentTokens,
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

/**
 * #task:1966 — an authenticated socket is only a transport slot. The
 * daemon becomes an ATTACHMENT (visible to the controller's business
 * readers and admitted by the fanout's staleness gate) once a
 * COMPATIBLE `ready` lands. Every invariant below wants an admitted
 * daemon, so connect + declare + wait for the attachment is one step.
 * `daemonPid` is per-host so the two daemon instance keys differ.
 */
async function attachAndRecord(
  fix: TwoDaemonFixture,
  host: HostInfo,
  daemonPid: number,
): Promise<RecordedSocket> {
  const rec = await connectAndRecord(fixtureUrl(fix), host.hostToken);
  rec.ws.send(encodeOutboundFrame(readyEvent(daemonPid)));
  await waitFor(() => fix.controller.connectionIdForHost(host.id) !== null);
  const claim = new RuntimeSlotRepo(fix.t.ctx.db).claimGeneration({
    scope: {
      kind: 'conversation',
      conversationId: host.channelId,
      agentId: host.agentId,
    },
    daemonInstanceId: makeDaemonInstanceKey(daemonPid, 1700000000000),
  });
  if (!claim) throw new Error('failed to claim runtime fixture');
  fix.agentTokens.issue(conversationRuntimePrincipal({
    conversationId: host.channelId,
    agentId: host.agentId,
    generation: claim.generation,
    daemonInstanceId: makeDaemonInstanceKey(daemonPid, 1700000000000),
  }));
  return rec;
}

function isRuntimeStatusCommand(frame: Record<string, unknown>): boolean {
  return (
    frame.direction === 'server_to_daemon' &&
    frame.type === 'command' &&
    frame.kind === 'runtime_status'
  );
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
    runtime_generation: 1,
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_parsed_event',
    runtime_scope: { kind: 'conversation', conversation_id: conversationId, agent_id: agentId },
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
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
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

    const recX = await attachAndRecord(fix, fix.hostX, 101);
    sockets.push(recX.ws);
    const recY = await attachAndRecord(fix, fix.hostY, 102);
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

    const recX = await attachAndRecord(fix, fix.hostX, 101);
    sockets.push(recX.ws);
    const recY = await attachAndRecord(fix, fix.hostY, 102);
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

  it('I3 — cross-host event from daemon X targeting host Y agent/conv is dropped; the rejected frame leaves zero residue (no new state slot, no publish)', async () => {
    // Cindy `vz7fAB040wHP0XfD` tightening (1) originally read the
    // residue as `states.size === 0`, on the premise "attach != state
    // slot". Post-#task:1966 attaching IS declaring: the compatible
    // `ready` that makes the daemon reachable is itself an admitted
    // event, so each attached host legitimately owns a slot before the
    // mismatch frame is sent — and without an attachment the frame
    // would never reach the perimeter at all (the staleness gate drops
    // it first, proving nothing about C5). The residue claim is
    // therefore pinned as a DELTA against the post-attach baseline: the
    // rejected frame must add no slot and publish nothing.
    fix = await makeTwoDaemonFixture();

    const recX = await attachAndRecord(fix, fix.hostX, 101);
    sockets.push(recX.ws);
    const recY = await attachAndRecord(fix, fix.hostY, 102);
    sockets.push(recY.ws);

    const slotsBefore = fanoutStatesSize(fix.fanout);
    const eventsBefore = fix.events.length;

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

    // Drop confirmed: no publish on either conv, no new state slot,
    // warn carries the C5 reason taxonomy.
    expect(fix.events.slice(eventsBefore)).toEqual([]);
    expect(fanoutStatesSize(fix.fanout)).toBe(slotsBefore);
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

    const recX = await attachAndRecord(fix, fix.hostX, 101);
    sockets.push(recX.ws);
    const recY = await attachAndRecord(fix, fix.hostY, 102);
    sockets.push(recY.ws);

    // #task:1966 — attaching now means declaring, and each admitted
    // `ready` triggers the fanout's OWN hydrate `runtime_status` on that
    // host. Drain both hydrate commands and reset the recorders so the
    // id/kind-scoped assertions below see only the dispatched command.
    await untilFrame(recX, isRuntimeStatusCommand);
    await untilFrame(recY, isRuntimeStatusCommand);
    recX.frames.length = 0;
    recY.frames.length = 0;

    // Dispatch runtime_status to host Y. The controller writes the
    // command frame to host Y's WS — daemon Y receives + responds.
    const pending = fix.controller.sendCommand(
      fix.hostY.id,
      'runtime_status',
      {},
      { timeoutMs: 1_000 },
    );

    // Wait until daemon Y observes the runtime_status command.
    const cmdFrame = await untilFrame(recY, isRuntimeStatusCommand);
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

  // ── I5 disconnect isolation (cache cleanup, not just controller map) ───

  it('I5 — daemon X disconnect clears host X runtime cache / live state; daemon Y connection + cache + publishes unchanged', async () => {
    fix = await makeTwoDaemonFixture();

    // Cindy `mZoTQikfvPoJ2C45` P1: I5 must actually pin fanout
    // cache cleanup, not just controller map removal. Drive the
    // full `ready` → `runtime_status` hydrate round-trip so host X's
    // RunStateCache observably has content (not just an empty
    // state slot from a parsed_event-only path):
    //
    //   1. Daemon X's attach `ready` (#task:1966 — the attachment IS
    //      the declaration) triggers the fanout's onDaemonReady, which
    //      hydrates via `bridge.runtimeStatus()` → the controller
    //      dispatches a `runtime_status` command frame to daemon X.
    //   2. Daemon X's recorder catches the command, replies with a
    //      snapshot containing a runtime + populated run_state.
    //   3. Backend's RuntimeEventHandler applies the snapshot via
    //      `cache.applyRuntimeState`, populating
    //      `state.cache.list()`.
    //   4. We assert `getAgentRunStates(convX).length === 1` — proof
    //      the cache really has content.
    //
    // Then disconnect daemon X and assert
    // `getAgentRunStates(convX) === []` — proof
    // `OutboundRuntimeEventFanout.onDisconnect` cleared inner cache
    // / coordinator refs (it preserves the `states` Map slot itself
    // by current production semantics; we don't require slot
    // deletion).
    const recX = await attachAndRecord(fix, fix.hostX, 123);
    sockets.push(recX.ws);
    const recY = await attachAndRecord(fix, fix.hostY, 124);
    sockets.push(recY.ws);

    const connY = fix.controller.connectionIdForHost(fix.hostY.id);
    expect(connY).not.toBeNull();

    const statusCmd = await untilFrame(recX, isRuntimeStatusCommand);
    recX.ws.send(
      encodeOutboundFrame({
        direction: 'daemon_to_server',
        type: 'command_response',
        id: statusCmd.id as string,
        kind: 'runtime_status',
        result: {
          runtimes: [
            {
              runtime_scope: {
                kind: 'conversation',
                conversation_id: fix.hostX.channelId,
                agent_id: fix.hostX.agentId,
              },
              conversation_id: fix.hostX.channelId,
              agent_id: fix.hostX.agentId,
              runtime_generation: 1,
              pid: 123,
              phase: 'ready',
              run_state: {
                runId: 'run-x-1',
                agentId: fix.hostX.agentId,
                conversationId: fix.hostX.channelId,
                status: 'thinking',
                startedAt: 1700000000000,
                updatedAt: 1700000000000,
                lastActivityAt: 1700000000000,
              },
              started_at: 1700000000000,
            },
          ],
        },
      }),
    );

    // Cache is observably populated.
    await waitFor(
      () => fix!.fanout.getAgentRunStates(fix!.hostX.channelId).length === 1,
    );
    expect(
      fix.fanout.getAgentRunStates(fix.hostX.channelId)[0],
    ).toMatchObject({
      runId: 'run-x-1',
      conversationId: fix.hostX.channelId,
      agentId: fix.hostX.agentId,
      status: 'thinking',
    });

    // Disconnect daemon X.
    recX.ws.close();
    await waitFor(
      () => fix!.controller.connectionIdForHost(fix!.hostX.id) === null,
    );

    // **The P1 assertion**: host X's runtime cache is cleared.
    // `getAgentRunStates` filters by populated runState across all
    // host state slots' caches; an empty result means
    // `state.cache.clearAll()` ran (and `coordinator.clearRuntime`
    // for every entry, by the same code path). The `states` Map
    // slot may persist (production semantics) but its inner cache
    // / live refs are gone.
    expect(fix.fanout.getAgentRunStates(fix.hostX.channelId)).toEqual([]);

    // Y's connection + cache untouched.
    expect(fix.controller.connectionIdForHost(fix.hostY.id)).toBe(connY);
    expect(fix.controller.activeConnectionCount()).toBe(1);

    // Y can still drive a legitimate event end-to-end (publisher
    // bus didn't break, perimeter still admits same-host frames).
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
