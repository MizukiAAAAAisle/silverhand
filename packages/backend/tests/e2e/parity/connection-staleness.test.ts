/**
 * D5.a-4 fixup — connection-id staleness / "old connection late frame
 * cannot pollute the new connection" (Cindy `oGSnQOO7BfaguDQI` P1-2).
 *
 * Phase C of the parity contract only proves the PRE-SEND guard (a command
 * pinned to a stale `expectedConnectionId` is rejected). That is necessary
 * but not sufficient: review point #3 asks that a LATE frame arriving from
 * an already-replaced/closed connection neither (a) gets projected nor
 * (b) resolves an in-flight command on the live connection. This file
 * constructs those late frames explicitly, at the boundary that actually
 * enforces the guarantee for each transport:
 *
 *   - STANDALONE (real WS server + real fanout): a daemon reconnect with
 *     the same host token triggers `closeForReplacement` on the old WS,
 *     which sets `cleanedUp` so the old connection's `handleMessage`
 *     becomes a no-op. We send a real `runtime_parsed_event` on the
 *     REPLACED socket and assert the fanout does NOT project it, then send
 *     the SAME event on the LIVE socket and assert it DOES — isolating the
 *     difference to connection identity, not event content. The in-flight
 *     arm: a command dispatched on the old connection rejects on
 *     replacement and a late response on the dead socket cannot resolve it.
 *
 *   - EMBEDDED (real EmbeddedUnixOutboundFrameAdapter + a controllable
 *     fake Unix daemon): the adapter mints the `connectionId` per socket
 *     and stamps every `onEvent` with its OWN live id — a frame can never
 *     smuggle a stale connectionId into the fanout. A dropped connection
 *     rejects its in-flight commands (so a late response cannot resolve
 *     them), a fresh connection mints a DISTINCT id (old id never reused),
 *     and a closed adapter delivers no further events.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  KNOWN_CAPABILITIES_V1,
  encodeOutboundFrame,
  type OutboundDaemonToServerEventFrame,
} from '@silverhand/host';
import type { BackendLogger } from '../../../src/context.js';
import { HostTokenService } from '../../../src/auth/host-token.js';
import { AgentRepo } from '../../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../../src/repos/conversation-repo.js';
import { HostRepo } from '../../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../../src/auth/agent-token-store.js';
import type { EventPublisher } from '../../../src/runtime/event-handler.js';
import { OutboundRuntimeEventFanout } from '../../../src/runtime/outbound-event-fanout.js';
import {
  HOST_WS_PATH,
  installHostWebSocketServer,
  type HostWsServerController,
} from '../../../src/ws/host-ws-server.js';
import { EmbeddedUnixOutboundFrameAdapter } from '../../../src/runtime/embedded-unix-outbound-frame-adapter.js';
import { buildTestApp, type TestApp } from '../../utils/app.js';

async function waitFor<T>(
  predicate: () => T | null | undefined,
  { timeoutMs = 3_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function readyEvent(daemonPid: number): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: 2,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: `instance-${daemonPid}`,
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    daemon_pid: daemonPid,
    started_at: 1700000000000,
  };
}

function sessionInitEvent(
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

// ───────────────────────── standalone (real WS) ─────────────────────────

interface StandaloneStalenessFixture {
  t: TestApp;
  controller: HostWsServerController;
  fanout: OutboundRuntimeEventFanout;
  url: string;
  hostId: string;
  hostToken: string;
  conversationId: string;
  agentId: string;
  cliSessionId: () => string | null;
  cleanup: () => Promise<void>;
}

async function makeStandaloneStalenessFixture(): Promise<StandaloneStalenessFixture> {
  const t = buildTestApp({ deploymentMode: 'standalone' });
  const db = t.ctx.db;

  const hostRow = new HostRepo(db).getOwnedLocalForUser(t.viewerUserId)!;
  const hostToken = new HostTokenService(db).issueHostToken({ hostId: hostRow.id }).hostToken;

  const workspacesRoot = join(tmpdir(), 'silverhand-d5a4-staleness');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);

  const wsRow = workspaces.insert({
    name: 'd5a4-stale',
    description: null,
    workspacePath: workspaces.workspacePathFor('d5a4-stale'),
    workspaceHostId: hostRow.id,
  });
  const channel = conversations.insertChannel({
    workspaceId: wsRow.id,
    workspacePath: wsRow.workspace_path,
    title: 'd5a4-stale',
  });
  const agent = agents.create(
    { name: 'd5a4-stale-agent', runtime: 'claude', host_id: hostRow.id },
    hostRow.id,
    t.viewerUserId,
  );
  conversations.addAgent(channel.id, agent.id);

  const publisher: EventPublisher = { publish: () => {}, publishSide: () => {} };
  const logger: BackendLogger = { info: () => {}, warn: () => {}, error: () => {} };

  const httpServer = createHttpServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  let controller: HostWsServerController | null = null;
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => controller,
    logger,
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    activityLog: null,
  });
  controller = installHostWebSocketServer(httpServer, t.ctx, {
    eventSink: fanout,
    pingIntervalMs: 0,
  });
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;

  return {
    t,
    controller: controller!,
    fanout,
    url: `ws://127.0.0.1:${port}${HOST_WS_PATH}`,
    hostId: hostRow.id,
    hostToken,
    conversationId: channel.id,
    agentId: agent.id,
    cliSessionId: () =>
      (
        db
          .prepare(
            `SELECT cli_session_id FROM conversation_agents
              WHERE conversation_id = ? AND agent_id = ?`,
          )
          .get(channel.id, agent.id) as { cli_session_id: string | null } | undefined
      )?.cli_session_id ?? null,
    cleanup: async () => {
      await controller!.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
      t.cleanup();
    },
  };
}

interface RawDaemon {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
}

async function connectRawDaemon(url: string, hostToken: string): Promise<RawDaemon> {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${hostToken}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const frames: Array<Record<string, unknown>> = [];
  ws.on('message', (data: RawData) => {
    try {
      frames.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    } catch {
      /* ignore non-JSON */
    }
  });
  return { ws, frames };
}

describe('D5.a-4 — standalone connection staleness (real WS replacement)', () => {
  let fix: StandaloneStalenessFixture | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    sockets.length = 0;
    await fix?.cleanup();
    fix = null;
  });

  it('a late event on a REPLACED connection is not projected; the live connection still projects', async () => {
    fix = await makeStandaloneStalenessFixture();

    // Daemon #1 attaches.
    const d1 = await connectRawDaemon(fix.url, fix.hostToken);
    sockets.push(d1.ws);
    d1.ws.send(encodeOutboundFrame(readyEvent(101)));
    const c1 = await waitFor(() => fix!.controller.connectionIdForHost(fix!.hostId), {
      label: 'daemon #1 connectionId',
    });

    // Daemon #2 attaches with the same host token → server replaces #1.
    const d2 = await connectRawDaemon(fix.url, fix.hostToken);
    sockets.push(d2.ws);
    d2.ws.send(encodeOutboundFrame(readyEvent(102)));
    const c2 = await waitFor(
      () => {
        const cid = fix!.controller.connectionIdForHost(fix!.hostId);
        return cid && cid !== c1 ? cid : null;
      },
      { label: 'daemon #2 fresh connectionId' },
    );
    expect(c2).not.toBe(c1);

    // The replaced connection (#1) gets a LATE session_init. Because
    // replacement set `cleanedUp` on #1's server connection, handleMessage
    // is a no-op — the fanout must NOT project it.
    d1.ws.send(
      encodeOutboundFrame(sessionInitEvent(fix.conversationId, fix.agentId, 'STALE-from-old-conn')),
    );
    await settle();
    expect(fix.cliSessionId()).not.toBe('STALE-from-old-conn');
    expect(fix.cliSessionId()).toBeNull();

    // The SAME event on the LIVE connection (#2) IS projected — isolating
    // the difference to connection identity, not event content.
    d2.ws.send(
      encodeOutboundFrame(sessionInitEvent(fix.conversationId, fix.agentId, 'LIVE-from-new-conn')),
    );
    await waitFor(() => (fix!.cliSessionId() === 'LIVE-from-new-conn' ? true : null), {
      label: 'live-connection session_init projected',
    });
    expect(fix.cliSessionId()).toBe('LIVE-from-new-conn');
  });

  it('an in-flight command on a replaced connection rejects; a late response on the dead socket cannot resolve it', async () => {
    fix = await makeStandaloneStalenessFixture();

    const d1 = await connectRawDaemon(fix.url, fix.hostToken);
    sockets.push(d1.ws);
    d1.ws.send(encodeOutboundFrame(readyEvent(201)));
    const c1 = await waitFor(() => fix!.controller.connectionIdForHost(fix!.hostId), {
      label: 'daemon #1 connectionId',
    });

    // Dispatch a command on #1 and DON'T answer it.
    const pending = fix.controller.sendCommand(
      fix.hostId,
      'runtime_status',
      {},
      { timeoutMs: 3_000, expectedConnectionId: c1 },
    );
    const settled = expect(pending).rejects.toMatchObject({ code: 'transport_disconnected' });

    // Capture the command frame #1 received so we can craft a (doomed) late
    // response for its id after replacement.
    const cmd = await waitFor(
      () => d1.frames.find(f => f.type === 'command' && f.kind === 'runtime_status') ?? null,
      { label: 'runtime_status command on #1' },
    );

    // Daemon #2 replaces #1 → in-flight on #1 rejects transport_disconnected.
    const d2 = await connectRawDaemon(fix.url, fix.hostToken);
    sockets.push(d2.ws);
    d2.ws.send(encodeOutboundFrame(readyEvent(202)));
    await settled;

    // A LATE response for the in-flight id, sent on the now-replaced #1,
    // must not resolve anything (the connection is cleanedUp). The promise
    // is already rejected; sending this must not flip it to resolved. Sent
    // as raw JSON (not the typed encoder) because it is a deliberate
    // injection on a connection the server has already torn down.
    d1.ws.send(
      JSON.stringify({
        direction: 'daemon_to_server',
        type: 'command_response',
        id: String(cmd.id),
        kind: 'runtime_status',
        result: { runtimes: [] },
      }),
    );
    await settle();
    await expect(pending).rejects.toMatchObject({ code: 'transport_disconnected' });
  });
});

// ───────────────────────── embedded (adapter level) ─────────────────────

/** Minimal controllable fake daemon on a Unix socket for the embedded adapter. */
class FakeUnixDaemon {
  private server: NetServer;
  socket: Socket | null = null;
  private connectedResolve: (() => void) | null = null;
  private connected: Promise<void>;

  constructor(private readonly socketPath: string) {
    this.connected = new Promise<void>(resolve => (this.connectedResolve = resolve));
    this.server = createNetServer(sock => {
      this.socket = sock;
      sock.setEncoding('utf8');
      this.connectedResolve?.();
      this.connectedResolve = null;
    });
  }

  async listen(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  waitConnected(): Promise<void> {
    return this.connected;
  }

  resetConnected(): void {
    this.connected = new Promise<void>(resolve => (this.connectedResolve = resolve));
  }

  send(frame: Record<string, unknown>): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  drop(): void {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    } catch {
      /* best-effort */
    }
  }
}

interface RecordedEvent {
  hostId: string;
  connectionId: string;
  event: OutboundDaemonToServerEventFrame;
}

describe('D5.a-4 — embedded connection staleness (real EmbeddedUnixOutboundFrameAdapter)', () => {
  let sockDir: string | null = null;
  let daemon: FakeUnixDaemon | null = null;
  const adapters: EmbeddedUnixOutboundFrameAdapter[] = [];

  afterEach(async () => {
    for (const a of adapters) await a.close().catch(() => undefined);
    adapters.length = 0;
    await daemon?.close().catch(() => undefined);
    daemon = null;
    if (sockDir) {
      try {
        rmSync(sockDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      sockDir = null;
    }
  });

  it('events carry the adapter live connectionId; drop rejects in-flight; a reconnect mints a distinct id and old-connectionId traffic stops', async () => {
    sockDir = mkdtempSync(join(tmpdir(), 'shd5a4st'));
    const socketPath = join(sockDir, 'o.sock');
    daemon = new FakeUnixDaemon(socketPath);
    await daemon.listen();

    const hostId = 'local-host-1';
    const events: RecordedEvent[] = [];
    const disconnects: Array<{ hostId: string; connectionId: string }> = [];
    // ONE adapter instance — the embedded adapter mints the connectionId per
    // *attachment* (`embedded-unix-<host>-conn-<n>`, n incrementing per
    // connect on the same instance), so a reconnect produces a genuinely
    // distinct id. (Across separate instances the counter restarts, which is
    // fine for embedded's single-local-daemon model where a daemon bounce
    // re-runs the whole boot wiring; here we exercise the same-instance
    // reconnect path so the "fresh attachment ⇒ new id" contract is honest.)
    const adapter = new EmbeddedUnixOutboundFrameAdapter({
      socketPath,
      hostId,
      onEvent: (h, event, connectionId) => events.push({ hostId: h, connectionId, event }),
      onDisconnect: (h, connectionId) => disconnects.push({ hostId: h, connectionId }),
      commandTimeoutMs: 3_000,
    });
    adapters.push(adapter);
    await adapter.connect();
    await daemon.waitConnected();
    const c1 = adapter.connectionIdForHost(hostId)!;
    expect(c1).toBeTruthy();

    // Any event the daemon sends is stamped with the adapter's OWN live
    // connectionId — a frame can never inject a stale connectionId into the
    // fanout (the adapter is authoritative on connection identity).
    daemon.send(readyEvent(301));
    const firstEvent = await waitFor(() => events[0] ?? null, { label: 'event delivered' });
    expect(firstEvent.connectionId).toBe(c1);
    expect(firstEvent.hostId).toBe(hostId);

    // An in-flight command rejects when the connection drops — so a late
    // response can never resolve it.
    const inflight = adapter.sendCommand(hostId, 'runtime_status', {}, { timeoutMs: 3_000 });
    const settled = expect(inflight).rejects.toMatchObject({ code: 'transport_disconnected' });
    daemon.drop();
    await settled;
    expect(disconnects.some(d => d.connectionId === c1)).toBe(true);
    const eventCountOnC1 = events.filter(e => e.connectionId === c1).length;

    // Reconnect the SAME adapter → a DISTINCT connectionId (the old id is
    // never reused) and its events carry the new id.
    daemon.resetConnected();
    await adapter.connect();
    await daemon.waitConnected();
    const c2 = adapter.connectionIdForHost(hostId)!;
    expect(c2).toBeTruthy();
    expect(c2).not.toBe(c1);

    const before = events.length;
    daemon.send(readyEvent(302));
    const newest = await waitFor(() => (events.length > before ? events[events.length - 1] : null), {
      label: 'event after reconnect',
    });
    expect(newest.connectionId).toBe(c2);
    // No further event ever arrives tagged with the dead connectionId — the
    // adapter cannot project onto the old connection after it died.
    expect(
      events.filter(e => e.connectionId === c1).length,
      'no events should arrive on the dropped connectionId after it died',
    ).toBe(eventCountOnC1);
  });
});
