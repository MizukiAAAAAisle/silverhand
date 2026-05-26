import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_CAPABILITIES_V1,
  type EventFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type OutboundServerCommandParams,
  type OutboundServerCommandResult,
  type RuntimeStatusResult,
} from '@silverhand/host';
import type { AgentRunState } from '@silverhand/shared';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { RuntimeEventHandler, type EventPublisher } from '../../src/runtime/event-handler.js';
import { OutboundRuntimeEventFanout } from '../../src/runtime/outbound-event-fanout.js';
import { RunStateCache } from '../../src/runtime/run-state-cache.js';
import { DbRuntimeStatusProjector } from '../../src/runtime/status-projector.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import { openTestDb } from '../utils/db.js';

describe('OutboundRuntimeEventFanout', () => {
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
      });

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
      });

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
      });

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

      fix.fanout.onEvent(fix.hostId, readyEvent());
      await waitFor(() => fix.fanout.getAgentRunStates(fix.channelId).length === 1);
      expect(fix.fanout.getAgentRunStates(fix.channelId)[0]).toMatchObject({
        status: 'thinking',
      });

      fix.fanout.onDisconnect(fix.hostId);
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
      fix.fanout.onEvent(fix.hostId, readyEvent());

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

function makeFixture(): Fixture {
  const { db, viewerUserId, localHostId } = openTestDb();
  const workspaces = new WorkspaceRepo(db, {
    workspacesRoot: join(tmpdir(), 'silverhand-outbound-fanout-test'),
  });
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
    { name: 'agent', runtime: 'claude', host_id: localHostId },
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

class FakeTransport implements HostWsServerController {
  calls: Array<{ hostId: string; kind: string; params: unknown }> = [];
  snapshot: RuntimeStatusResult = { runtimes: [] };

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['local'];
  }

  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    this.calls.push({ hostId, kind, params });
    if (kind === 'runtime_status') {
      return Promise.resolve(this.snapshot) as Promise<OutboundServerCommandResult<K>>;
    }
    return Promise.resolve({}) as Promise<OutboundServerCommandResult<K>>;
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
