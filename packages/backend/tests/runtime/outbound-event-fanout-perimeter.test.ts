/**
 * D4.c C5 — outbound event perimeter regression.
 *
 * The connection is authenticated to `hostId` at the WS layer
 * (host token verify in `host-ws-server`). What we DON'T trust is
 * the `agent_id` daemon X claims to act on inside each event
 * frame: a buggy or malicious daemon attached as host X could emit
 * an event referencing an agent owned by host Y. Pre-C5 the event
 * would flow into `stateForHost(connectionHostId)`, allocate a
 * state slot for that hostId, write `currentConnectionId` /
 * `currentDaemonKey`, mutate `cache.applyPhase` for the wrong
 * host's pair, and dispatch into `state.handler` (projection +
 * DB + bus).
 *
 * C5 installs `assertEventOwnership` BEFORE `stateForHost`. The
 * intended invariants pinned here:
 *
 *   1. Same-host happy path: control case showing legitimate
 *      events still pass and produce side effects.
 *   2. Cross-host mismatch on `runtime_ready_for_drain` — the
 *      event with a PRE-DISPATCH cache mutation. Assert that NO
 *      state slot is created, no cache entry is written, no
 *      handler dispatch happens, and no downstream WS RPC is
 *      issued. A warn log is emitted.
 *   3. Cross-host mismatch on `runtime_parsed_event` — the
 *      generic projection event. Same drop guarantee, proves the
 *      perimeter is kind-agnostic for any per-agent frame.
 *   4. Unknown agent_id → drop + warn. Same security posture
 *      (host references a non-existent agent).
 *   5. `ready` (daemon-level, no `agent_id`) passes — owned by
 *      the connection's hostId by construction.
 *   6. `shutting_down` (daemon-level, no `agent_id`) passes —
 *      same rationale; future daemon-level kinds without
 *      `agent_id` admitted automatically by `'agent_id' in event`.
 *   7. Sequence pin: a mismatch frame followed by a valid frame
 *      on the same connection still processes the valid frame
 *      cleanly. (Pre-C5 the mismatch would have set the host's
 *      `currentConnectionId` and could leave residue affecting
 *      the next valid frame; C5 leaves the host slot completely
 *      untouched on mismatch.)
 *
 * R4 boundary: this IPC is local supervisor/control, not
 * server↔daemon formal semantics. C5 changes only the
 * server-side check applied to outbound event frames; no wire
 * envelope shape changes.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPABILITIES_V1,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type RuntimeStatusResult,
} from '@silverhand/host';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { type EventPublisher } from '../../src/runtime/event-handler.js';
import { OutboundRuntimeEventFanout } from '../../src/runtime/outbound-event-fanout.js';
import type { BackendLogger } from '../../src/context.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import { openTestDb } from '../utils/db.js';

interface PerimeterFixture {
  fanout: OutboundRuntimeEventFanout;
  transport: FakeTransport;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  warns: Array<{ obj: unknown; msg: string | undefined }>;
  hostX: { id: string; channelId: string; agentId: string };
  hostY: { id: string; channelId: string; agentId: string };
  cleanup(): void;
}

function makePerimeterFixture(): PerimeterFixture {
  const { db, viewerUserId, localHostId } = openTestDb();

  // Host X = the bootstrapped local host (claimed by viewer).
  const hostXId = localHostId;
  // Host Y = a second local host owned by `teammate` user (the
  // openTestDb fixture seeds the `teammate` user). The exact owner
  // does not affect perimeter behavior — we only need a SECOND
  // distinct host id so cross-host events are diagnosable.
  const hostY = new HostRepo(db).create('local-teammate', 'local', {
    userId: 'teammate',
    installationId: 'install-teammate',
    lastSeenAt: Date.now(),
  });

  const workspacesRoot = join(tmpdir(), 'silverhand-outbound-perimeter-test');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const conversations = new ConversationRepo(db);
  const agents = new AgentRepo(db);

  const wsX = workspaces.insert({
    name: 'perimeter-x',
    description: null,
    workspacePath: workspaces.workspacePathFor('perimeter-x'),
    workspaceHostId: hostXId,
  });
  const channelX = conversations.insertChannel({
    workspaceId: wsX.id,
    workspacePath: wsX.workspace_path,
    title: 'perimeter-x',
  });
  const agentX = agents.create(
    { name: 'agent-x', runtime: 'claude', host_id: hostXId },
    hostXId,
    viewerUserId,
  );
  conversations.addAgent(channelX.id, agentX.id);
  conversations.updateAgentRuntime(channelX.id, agentX.id, {
    status: 'starting',
  });

  const wsY = workspaces.insert({
    name: 'perimeter-y',
    description: null,
    workspacePath: workspaces.workspacePathFor('perimeter-y'),
    workspaceHostId: hostY.id,
  });
  const channelY = conversations.insertChannel({
    workspaceId: wsY.id,
    workspacePath: wsY.workspace_path,
    title: 'perimeter-y',
  });
  const agentY = agents.create(
    { name: 'agent-y', runtime: 'claude', host_id: hostY.id },
    hostY.id,
    'teammate',
  );
  conversations.addAgent(channelY.id, agentY.id);
  conversations.updateAgentRuntime(channelY.id, agentY.id, {
    status: 'starting',
  });

  const events: PerimeterFixture['events'] = [];
  const publisher: EventPublisher = {
    publish: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
  };

  const warns: PerimeterFixture['warns'] = [];
  const logger: BackendLogger = {
    info: () => {},
    warn: (obj, msg) => warns.push({ obj, msg }),
    error: () => {},
  };

  const transport = new FakeTransport();
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => transport,
    logger,
    silverhandDir: join(tmpdir(), 'silverhand-outbound-perimeter-silverhand'),
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    serverUrl: () => 'http://127.0.0.1:1',
    proxyPolicy: () => ({ url: null, allowlist: [] }),
    activityLog: null,
  });

  return {
    fanout,
    transport,
    events,
    warns,
    hostX: { id: hostXId, channelId: channelX.id, agentId: agentX.id },
    hostY: { id: hostY.id, channelId: channelY.id, agentId: agentY.id },
    cleanup: () => {
      db.close();
    },
  };
}

class FakeTransport implements HostWsServerController {
  calls: Array<{
    hostId: string;
    kind: string;
    params: Record<string, unknown>;
  }> = [];
  snapshot: RuntimeStatusResult = { runtimes: [] };
  connectionId = 'conn-1';

  activeConnectionCount(): number {
    return 1;
  }
  connectedHostIds(): string[] {
    return ['local'];
  }
  connectionIdForHost(_hostId: string): string | null {
    return this.connectionId;
  }
  getAttachment(): null {
    return null;
  }
  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    this.calls.push({ hostId, kind, params: params as Record<string, unknown> });
    if (kind === 'runtime_status') {
      return Promise.resolve(this.snapshot) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_wake') {
      return Promise.resolve({
        delivered: true,
        delivery_ids: [
          ...((params as { delivery_ids?: number[] }).delivery_ids ?? []),
        ],
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
  }
  disconnectHost(_hostId: string): boolean {
    return false;
  }
  async close(): Promise<void> {
    // no-op
  }
}

function readyEvent(): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'ready',
    protocol_version: 1,
    daemon_version: '0.0.0-test',
    daemon_id: 'local',
    instance_id: 'instance-1',
    host_descriptor: { name: 'local', kind: 'local' },
    capabilities: [...KNOWN_CAPABILITIES_V1],
    daemon_pid: 123,
    started_at: 1700000000000,
  };
}

function shuttingDownEvent(): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'shutting_down',
    reason: 'test',
  };
}

function readyForDrainEvent(
  conversationId: string,
  agentId: string,
): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_ready_for_drain',
    conversation_id: conversationId,
    agent_id: agentId,
    ts: 1700000001000,
  };
}

function parsedEventFrame(
  conversationId: string,
  agentId: string,
): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_parsed_event',
    conversation_id: conversationId,
    agent_id: agentId,
    parsed: { kind: 'session_init', sessionId: 'sess-perimeter' },
    ts: 1700000002000,
  };
}

describe('OutboundRuntimeEventFanout — D4.c C5 perimeter', () => {
  it('admits same-host runtime_parsed_event (control: legitimate frames still flow through)', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostX.channelId, fix.hostX.agentId),
        'conn-1',
      );

      // Handler ran → publisher saw an `agent_event` projection
      // (the `runtime_parsed_event` SSE shape) on the right
      // conversation.
      expect(fix.events.length).toBeGreaterThan(0);
      const agentEvent = fix.events.find(
        e => e.conv === fix.hostX.channelId && e.kind === 'agent_event',
      );
      expect(agentEvent).toBeDefined();
      // No perimeter warn for the legitimate path.
      expect(
        fix.warns.filter(
          w =>
            isRecord(w.obj) &&
            (w.obj.action === 'outbound_event_perimeter_mismatch' ||
              w.obj.action === 'outbound_event_unknown_agent'),
        ),
      ).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('drops cross-host runtime_ready_for_drain BEFORE stateForHost — no state slot, no cache, no dispatch, no RPC; warn logged', () => {
    const fix = makePerimeterFixture();
    try {
      // Host X's connection emits a frame referencing host Y's
      // agent. Pre-C5 this would (a) lazy-create a state slot for
      // hostX, (b) write `currentDaemonKey` was already null so the
      // pre-dispatch cache mutation gates on it — but the dispatch
      // into the handler would still happen for hostX with the
      // wrong agent.
      fix.fanout.onEvent(
        fix.hostX.id,
        readyForDrainEvent(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );

      // Side-effect zero: no SSE event published, no transport
      // RPC issued (handler.dispatch never ran).
      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);

      // No state slot created for hostX → getAgentRunStates
      // returns empty for either conversation.
      expect(fix.fanout.getAgentRunStates(fix.hostX.channelId)).toEqual([]);
      expect(fix.fanout.getAgentRunStates(fix.hostY.channelId)).toEqual([]);

      // Warn log fired with the perimeter action tag.
      const mismatchWarns = fix.warns.filter(
        w =>
          isRecord(w.obj) && w.obj.action === 'outbound_event_perimeter_mismatch',
      );
      expect(mismatchWarns.length).toBe(1);
      expect(mismatchWarns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostY.agentId,
        agentHostId: fix.hostY.id,
        eventKind: 'runtime_ready_for_drain',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('drops cross-host runtime_parsed_event (generic projection kind) — no SSE / no RPC; warn logged', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fix.fanout.getAgentRunStates(fix.hostX.channelId)).toEqual([]);
      expect(fix.fanout.getAgentRunStates(fix.hostY.channelId)).toEqual([]);

      const mismatchWarns = fix.warns.filter(
        w =>
          isRecord(w.obj) && w.obj.action === 'outbound_event_perimeter_mismatch',
      );
      expect(mismatchWarns.length).toBe(1);
      expect(mismatchWarns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostY.agentId,
        agentHostId: fix.hostY.id,
        eventKind: 'runtime_parsed_event',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('drops events that reference an unknown agent_id — no state, no dispatch; warn tagged outbound_event_unknown_agent', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostX.channelId, 'agent-does-not-exist'),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fix.fanout.getAgentRunStates(fix.hostX.channelId)).toEqual([]);

      const unknownWarns = fix.warns.filter(
        w =>
          isRecord(w.obj) && w.obj.action === 'outbound_event_unknown_agent',
      );
      expect(unknownWarns.length).toBe(1);
      expect(unknownWarns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: 'agent-does-not-exist',
        eventKind: 'runtime_parsed_event',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('admits daemon-level `ready` (no agent_id) — owned by the connection by construction', async () => {
    const fix = makePerimeterFixture();
    try {
      fix.transport.snapshot = { runtimes: [] };
      fix.fanout.onEvent(fix.hostX.id, readyEvent(), 'conn-1');

      // ready triggers an async runtime_status hydrate via the
      // handler's onDaemonReady path. Wait for it to fire.
      await waitFor(() =>
        fix.transport.calls.some(call => call.kind === 'runtime_status'),
      );

      // No perimeter warns at all.
      expect(
        fix.warns.filter(
          w =>
            isRecord(w.obj) &&
            (w.obj.action === 'outbound_event_perimeter_mismatch' ||
              w.obj.action === 'outbound_event_unknown_agent'),
        ),
      ).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('admits daemon-level `shutting_down` (no agent_id) — perimeter does not gate it', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(fix.hostX.id, shuttingDownEvent(), 'conn-1');

      // No perimeter warns: `'agent_id' in event` is false, so
      // `assertEventOwnership` returns true.
      expect(
        fix.warns.filter(
          w =>
            isRecord(w.obj) &&
            (w.obj.action === 'outbound_event_perimeter_mismatch' ||
              w.obj.action === 'outbound_event_unknown_agent'),
        ),
      ).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('sequence pin: cross-host mismatch frame leaves zero residue — a following same-host valid frame still processes', () => {
    const fix = makePerimeterFixture();
    try {
      // First: a mismatch frame from hostX referencing hostY's
      // agent. Pre-C5 this would have lazy-created host X's state
      // slot and written `currentConnectionId = 'conn-1'`. Post-C5
      // it must leave `this.states` untouched.
      fix.fanout.onEvent(
        fix.hostX.id,
        readyForDrainEvent(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );
      // Then: a legitimate same-host frame on the same connection.
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostX.channelId, fix.hostX.agentId),
        'conn-1',
      );

      // The valid frame still produces its `agent_event`
      // projection on the right conversation.
      const agentEvents = fix.events.filter(
        e => e.kind === 'agent_event' && e.conv === fix.hostX.channelId,
      );
      expect(agentEvents.length).toBe(1);

      // Exactly one perimeter warn from the first (mismatch)
      // frame — the second valid frame did not produce one.
      const mismatchWarns = fix.warns.filter(
        w =>
          isRecord(w.obj) && w.obj.action === 'outbound_event_perimeter_mismatch',
      );
      expect(mismatchWarns.length).toBe(1);
    } finally {
      fix.cleanup();
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}
