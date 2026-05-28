import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EventFrameSchema,
  KNOWN_CAPABILITIES_V1,
  OUTBOUND_DAEMON_EVENT_KINDS,
  type EventFrame,
  type OutboundDaemonEventKind,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type RuntimeStatusResult,
} from '@silverhand/host';
import type { AgentRunState, RuntimeKind } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { AgentTokenStore } from '../../src/auth/agent-token-store.js';
import { RuntimeEventHandler, type EventPublisher } from '../../src/runtime/event-handler.js';
import { DEFAULT_SOFT_DIRECTIVE } from '../../src/runtime/agent-runtime-host.js';
import {
  OutboundRuntimeEventFanout,
  outboundEventToEventFrame,
} from '../../src/runtime/outbound-event-fanout.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { DbRuntimeStatusProjector } from '../../src/runtime/status-projector.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import { openTestDb } from '../utils/db.js';

describe('OutboundRuntimeEventFanout', () => {
  it('keeps outbound event projection in lockstep with EventFrameSchema', () => {
    for (const kind of OUTBOUND_DAEMON_EVENT_KINDS) {
      const projected = outboundEventToEventFrame(outboundEventFixture(kind));
      expect(EventFrameSchema.safeParse(projected).success, kind).toBe(true);
    }
  });

  it('projects outbound daemon events through the same SSE and DB path as the unix-socket handler', () => {
    const unix = makeFixture();
    const outbound = makeFixture();
    try {
      const event: EventFrame = {
        event: 'runtime_parsed_event',
        conversation_id: unix.channelId,
        agent_id: unix.agentId,
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      };
      makeUnixHandler(unix).dispatch(event);

      outbound.fanout.onEvent(outbound.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_parsed_event',
        conversation_id: outbound.channelId,
        agent_id: outbound.agentId,
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      }, 'conn-1');

      expect(normalizeEvents(outbound.events, outbound)).toEqual(
        normalizeEvents(unix.events, unix),
      );
      expect(outbound.row()).toEqual(unix.row());
    } finally {
      unix.cleanup();
      outbound.cleanup();
    }
  });

  it('marks startup delivery consumed rows delivered from outbound events', () => {
    const fix = makeFixture();
    try {
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'deliver me',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_startup_delivery_consumed',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        delivery_ids: [delivery.inboxId],
        ts: 1700000000000,
      }, 'conn-1');

      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('leaves startup delivery failed rows pending for backend retry policy', () => {
    const fix = makeFixture();
    try {
      const msg = fix.messages.insertForConversation({
        conversationId: fix.channelId,
        fromKind: 'user',
        content: 'retry me',
      });
      const delivery = fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);

      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_startup_delivery_failed',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        delivery_ids: [delivery.inboxId],
        reason: 'write_failed',
        ts: 1700000000000,
      }, 'conn-1');

      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toMatchObject([
        { inboxId: delivery.inboxId },
      ]);
    } finally {
      fix.cleanup();
    }
  });

  it('rehydrates from runtime_status on fresh ready after disconnect even for the same daemon pid', async () => {
    const fix = makeFixture();
    try {
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'thinking',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 1);
      expect(fix.fanout.getAgentRunStates(fix.channelId)[0]).toMatchObject({
        status: 'thinking',
      });

      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'idle', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
            updatedAt: 1700000005000,
            lastActivityAt: 1700000005000,
          }),
        ],
      };
      fix.transport.connectionId = 'conn-2';
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');

      await waitFor(() =>
        fix.fanout.getAgentRunStates(fix.channelId)[0]?.status === 'idle',
      );
      expect(fix.fanout.getAgentRunStates(fix.channelId)[0]).toMatchObject({
        status: 'idle',
      });
    } finally {
      fix.cleanup();
    }
  });

  it('replays pending inbox rows only after runtime_ready_for_drain', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'replay me');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      expect(fix.transport.calls.some(call => call.kind === 'runtime_wake')).toBe(false);

      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_wake'));

      const wake = fix.transport.calls.find(call => call.kind === 'runtime_wake');
      expect(wake?.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  it('claims replay rows FIFO and does not issue concurrent wakes for repeated ready_for_drain', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const first = enqueueMessage(fix, 'first');
      const second = enqueueMessage(fix, 'second');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.deferNextWake();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.wakeCalls().length === 1);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await new Promise(resolve => setTimeout(resolve, 25));

      expect(fix.transport.wakeCalls()).toHaveLength(1);
      expect(fix.transport.wakeCalls()[0]!.params).toMatchObject({
        delivery_ids: [first.inboxId, second.inboxId],
      });

      fix.transport.resolveDeferredWake({
        delivered: true,
        delivery_ids: [first.inboxId, second.inboxId],
      });
      await waitFor(() => fix.inbox.listPending(fix.channelId, fix.agentId).length === 0);
    } finally {
      fix.cleanup();
    }
  });

  it('rolls in-flight replay rows back to pending when wake dispatch fails', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'retry after timeout');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.rejectNextWake(new Error('transport_timeout'));

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() =>
        fix.inbox.listPending(fix.channelId, fix.agentId)[0]?.inboxId === delivery.inboxId,
      );
    } finally {
      fix.cleanup();
    }
  });

  it('keeps replay rows pending when daemon refuses wake delivery', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'driver not ready');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.refuseNextWake('driver_not_ready');

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() =>
        fix.inbox.listPending(fix.channelId, fix.agentId)[0]?.inboxId === delivery.inboxId,
      );
    } finally {
      fix.cleanup();
    }
  });

  it('does not turn ready_for_drain replay into the coordinator in-memory queue', async () => {
    const fix = makeFixture({ runtime: 'claude' });
    try {
      const delivery = enqueueMessage(fix, 'claude replay');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'thinking',
          }),
        ],
      };

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, {
        direction: 'daemon_to_server',
        type: 'event',
        kind: 'runtime_parsed_event',
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        parsed: {
          kind: 'tool_call',
          name: 'shell',
          input: { cmd: 'sleep' },
          toolCallId: 'tool-1',
        },
        ts: 1700000000000,
      }, 'conn-1');
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');

      await waitFor(() => fix.transport.wakeCalls().length === 1);
      expect(fix.transport.wakeCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('sweeps old-connection in-flight rows before replaying on the new connection', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(fix, 'connection swap');
      fix.transport.snapshot = {
        runtimes: [
          runtimeDto(fix.channelId, fix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: fix.channelId,
            agentId: fix.agentId,
            status: 'idle',
          }),
        ],
      };
      fix.transport.deferNextWake();

      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => fix.transport.calls.some(call => call.kind === 'runtime_status'));
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-1');
      await waitFor(() => fix.transport.wakeCalls().length === 1);
      expect(fix.inbox.listPending(fix.channelId, fix.agentId)).toEqual([]);

      fix.fanout.onDisconnect(fix.hostId, 'conn-1');
      fix.transport.connectionId = 'conn-2';
      fix.transport.rejectDeferredWake(new Error('transport_disconnected'));
      fix.fanout.onEvent(fix.hostId, readyEvent(), 'conn-2');
      await waitFor(() => fix.transport.calls.filter(call => call.kind === 'runtime_status').length >= 2);
      fix.fanout.onEvent(fix.hostId, readyForDrainEvent(fix), 'conn-2');

      await waitFor(() => fix.transport.wakeCalls().length === 2);
      expect(fix.transport.wakeCalls()[1]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
    } finally {
      fix.cleanup();
    }
  });

  it('uses startup_delivery when no runtime exists and wake when the runtime is ready', async () => {
    const startFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(startFix, 'start me');
      await expect(
        startFix.fanout.startDeliveryBacked(startFix.channelId, startFix.agentId),
      ).resolves.toBe(true);
      expect(startFix.transport.calls.find(call => call.kind === 'runtime_start')?.params)
        .toMatchObject({
          startup_delivery: {
            delivery_ids: [delivery.inboxId],
          },
        });
    } finally {
      startFix.cleanup();
    }

    const wakeFix = makeFixture({ runtime: 'codex' });
    try {
      const delivery = enqueueMessage(wakeFix, 'wake me');
      wakeFix.transport.snapshot = {
        runtimes: [
          runtimeDto(wakeFix.channelId, wakeFix.agentId, 'ready', {
            ...RUN_STATE,
            conversationId: wakeFix.channelId,
            agentId: wakeFix.agentId,
            status: 'idle',
          }),
        ],
      };
      wakeFix.fanout.onEvent(wakeFix.hostId, readyEvent(), 'conn-1');
      await waitFor(() => wakeFix.transport.calls.some(call => call.kind === 'runtime_status'));
      wakeFix.fanout.onEvent(wakeFix.hostId, readyForDrainEvent(wakeFix), 'conn-1');
      await waitFor(() => wakeFix.transport.wakeCalls().length === 1);
      expect(wakeFix.transport.wakeCalls()[0]!.params).toMatchObject({
        delivery_ids: [delivery.inboxId],
      });
      expect(wakeFix.transport.calls.some(call => call.kind === 'runtime_start')).toBe(false);
    } finally {
      wakeFix.cleanup();
    }
  });

  it('fails before wire when the agent host is revoked', async () => {
    const fix = makeFixture({ runtime: 'codex' });
    try {
      enqueueMessage(fix, 'no revoked host send');
      new HostRepo(fix.db).revoke(fix.hostId);

      await expect(
        fix.fanout.startDeliveryBacked(fix.channelId, fix.agentId),
      ).rejects.toThrow(/revoked/);
      expect(fix.transport.calls).toEqual([]);
    } finally {
      fix.cleanup();
    }
  });

  // ── P2 (D4.b post-review) — soft stop default directive ──
  //
  // Pins the `RuntimeStopParamsSchema.superRefine` contract that
  // soft stops MUST carry `soft_directive`. Pre-fix,
  // `OutboundRuntimeEventFanout.stop` forwarded `softDirective`
  // only when not undefined — so `stop(..., 'soft')` with no
  // directive sent `{mode:'soft'}` and got rejected daemon-side
  // (`runtime_stop_params_invalid`). The fix mirrors
  // `DaemonAgentRuntimeHost.stop` and substitutes
  // `DEFAULT_SOFT_DIRECTIVE` when the caller omits one — both
  // deployment adapters now produce the same wire envelope (R4 —
  // same envelope, transport-only divergence).
  //
  // Three arms: hard MUST omit `soft_directive`; soft with no
  // directive substitutes the default; soft with explicit
  // directive forwards it verbatim.
  it('soft stop without directive substitutes DEFAULT_SOFT_DIRECTIVE; hard stop omits it', async () => {
    const fix = makeFixture();
    try {
      await fix.fanout.stop(fix.channelId, fix.agentId, 'hard');
      await fix.fanout.stop(fix.channelId, fix.agentId, 'soft');
      await fix.fanout.stop(
        fix.channelId,
        fix.agentId,
        'soft',
        'explicit caller directive',
      );

      const stops = fix.transport.calls.filter(c => c.kind === 'runtime_stop');
      expect(stops).toHaveLength(3);

      // Arm 1: hard — soft_directive must NOT appear on the wire
      // (superRefine treats its presence on hard as invalid).
      expect(stops[0]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'hard',
      });
      expect('soft_directive' in stops[0]!.params).toBe(false);

      // Arm 2: soft, no caller directive — substitute default.
      // Pin the exact text so a future module rename / refactor
      // that silently swaps the constant fails this assertion.
      expect(stops[1]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'soft',
        soft_directive: DEFAULT_SOFT_DIRECTIVE,
      });
      expect(stops[1]!.params.soft_directive).toBe(
        '[user requested a course correction — pause your current direction and ' +
          'wait for the next instruction]',
      );

      // Arm 3: soft, explicit caller directive — forward verbatim.
      expect(stops[2]!.params).toEqual({
        conversation_id: fix.channelId,
        agent_id: fix.agentId,
        mode: 'soft',
        soft_directive: 'explicit caller directive',
      });
    } finally {
      fix.cleanup();
    }
  });
});

interface Fixture {
  db: ReturnType<typeof openTestDb>['db'];
  hostId: string;
  channelId: string;
  agentId: string;
  events: Array<{ conv: string; kind: string; payload: unknown }>;
  messages: MessageRepo;
  inbox: ConversationInboxRepo;
  transport: FakeTransport;
  fanout: OutboundRuntimeEventFanout;
  row(): { status: string; pid: number | null; cli_session_id: string | null };
  cleanup(): void;
}

function makeFixture(opts: { runtime?: RuntimeKind } = {}): Fixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const workspacesRoot = join(tmpdir(), 'silverhand-outbound-fanout-test');
  const workspaces = new WorkspaceRepo(db, { workspacesRoot });
  const workspacePath = workspaces.workspacePathFor('fanout-ws');
  const workspace = workspaces.insert({
    name: 'fanout-ws',
    description: null,
    workspacePath,
    workspaceHostId: localHostId,
  });
  const conversations = new ConversationRepo(db);
  const channel = conversations.insertChannel({
    workspaceId: workspace.id,
    workspacePath,
    title: 'fanout',
  });
  const agent = new AgentRepo(db).create(
    { name: 'agent', runtime: opts.runtime ?? 'claude', host_id: localHostId },
    localHostId,
    viewerUserId,
  );
  conversations.addAgent(channel.id, agent.id);
  conversations.updateAgentRuntime(channel.id, agent.id, {
    status: 'starting',
  });

  const events: Fixture['events'] = [];
  const publisher: EventPublisher = {
    publish: (conv, payload) =>
      events.push({ conv, kind: payload.kind, payload: payload.payload }),
  };
  const transport = new FakeTransport();
  const fanout = new OutboundRuntimeEventFanout({
    db,
    events: publisher,
    transport: () => transport,
    logger: SILENT_LOGGER,
    silverhandDir: join(tmpdir(), 'silverhand-outbound-fanout-silverhand'),
    workspacesRoot,
    silverhandCli: { command: 'silverhand', args: [] },
    agentTokens: new AgentTokenStore(),
    serverUrl: () => 'http://127.0.0.1:1',
    proxyPolicy: () => ({ url: null, allowlist: [] }),
    activityLog: null,
  });
  const messages = new MessageRepo(db);
  const inbox = new ConversationInboxRepo(db);

  return {
    db,
    hostId: localHostId,
    channelId: channel.id,
    agentId: agent.id,
    events,
    messages,
    inbox,
    transport,
    fanout,
    row: () => {
      const row = conversations.getAgent(channel.id, agent.id);
      if (!row) throw new Error('conversation agent row missing');
      return {
        status: row.status,
        pid: row.pid,
        cli_session_id: row.cli_session_id,
      };
    },
    cleanup: () => {
      db.close();
    },
  };
}

function makeUnixHandler(fix: Fixture): RuntimeEventHandler {
  return new RuntimeEventHandler({
    client: { subscribe: () => () => {}, onReconnect: () => () => {} } as never,
    bridge: { runtimeStatus: async () => ({ runtimes: [] }) },
    cache: new RunStateCache(),
    events: {
      publish: (conv, payload) =>
        fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
    },
    inboxAck: { markDelivered: () => {}, markUndelivered: () => {} },
    statusProjector: new DbRuntimeStatusProjector(
      new ConversationRepo(fix.db),
      {
        publish: (conv, payload) =>
          fix.events.push({ conv, kind: payload.kind, payload: payload.payload }),
      },
    ),
    logger: SILENT_LOGGER,
  });
}

function normalizeEvents(events: Fixture['events'], fix: Fixture): Fixture['events'] {
  return events.map(event => ({
    conv: event.conv === fix.channelId ? '<conversation>' : event.conv,
    kind: event.kind,
    payload: replaceIds(event.payload, fix),
  }));
}

function replaceIds(value: unknown, fix: Fixture): unknown {
  if (Array.isArray(value)) return value.map(item => replaceIds(item, fix));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === fix.agentId) out[key] = '<agent>';
    else if (raw === fix.channelId) out[key] = '<conversation>';
    else out[key] = replaceIds(raw, fix);
  }
  return out;
}

function enqueueMessage(fix: Fixture, content: string): { inboxId: number } {
  const msg = fix.messages.insertForConversation({
    conversationId: fix.channelId,
    fromKind: 'user',
    content,
  });
  return fix.inbox.ensureDelivery(fix.channelId, fix.agentId, msg.id);
}

class FakeTransport implements HostWsServerController {
  calls: Array<{
    hostId: string;
    kind: string;
    params: Record<string, unknown>;
  }> = [];
  snapshot: RuntimeStatusResult = { runtimes: [] };
  connectionId = 'conn-1';
  private deferredWake:
    | {
        resolve: (value: unknown) => void;
        reject: (err: Error) => void;
      }
    | null = null;
  private nextWakeError: Error | null = null;
  private nextWakeRefusal:
    | {
        reason: 'driver_not_ready';
      }
    | null = null;

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
    // Fanout-coordinator tests don't depend on boot-readiness wiring.
    return null;
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>> {
    if (opts?.expectedConnectionId && opts.expectedConnectionId !== this.connectionId) {
      return Promise.reject(new Error('connection changed'));
    }
    this.calls.push({ hostId, kind, params: params as Record<string, unknown> });
    if (kind === 'runtime_status') {
      return Promise.resolve(this.snapshot) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_wake') {
      if (this.nextWakeError) {
        const err = this.nextWakeError;
        this.nextWakeError = null;
        return Promise.reject(err);
      }
      if (this.nextWakeRefusal) {
        const refusal = this.nextWakeRefusal;
        this.nextWakeRefusal = null;
        return Promise.resolve({
          delivered: false,
          delivery_ids: [...((params as { delivery_ids: number[] }).delivery_ids)],
          reason: refusal.reason,
        }) as Promise<OutboundServerCommandResult<K>>;
      }
      if (this.deferredWake) {
        return new Promise<OutboundServerCommandResult<K>>((resolve, reject) => {
          this.deferredWake = {
            resolve: value => resolve(value as OutboundServerCommandResult<K>),
            reject,
          };
        });
      }
      return Promise.resolve({
        delivered: true,
        delivery_ids: [...((params as { delivery_ids: number[] }).delivery_ids)],
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    if (kind === 'runtime_start') {
      return Promise.resolve({
        started: true,
        pid: 123,
        started_at: 1700000000000,
        ...((params as { startup_delivery?: unknown }).startup_delivery
          ? { startup_delivery_accepted: true }
          : {}),
      }) as Promise<OutboundServerCommandResult<K>>;
    }
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
  }

  wakeCalls(): Array<{ params: Record<string, unknown> }> {
    return this.calls.filter(call => call.kind === 'runtime_wake');
  }

  deferNextWake(): void {
    this.deferredWake = {
      resolve: () => {},
      reject: () => {},
    };
  }

  resolveDeferredWake(value: unknown): void {
    const deferred = this.deferredWake;
    this.deferredWake = null;
    deferred?.resolve(value);
  }

  rejectDeferredWake(err: Error): void {
    const deferred = this.deferredWake;
    this.deferredWake = null;
    deferred?.reject(err);
  }

  rejectNextWake(err: Error): void {
    this.nextWakeError = err;
  }

  refuseNextWake(reason: 'driver_not_ready'): void {
    this.nextWakeRefusal = { reason };
  }

  // D4.c C2 — fanout-coordinator tests don't drive the revoke route.
  disconnectHost(_hostId: string): boolean {
    return false;
  }

  async close(): Promise<void> {
    // no-op
  }
}

const RUN_STATE: AgentRunState = {
  runId: 'r1',
  agentId: 'agent',
  conversationId: 'conversation',
  status: 'thinking',
  startedAt: 1700000000000,
  updatedAt: 1700000000000,
  lastActivityAt: 1700000000000,
};

function runtimeDto(
  conversationId: string,
  agentId: string,
  phase: 'idle' | 'spawning' | 'startup_pending' | 'ready' | 'draining' | 'exited',
  runState: AgentRunState,
): RuntimeStatusResult['runtimes'][number] {
  return {
    conversation_id: conversationId,
    agent_id: agentId,
    pid: 123,
    phase,
    run_state: runState,
    started_at: 1700000000000,
  };
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

function readyForDrainEvent(fix: Fixture): OutboundDaemonToServerEventFrame {
  return {
    direction: 'daemon_to_server',
    type: 'event',
    kind: 'runtime_ready_for_drain',
    conversation_id: fix.channelId,
    agent_id: fix.agentId,
    ts: 1700000001000,
  };
}

function outboundEventFixture(kind: OutboundDaemonEventKind): OutboundDaemonToServerEventFrame {
  switch (kind) {
    case 'ready':
      return readyEvent();
    case 'shutting_down':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        reason: 'test',
      };
    case 'runtime_state':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        state: RUN_STATE,
        ts: 1700000000000,
      };
    case 'runtime_output':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        stream: 'stdout',
        chunk: 'hello',
        ts: 1700000000000,
      };
    case 'runtime_exit':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        code: 0,
        intentional: true,
        ts: 1700000000000,
      };
    case 'runtime_ready_for_drain':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        ts: 1700000000000,
      };
    case 'runtime_startup_delivery_consumed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        ts: 1700000000000,
      };
    case 'runtime_startup_delivery_failed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [1],
        reason: 'write_failed',
        ts: 1700000000000,
      };
    case 'runtime_init_timeout':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        timeout_reason: 'silence',
        elapsed_ms: 1000,
        timeout_ms: 30000,
        retrying: true,
        retry_attempt: 1,
        max_retries: 3,
        ts: 1700000000000,
      };
    case 'runtime_init_retrying':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        retry_attempt: 1,
        max_retries: 3,
        delay_ms: 1000,
        ts: 1700000000000,
      };
    case 'runtime_init_cooldown':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        cooldown_until: 1700000100000,
        attempts_exhausted: 3,
        ts: 1700000000000,
      };
    case 'runtime_compaction_stale':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        elapsed_ms: 1000,
        ts: 1700000000000,
      };
    case 'runtime_output_dropped':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        dropped_count: 1,
        bytes_dropped: 100,
        since_ts: 1700000000000,
      };
    case 'runtime_output_paused':
    case 'runtime_output_resumed':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
      };
    case 'runtime_parsed_event':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed: { kind: 'session_init', sessionId: 'sess-1' },
        ts: 1700000000000,
      };
    case 'runtime_parsed_event_dropped':
      return {
        direction: 'daemon_to_server',
        type: 'event',
        kind,
        conversation_id: 'c1',
        agent_id: 'a1',
        parsed_kind: 'tool_call',
        encoded_bytes: 1000000,
        reason: 'frame_too_large',
        ts: 1700000000000,
      };
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unhandled outbound event kind ${_exhaustive}`);
    }
  }
}

const SILENT_LOGGER = {
  info() {},
  warn() {},
  error() {},
};

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for condition');
}
