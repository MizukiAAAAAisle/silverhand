/**
 * D4.c C5 — outbound event perimeter regression.
 *
 * The connection is authenticated to `hostId` at the WS layer
 * (host token verify in `host-ws-server`). What we DON'T trust is
 * the runtime claim daemon X carries inside each event frame:
 * "agent A on conversation C just produced event E". A buggy or
 * malicious daemon attached as host X could (a) emit an event
 * referencing an agent owned by host Y, OR (b) emit an event
 * using its own agent but TARGETING a conversation owned by host
 * Y, OR (c) emit an event for an agent that isn't a member of
 * the target conversation. Pre-C5 any of these would publish
 * into projection / DB / bus.
 *
 * C5 installs `assertEventOwnership` BEFORE `stateForHost` (so
 * `this.states` Map stays clean on rejection). The full validation
 * chain for per-agent frames (short-circuited; first failure wins):
 *
 *   1. agents.get(agent_id) exists.
 *   2. agent.host_id === hostId.
 *   3. conversations.get(conversation_id) exists.
 *   4. workspaces.get(conversation.workspace_id).workspace_host_id === hostId.
 *   5. conversations.getAgent(conversation_id, agent_id) exists.
 *
 * Daemon-level frames (no `agent_id` — currently `ready` and
 * `shutting_down`) are admitted by construction.
 *
 * Pinned contracts (9 / 9 pass):
 *
 *   1. Same-host happy path (control).
 *   2. Cross-host runtime_ready_for_drain (kind with PRE-DISPATCH
 *      cache mutation) → drop, reason `agent_host_mismatch`,
 *      states.size === 0.
 *   3. Cross-host runtime_parsed_event (generic projection kind) →
 *      same drop, kind-agnostic.
 *   4. Unknown agent_id → drop, action
 *      `outbound_event_unknown_agent`.
 *   5. (Cindy P1.a) host X agent X + host Y conversation → drop,
 *      reason `conversation_host_mismatch`. agent ownership passes;
 *      this is what step (2) alone would have leaked.
 *   6. (Cindy P1.b) host X agent X + host X conversation but the
 *      (cid, aid) pair is NOT in `conversation_agents` → drop,
 *      reason `agent_not_in_conversation`.
 *   7. Daemon-level `ready` admitted; runtime_status hydrate fires.
 *   8. Daemon-level `shutting_down` admitted.
 *   9. Sequence pin — mismatch frame on conn-1 then valid frame on
 *      conn-1 still processes; states.size goes 0 → 0 → 1 across
 *      the two onEvent calls.
 *
 * R4 boundary: this IPC is local supervisor/control, not
 * server↔daemon formal semantics. C5 changes only the server-side
 * check applied to outbound event frames; no wire envelope shape
 * changes.
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
  /** Test helper: insert a fresh channel under hostX's workspace
   *  WITHOUT adding any agent to its `conversation_agents`. Used by
   *  the `agent_not_in_conversation` regression. */
  insertHostXChannelWithoutAgent(title: string): string;
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
    publishSide: (conv, payload) =>
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
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    activityLog: null,
  });

  return {
    fanout,
    transport,
    events,
    warns,
    hostX: { id: hostXId, channelId: channelX.id, agentId: agentX.id },
    hostY: { id: hostY.id, channelId: channelY.id, agentId: agentY.id },
    insertHostXChannelWithoutAgent: (title: string): string => {
      // Fresh channel under hostX's workspace. No `conversation_agents`
      // row inserted — the agent is NOT a member of this conversation.
      // Used by the `agent_not_in_conversation` regression to assert
      // the perimeter rejects events whose `(cid, aid)` claim has no
      // membership backing.
      const channel = conversations.insertChannel({
        workspaceId: wsX.id,
        workspacePath: wsX.workspace_path,
        title,
      });
      return channel.id;
    },
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
    protocol_version: 2,
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
      expect(perimeterWarns(fix.warns)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('drops cross-host runtime_ready_for_drain BEFORE stateForHost — states.size stays 0, no SSE / no RPC, warn tagged agent_host_mismatch', () => {
    const fix = makePerimeterFixture();
    try {
      // Host X's connection emits a frame referencing host Y's
      // agent + host Y's conversation. The earliest failure is
      // step (2): `agent.host_id !== hostId`.
      fix.fanout.onEvent(
        fix.hostX.id,
        readyForDrainEvent(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );

      // Side-effect zero: no SSE event published, no transport
      // RPC issued (handler.dispatch never ran).
      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);

      // P2 (Cindy `dgCAVQ3fbHoOFvvN`): direct kill on the load-bearing
      // "no per-host state slot lazy-created" invariant. `states.size`
      // is the source of truth; `getAgentRunStates` is downstream and
      // could mask state-without-runState.
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

      const warns = perimeterWarns(fix.warns);
      expect(warns.length).toBe(1);
      expect(warns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostY.agentId,
        agentHostId: fix.hostY.id,
        eventKind: 'runtime_ready_for_drain',
        reason: 'agent_host_mismatch',
        action: 'outbound_event_perimeter_mismatch',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('drops cross-host runtime_parsed_event (generic projection kind) — states.size stays 0, no SSE / no RPC, warn tagged agent_host_mismatch', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

      const warns = perimeterWarns(fix.warns);
      expect(warns.length).toBe(1);
      expect(warns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostY.agentId,
        agentHostId: fix.hostY.id,
        eventKind: 'runtime_parsed_event',
        reason: 'agent_host_mismatch',
        action: 'outbound_event_perimeter_mismatch',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('drops events that reference an unknown agent_id — states.size stays 0, warn tagged outbound_event_unknown_agent', () => {
    const fix = makePerimeterFixture();
    try {
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostX.channelId, 'agent-does-not-exist'),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

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

  // Cindy `dgCAVQ3fbHoOFvvN` P1 (a): host X uses ITS OWN agent but
  // targets HOST Y's conversation. agent_host_mismatch wouldn't catch
  // this — agent.host_id IS hostId. Without conversation_host_mismatch
  // the event would publish into host Y's conversation (cross-tenant
  // SSE / DB projection leak).
  it('drops host X agent X + host Y conversation — states.size stays 0, no SSE / no RPC, warn tagged conversation_host_mismatch (Cindy P1.a)', () => {
    const fix = makePerimeterFixture();
    try {
      // hostX agent + hostY conversation. agent ownership passes,
      // step (4) catches `workspace.workspace_host_id !== hostId`.
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostY.channelId, fix.hostX.agentId),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

      const warns = perimeterWarns(fix.warns);
      expect(warns.length).toBe(1);
      expect(warns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostX.agentId,
        conversationId: fix.hostY.channelId,
        workspaceHostId: fix.hostY.id,
        eventKind: 'runtime_parsed_event',
        reason: 'conversation_host_mismatch',
        action: 'outbound_event_perimeter_mismatch',
      });
    } finally {
      fix.cleanup();
    }
  });

  // Cindy `dgCAVQ3fbHoOFvvN` P1 (b): host X uses its own agent on
  // host X's conversation, but the (cid, aid) pair is NOT in
  // `conversation_agents` — i.e. the agent is not a member of that
  // conversation. agent_host_mismatch / conversation_host_mismatch
  // both pass. Without `agent_not_in_conversation` the event would
  // publish into a conversation the agent doesn't legitimately
  // participate in, projecting `agent_status` / `agent_event` onto
  // a row that has no `conversation_agents` membership.
  it('drops host X agent X + host X conversation but agent NOT in conversation_agents — states.size stays 0, warn tagged agent_not_in_conversation (Cindy P1.b)', () => {
    const fix = makePerimeterFixture();
    try {
      // Insert a SECOND host X conversation (so the workspace host
      // matches), but DO NOT add the agent to `conversation_agents`
      // for that conversation. The agent stays a member only of
      // `fix.hostX.channelId` (seeded in the fixture).
      const otherChannelId = fix.insertHostXChannelWithoutAgent(
        'perimeter-x-bare',
      );

      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(otherChannelId, fix.hostX.agentId),
        'conn-1',
      );

      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

      const warns = perimeterWarns(fix.warns);
      expect(warns.length).toBe(1);
      expect(warns[0]!.obj).toMatchObject({
        connectionHostId: fix.hostX.id,
        agentId: fix.hostX.agentId,
        conversationId: otherChannelId,
        eventKind: 'runtime_parsed_event',
        reason: 'agent_not_in_conversation',
        action: 'outbound_event_perimeter_mismatch',
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
      expect(perimeterWarns(fix.warns)).toEqual([]);
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
      expect(perimeterWarns(fix.warns)).toEqual([]);
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
      // states.size MUST still be 0 immediately after the mismatch
      // — the second-frame test below would also expose any
      // mismatch-induced residue, but pinning here is more direct.
      expect(fanoutStatesSize(fix.fanout)).toBe(0);

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

      // After the valid frame, exactly one host slot exists
      // (host X — created lazily when the valid frame called
      // `stateForHost`).
      expect(fanoutStatesSize(fix.fanout)).toBe(1);

      // Exactly one perimeter warn from the first (mismatch)
      // frame — the second valid frame did not produce one.
      const warns = perimeterWarns(fix.warns);
      expect(warns.length).toBe(1);
    } finally {
      fix.cleanup();
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cindy `dgCAVQ3fbHoOFvvN` P2: load-bearing assertion that perimeter
 * rejects leave NO per-host residue. `getAgentRunStates` is downstream
 * (filters states by populated runState), so a state slot with empty
 * cache would slip past it. Reaching into `(fanout as any).states.size`
 * is the most direct kill — if the perimeter ever lazy-creates a slot
 * via `stateForHost` before checking, this assertion catches it.
 */
function fanoutStatesSize(fanout: OutboundRuntimeEventFanout): number {
  const states = (fanout as unknown as { states: Map<string, unknown> }).states;
  return states.size;
}

/** Filter `warns` to perimeter-tagged entries (mismatch + unknown
 *  agent) — used in both positive and negative shape checks. */
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
  timeoutMs = 1_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}
