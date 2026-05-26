import type { Database } from 'better-sqlite3';
import {
  EventFrameSchema,
  type EventFrame,
  type HostClient,
  type OutboundDaemonToServerEventFrame,
} from '@silverhand/host';
import type { AgentRunState, AgentRunTerminalReason } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import type { HostWsEventSink, HostWsServerController } from '../ws/host-ws-server.js';
import { JsonlActivityLogWriter, type ActivityLogWriter } from './activity-log-writer.js';
import {
  RuntimeEventHandler,
  type EventPublisher,
  type InboxAckSink,
  type RuntimeStatusBridge,
} from './event-handler.js';
import { RunStateCache } from './run-state-cache.js';
import { DbRuntimeStatusProjector } from './status-projector.js';

export interface OutboundRuntimeEventFanoutOptions {
  db: Database;
  events: EventPublisher;
  transport: () => HostWsServerController | null;
  logger: BackendLogger;
  logDir?: string;
  activityLog?: ActivityLogWriter | null;
}

interface HostFanoutState {
  cache: RunStateCache;
  handler: RuntimeEventHandler;
}

const OUTBOUND_SOCKET_SENTINEL = 'outbound-ws';

export class OutboundRuntimeEventFanout implements HostWsEventSink {
  private readonly states = new Map<string, HostFanoutState>();
  private readonly inboxAck: InboxAckSink;
  private readonly activityLog: ActivityLogWriter | null;
  private readonly ownsActivityLog: boolean;

  constructor(private readonly opts: OutboundRuntimeEventFanoutOptions) {
    const inboxRepo = new ConversationInboxRepo(opts.db);
    this.inboxAck = {
      markDelivered: ids => inboxRepo.markDelivered([...ids]),
      markUndelivered: (ids, reason) => {
        opts.logger.warn(
          { kind: 'inbox', delivery_ids: [...ids], reason },
          'outbound startup delivery failed; rows remain pending',
        );
      },
    };
    if (opts.activityLog !== undefined) {
      this.activityLog = opts.activityLog;
      this.ownsActivityLog = false;
    } else if (opts.logDir) {
      this.activityLog = new JsonlActivityLogWriter({
        logDir: opts.logDir,
        logger: opts.logger,
      });
      this.ownsActivityLog = true;
    } else {
      this.activityLog = null;
      this.ownsActivityLog = false;
    }
  }

  onEvent(hostId: string, event: OutboundDaemonToServerEventFrame): void {
    this.stateForHost(hostId).handler.dispatch(outboundEventToEventFrame(event));
  }

  onDisconnect(hostId: string): void {
    const state = this.states.get(hostId);
    if (!state) return;
    state.cache.clearAll();
  }

  getAgentRunStates(conversationId: string): AgentRunState[] {
    const states: AgentRunState[] = [];
    for (const state of this.states.values()) {
      for (const entry of state.cache.list()) {
        if (!entry.runState || entry.conversationId !== conversationId) continue;
        states.push(entry.runState);
      }
    }
    return states;
  }

  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    for (const state of this.states.values()) {
      const terminal = state.cache.resolveRun(
        conversationId,
        agentId,
        reason,
        runId,
      );
      if (!terminal) continue;
      this.opts.events.publish(conversationId, {
        kind: 'agent_activity',
        payload: terminal,
      });
      this.activityLog?.write(terminal);
    }
  }

  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    for (const state of this.states.values()) {
      const terminals = state.cache.resolveConversationRuns(conversationId, reason);
      for (const terminal of terminals) {
        this.opts.events.publish(conversationId, {
          kind: 'agent_activity',
          payload: terminal,
        });
        this.activityLog?.write(terminal);
      }
    }
  }

  async close(): Promise<void> {
    this.states.clear();
    if (this.ownsActivityLog) await this.activityLog?.close();
  }

  private stateForHost(hostId: string): HostFanoutState {
    const existing = this.states.get(hostId);
    if (existing) return existing;

    const cache = new RunStateCache();
    const bridge: RuntimeStatusBridge = {
      runtimeStatus: async () => {
        const transport = this.opts.transport();
        if (!transport) {
          throw new Error(`outbound host ${hostId} has no command transport`);
        }
        return transport.sendCommand(hostId, 'runtime_status', {}, { timeoutMs: 5_000 });
      },
    };
    const handler = new RuntimeEventHandler({
      client: noopHostClient(),
      bridge,
      cache,
      events: this.opts.events,
      inboxAck: this.inboxAck,
      statusProjector: new DbRuntimeStatusProjector(
        new ConversationRepo(this.opts.db),
        this.opts.events,
      ),
      activityLog: this.activityLog ?? undefined,
      logger: this.opts.logger,
    });
    const state = { cache, handler };
    this.states.set(hostId, state);
    return state;
  }
}

export function outboundEventToEventFrame(
  frame: OutboundDaemonToServerEventFrame,
): EventFrame {
  const { direction: _direction, type: _type, kind, ...rest } = frame;
  const candidate =
    kind === 'ready'
      ? { ...rest, event: kind, socket_path: OUTBOUND_SOCKET_SENTINEL }
      : { ...rest, event: kind };
  const parsed = EventFrameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `invalid outbound event projection ${kind}: ${parsed.error.errors
        .map(e => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

function noopHostClient(): HostClient {
  return {
    subscribe: () => () => {},
    onReconnect: () => () => {},
  } as unknown as HostClient;
}
