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
 * chain for per-agent frames (short-circuited; first failure wins;
 * cross-computer slice 2 #task:1600 removed the old workspace-host
 * arm — a workspace's members may legitimately run on other
 * computers, so the hostile "my agent, someone else's conversation"
 * shape is carried entirely by the membership arm):
 *
 *   1. agents.get(agent_id) exists.
 *   2. agent.host_id === hostId.
 *   3. conversations.get(conversation_id) exists.
 *   4. conversations.getAgent(conversation_id, agent_id) exists.
 *
 * Daemon-level frames (no `agent_id` — currently `ready` and
 * `shutting_down`) are admitted by construction.
 *
 * Pinned contracts:
 *
 *   1. Same-host happy path (control).
 *   2. Cross-host runtime_ready_for_drain (kind with PRE-DISPATCH
 *      cache mutation) → drop, reason `agent_host_mismatch`,
 *      states.size === 0.
 *   3. Cross-host runtime_parsed_event (generic projection kind) →
 *      same drop, kind-agnostic.
 *   4. Unknown agent_id → drop, action
 *      `outbound_event_unknown_agent`.
 *   5. (Cindy P1.a, reclassified by #task:1600) host X agent X +
 *      host Y conversation WITHOUT membership → drop, reason
 *      `agent_not_in_conversation`. agent ownership passes; the
 *      membership arm is what excludes this shape now.
 *   5b. (#task:1600) host X agent X + host Y conversation WITH
 *      membership → ADMITTED: a cross-computer guest member's
 *      events are legal.
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
import { fixedConversationTitle } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPABILITIES_V1,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type RuntimeStatusResult,
} from '@silverhand/host';
import { OUTBOUND_PROTOCOL_VERSION } from '@silverhand/host';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { RuntimeSlotRepo } from '../../src/repos/runtime-slot-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { conversationRuntimePrincipal } from '../../src/auth/runtime-principal.js';
import { type EventPublisher } from '../../src/runtime/event-handler.js';
import { makeDaemonInstanceKey } from '../../src/runtime/daemon-instance-key.js';
import { EventPerimeterGuard } from '../../src/runtime/event-perimeter.js';
import type {
  RuntimeEventPerimeterPort,
  RuntimePerimeterAgentReadPort,
  RuntimePerimeterConversationReadPort,
} from '../../src/runtime/event-perimeter.js';
import { createRuntimeFanoutDbDeps } from '../../src/adapters/runtime-fanout.js';
import { OutboundRuntimeEventFanout } from '../../src/runtime/outbound-event-fanout.js';
import type { BackendLogger } from '../../src/context.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import type { HostWsAttachment } from '../../src/ws/host-ws-server.js';
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
  /** Test helper (#task:1600): make hostX's agent a MEMBER of hostY's
   *  channel — the legal cross-computer guest shape. */
  addAgentXToHostYChannel(): void;
  cleanup(): void;
}

function makePerimeterFixture(opts?: {
  /** Replace the DB-backed guard with an alternate
   *  {@link RuntimeEventPerimeterPort} implementation — see the injectability
   *  contract at the bottom of this file (#task:1982 W3 P1). */
  perimeter?: RuntimeEventPerimeterPort;
}): PerimeterFixture {
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
  const workspaces = new WorkspaceRepo(db);
  const conversations = new ConversationRepo(db);
  const runtimeSlots = new RuntimeSlotRepo(db);
  const agents = new AgentRepo(db);

  const wsX = workspaces.insert({
    name: 'perimeter-x',
    description: null,
  });
  const channelX = conversations.insertChannel({
    workspaceId: wsX.id,
    title: fixedConversationTitle('perimeter-x'),
  });
  const agentX = agents.create(
    { name: 'agent-x', runtime: 'claude', host_id: hostXId },
    hostXId,
    viewerUserId,
  );
  conversations.addAgent(channelX.id, agentX.id);
  runtimeSlots.updateCurrentConversationProjection(channelX.id, agentX.id, {
    status: 'starting',
  });
  const agentTokens = new AgentTokenStore();
  const daemonInstanceId = makeDaemonInstanceKey(123, 1700000000000);
  const claimedX = runtimeSlots.claimGeneration({
    scope: { kind: 'conversation', conversationId: channelX.id, agentId: agentX.id },
    daemonInstanceId,
  });
  if (!claimedX) throw new Error('failed to claim host X fixture runtime');
  agentTokens.issue(conversationRuntimePrincipal({
    conversationId: channelX.id,
    agentId: agentX.id,
    generation: claimedX.generation,
    daemonInstanceId,
  }));

  const wsY = workspaces.insert({
    name: 'perimeter-y',
    description: null,
  });
  const channelY = conversations.insertChannel({
    workspaceId: wsY.id,
    title: fixedConversationTitle('perimeter-y'),
  });
  const agentY = agents.create(
    { name: 'agent-y', runtime: 'claude', host_id: hostY.id },
    hostY.id,
    'teammate',
  );
  conversations.addAgent(channelY.id, agentY.id);
  runtimeSlots.updateCurrentConversationProjection(channelY.id, agentY.id, {
    status: 'starting',
  });
  const claimedY = runtimeSlots.claimGeneration({
    scope: { kind: 'conversation', conversationId: channelY.id, agentId: agentY.id },
    daemonInstanceId,
  });
  if (!claimedY) throw new Error('failed to claim host Y fixture runtime');
  agentTokens.issue(conversationRuntimePrincipal({
    conversationId: channelY.id,
    agentId: agentY.id,
    generation: claimedY.generation,
    daemonInstanceId,
  }));

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
    ...createRuntimeFanoutDbDeps({ db, events: publisher, logger }),
    // AFTER the spread: when a test supplies its own perimeter, the DB-backed
    // guard is fully replaced rather than consulted as well.
    ...(opts?.perimeter ? { perimeter: opts.perimeter } : {}),
    events: publisher,
    transport: () => transport,
    logger,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens,
    activityLog: null,
  });

  return {
    fanout,
    transport,
    events,
    warns,
    hostX: { id: hostXId, channelId: channelX.id, agentId: agentX.id },
    hostY: { id: hostY.id, channelId: channelY.id, agentId: agentY.id },
    addAgentXToHostYChannel: (): void => {
      conversations.addAgent(channelY.id, agentX.id);
      runtimeSlots.updateCurrentConversationProjection(channelY.id, agentX.id, {
        status: 'starting',
      });
      const claimed = runtimeSlots.claimGeneration({
        scope: { kind: 'conversation', conversationId: channelY.id, agentId: agentX.id },
        daemonInstanceId,
      });
      if (!claimed) throw new Error('failed to claim cross-host fixture runtime');
      agentTokens.issue(conversationRuntimePrincipal({
        conversationId: channelY.id,
        agentId: agentX.id,
        generation: claimed.generation,
        daemonInstanceId,
      }));
    },
    insertHostXChannelWithoutAgent: (title: string): string => {
      // Fresh channel under hostX's workspace. No `conversation_agents`
      // row inserted — the agent is NOT a member of this conversation.
      // Used by the `agent_not_in_conversation` regression to assert
      // the perimeter rejects events whose `(cid, aid)` claim has no
      // membership backing.
      const channel = conversations.insertChannel({
        workspaceId: wsX.id,
        title: fixedConversationTitle(title),
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
  getAttachment(hostId: string): HostWsAttachment {
    return {
      hostId,
      connectionId: this.connectionId,
      daemonInstanceId: makeDaemonInstanceKey(123, 1700000000000),
      attachedAt: 0,
      hostname: null,
      capabilities: [],
    };
  }
  getAdmissionFailure(): null {
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
    if (kind === 'runtime_deliver') {
      return Promise.resolve({
        disposition: 'admitted',
        pid: 1234,
        started_at: 1700000000000,
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
    protocol_version: OUTBOUND_PROTOCOL_VERSION,
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
    runtime_generation: 1,
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_ready_for_drain',
    runtime_scope: {
      kind: 'conversation',
      conversation_id: conversationId,
      agent_id: agentId,
    },
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
    runtime_generation: 1,
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_parsed_event',
    runtime_scope: {
      kind: 'conversation',
      conversation_id: conversationId,
      agent_id: agentId,
    },
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

  // Cindy `dgCAVQ3fbHoOFvvN` P1 (a), reclassified by #task:1600: host X
  // uses ITS OWN agent but targets HOST Y's conversation WITHOUT being a
  // member. agent_host_mismatch wouldn't catch this — agent.host_id IS
  // hostId. The old workspace-host arm is gone (guest members are legal
  // now); the MEMBERSHIP arm is what excludes this cross-tenant shape.
  it('drops host X agent X + host Y conversation without membership — warn tagged agent_not_in_conversation (Cindy P1.a / #task:1600)', () => {
    const fix = makePerimeterFixture();
    try {
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
        eventKind: 'runtime_parsed_event',
        reason: 'agent_not_in_conversation',
        action: 'outbound_event_perimeter_mismatch',
      });
    } finally {
      fix.cleanup();
    }
  });

  // #task:1600 falsifier for the reclassification: the SAME cross-host
  // shape WITH membership is now legal — a guest member's daemon may
  // emit events into a conversation whose workspace lives on another
  // computer. Before slice 2 this was dropped as conversation_host_mismatch.
  it('admits host X agent X + host Y conversation WITH membership — cross-computer guest events are legal (#task:1600)', () => {
    const fix = makePerimeterFixture();
    try {
      fix.addAgentXToHostYChannel();
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostY.channelId, fix.hostX.agentId),
        'conn-1',
      );

      expect(perimeterWarns(fix.warns)).toEqual([]);
      expect(
        fix.warns.filter(
          w => isRecord(w.obj) && w.obj.action === 'outbound_event_unknown_agent',
        ),
      ).toEqual([]);
      // The event crossed the perimeter into per-host runtime state.
      expect(fanoutStatesSize(fix.fanout)).toBe(1);
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

/**
 * #task:1982 W3 P1 (Cindy `dgCAVQ3fbHoOFvvN`) — substitutability contract.
 *
 * The tests above prove the POLICY. These prove the policy is not welded to
 * SQLite. The earlier failure mode was invisible to an import scan: the fanout
 * imported no `repos/*` module, yet its `perimeter` option was typed as the
 * `EventPerimeterGuard` CLASS, whose private fields make the type nominal — an
 * alternate deployment with an identical `assert()` still could not be assigned
 * to it, so R2 was green by path only.
 *
 * Both arms are compile-time AND runtime evidence: the object literals are
 * written inline (assignability is checked by `tsc`, so a re-widened option
 * type reddens the build), and each is then shown to actually drive behavior.
 */
describe('perimeter substitutability — an alternate implementation is injectable', () => {
  it('the fanout consumes a plain-object RuntimeEventPerimeterPort — no repo, no driver — and honors its refusal on a frame the DB-backed guard admits', () => {
    const seen: Array<{ hostId: string; kind: string }> = [];
    // A perimeter with no DB at all: it answers from its arguments. If the
    // fanout's option type were the guard class again, this literal would not
    // type-check.
    const refuseAll: RuntimeEventPerimeterPort = {
      assert: (hostId, event) => {
        seen.push({ hostId, kind: event.kind });
        return false;
      },
    };
    const fix = makePerimeterFixture({ perimeter: refuseAll });
    try {
      // The exact frame the control test proves the DB-backed guard ADMITS.
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostX.channelId, fix.hostX.agentId),
        'conn-1',
      );

      // The injected verdict is the only one that counted.
      expect(seen).toEqual([
        { hostId: fix.hostX.id, kind: 'runtime_parsed_event' },
      ]);
      expect(fix.events).toEqual([]);
      expect(fix.transport.calls).toEqual([]);
      expect(fanoutStatesSize(fix.fanout)).toBe(0);
      // The drop came from the injected port, so no guard warn was logged —
      // proof the replacement is total rather than additive.
      expect(perimeterWarns(fix.warns)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('the injected port fully REPLACES the DB-backed guard — an admit verdict lets through a cross-host frame the guard would drop', () => {
    const admitAll: RuntimeEventPerimeterPort = { assert: () => true };
    const fix = makePerimeterFixture({ perimeter: admitAll });
    try {
      // Host X's connection claiming host Y's agent + conversation: the
      // `agent_host_mismatch` shape the guard rejects two tests above.
      fix.fanout.onEvent(
        fix.hostX.id,
        parsedEventFrame(fix.hostY.channelId, fix.hostY.agentId),
        'conn-1',
      );

      const agentEvent = fix.events.find(
        e => e.conv === fix.hostY.channelId && e.kind === 'agent_event',
      );
      expect(agentEvent).toBeDefined();
      expect(perimeterWarns(fix.warns)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('EventPerimeterGuard itself runs on plain-object read ports — the policy needs three answers, not AgentRepo / ConversationRepo / a Db', () => {
    const warns: PerimeterFixture['warns'] = [];
    const logger: BackendLogger = {
      info: () => {},
      warn: (obj, msg) => warns.push({ obj, msg }),
      error: () => {},
    };
    // The three facts, answered from a literal table. No row ever reaches the
    // guard, so it is structurally unable to depend on one.
    const agents: RuntimePerimeterAgentReadPort = {
      ownerHostIdOf: agentId =>
        ({
          'agent-mine': 'host-1',
          'agent-guest': 'host-1',
          'agent-theirs': 'host-2',
        })[agentId] ?? null,
    };
    const conversations: RuntimePerimeterConversationReadPort = {
      exists: conversationId => conversationId === 'conv-known',
      hasAgent: (conversationId, agentId) =>
        conversationId === 'conv-known' && agentId === 'agent-mine',
    };
    const guard = new EventPerimeterGuard({ agents, conversations, logger });

    // Every arm of the chain, on a guard that has never seen a database.
    expect(guard.assert('host-1', readyEvent())).toBe(true);
    expect(guard.assert('host-1', shuttingDownEvent())).toBe(true);
    expect(
      guard.assert('host-1', parsedEventFrame('conv-known', 'agent-mine')),
    ).toBe(true);
    expect(warns).toEqual([]);

    const reasons: Array<string | undefined> = [];
    for (const frame of [
      parsedEventFrame('conv-known', 'agent-nobody'),
      parsedEventFrame('conv-known', 'agent-theirs'),
      parsedEventFrame('conv-missing', 'agent-mine'),
      parsedEventFrame('conv-known', 'agent-guest'),
    ]) {
      expect(guard.assert('host-1', frame)).toBe(false);
      const obj = warns.at(-1)?.obj;
      const record = isRecord(obj) ? obj : {};
      reasons.push(
        (record.reason as string | undefined) ??
          (record.action as string | undefined),
      );
    }
    expect(reasons).toEqual([
      'outbound_event_unknown_agent',
      'agent_host_mismatch',
      'conversation_unknown',
      'agent_not_in_conversation',
    ]);
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
