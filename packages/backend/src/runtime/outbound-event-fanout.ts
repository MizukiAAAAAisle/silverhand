import type { Database } from 'better-sqlite3';
import {
  EventFrameSchema,
  type EventFrame,
  type HostClient,
  type OutboundDaemonToServerEventFrame,
  type RuntimeStartParams,
} from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type { AgentRunState, AgentRunTerminalReason } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import { AgentRepo } from '../repos/agent-repo.js';
import {
  ConversationInboxRepo,
  type ClaimedConversationInboxItem,
} from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { HostRepo } from '../repos/host-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import type {
  HostWsEventSink,
  HostWsServerController,
} from '../ws/host-ws-server.js';
import { singleConversationViewerUserId } from '../viewer-scope.js';
import { JsonlActivityLogWriter, type ActivityLogWriter } from './activity-log-writer.js';
import { RuntimeDeliveryCoordinator } from './delivery-coordinator.js';
import {
  RuntimeEventHandler,
  type EventPublisher,
  type InboxAckSink,
  type RuntimeStatusBridge,
} from './event-handler.js';
import { RunStateCache } from './run-state-cache.js';
import {
  combineGatedBatch,
  formatInboxBatch,
  sendMessageToolName,
} from './stdin-format.js';
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
  coordinator: RuntimeDeliveryCoordinator;
  handler: RuntimeEventHandler;
  currentConnectionId: string | null;
  currentDaemonKey: string | null;
}

interface PendingDeliveryBatch {
  deliveryIds: number[];
  text: string;
  agentRuntime: string;
  agentName: string;
  driver: ReturnType<typeof getDriver>;
}

// EventFrameSchema.ready historically models the Unix-socket daemon handshake
// and requires socket_path. Outbound WS drops that local filesystem field; this
// sentinel exists only to reuse the existing RuntimeEventHandler ready branch.
// Do not feed it into path joins or daemon-local filesystem code.
const OUTBOUND_SOCKET_SENTINEL = 'outbound-ws';

export class OutboundRuntimeEventFanout implements HostWsEventSink {
  private readonly states = new Map<string, HostFanoutState>();
  private readonly inboxRepo: ConversationInboxRepo;
  private readonly conversations: ConversationRepo;
  private readonly agents: AgentRepo;
  private readonly hosts: HostRepo;
  private readonly users: UserRepo;
  private readonly inboxAck: InboxAckSink;
  private readonly activityLog: ActivityLogWriter | null;
  private readonly ownsActivityLog: boolean;

  constructor(private readonly opts: OutboundRuntimeEventFanoutOptions) {
    this.inboxRepo = new ConversationInboxRepo(opts.db);
    this.conversations = new ConversationRepo(opts.db);
    this.agents = new AgentRepo(opts.db);
    this.hosts = new HostRepo(opts.db);
    this.users = new UserRepo(opts.db);
    this.inboxAck = {
      markDelivered: ids => this.inboxRepo.markDelivered([...ids]),
      markUndelivered: (ids, reason) => {
        this.inboxRepo.rollbackInFlightAnyOwner(ids);
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

  onEvent(
    hostId: string,
    event: OutboundDaemonToServerEventFrame,
    connectionId: string,
  ): void {
    const state = this.stateForHost(hostId);
    state.currentConnectionId = connectionId;
    if (event.kind === 'ready') {
      state.currentDaemonKey = daemonKeyFromReady(
        event.daemon_pid,
        event.started_at,
      );
    } else if (
      event.kind === 'runtime_ready_for_drain' &&
      state.currentDaemonKey
    ) {
      // ready_for_drain is the delivery-backed replay trigger. It can race the
      // fire-and-forget ready hydrate, so seed a phase-only cache entry before
      // dispatching. The following runtime_status hydrate remains authoritative
      // and will reconcile the full snapshot.
      state.cache.applyPhase(
        state.currentDaemonKey,
        event.conversation_id,
        event.agent_id,
        'ready',
      );
    }
    state.handler.dispatch(outboundEventToEventFrame(event));
  }

  onDisconnect(hostId: string, connectionId: string): void {
    this.inboxRepo.rollbackInFlightForOwner(connectionId);
    const state = this.states.get(hostId);
    if (!state) return;
    if (state.currentConnectionId === connectionId) {
      state.currentConnectionId = null;
      state.currentDaemonKey = null;
      for (const entry of state.cache.list()) {
        state.coordinator.clearRuntime(
          entry.conversationId,
          entry.agentId,
          'stopped',
        );
      }
      state.cache.clearAll();
    }
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    const delivery = this.inboxRepo.ensureDelivery(
      conversationId,
      agentId,
      messageId,
    );
    if (delivery.deliveredAt !== null) return;
    const hostId = this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId);
    const entry = this.stateForHost(hostId).cache.get(conversationId, agentId);
    if (!entry || entry.phase === 'idle' || entry.phase === 'exited') {
      await this.startDeliveryBacked(conversationId, agentId);
      return;
    }
    if (entry.phase === 'ready') {
      await this.deliverLivePendingForAgent(
        hostId,
        connectionId,
        conversationId,
        agentId,
      );
    }
  }

  async startDeliveryBacked(
    conversationId: string,
    agentId: string,
  ): Promise<boolean> {
    if (this.inboxRepo.listPending(conversationId, agentId).length === 0) {
      return false;
    }
    const hostId = this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId);
    const state = this.stateForHost(hostId);
    const entry = state.cache.get(conversationId, agentId);
    if (entry && entry.phase !== 'idle' && entry.phase !== 'exited') {
      if (entry.phase === 'ready') {
        await this.replayPendingForAgent(
          hostId,
          connectionId,
          conversationId,
          agentId,
        );
      }
      return true;
    }

    const claimed = this.inboxRepo.claimPending(
      conversationId,
      agentId,
      connectionId,
    );
    if (claimed.length === 0) return false;
    const batch = this.pendingBatch(conversationId, agentId, claimed);
    const transport = this.requireTransport();
    try {
      const result = await transport.sendCommand(
        hostId,
        'runtime_start',
        {
          conversation_id: conversationId,
          agent_id: agentId,
          options: {
            runtime: batch.agentRuntime,
            agent_name: batch.agentName,
            initial_prompt: '',
          },
          startup_delivery: {
            delivery_ids: batch.deliveryIds,
            text: batch.text,
          },
        } satisfies RuntimeStartParams,
        { timeoutMs: 60_000, expectedConnectionId: connectionId },
      );
      if (!result.started || result.startup_delivery_accepted !== true) {
        this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      }
      return true;
    } catch (err) {
      this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
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
    const state: HostFanoutState = {
      cache,
      coordinator: undefined as unknown as RuntimeDeliveryCoordinator,
      handler: undefined as unknown as RuntimeEventHandler,
      currentConnectionId: null,
      currentDaemonKey: null,
    };
    const bridge: RuntimeStatusBridge = {
      runtimeStatus: async () => {
        const transport = this.requireTransport();
        return transport.sendCommand(
          hostId,
          'runtime_status',
          {},
          {
            timeoutMs: 5_000,
            ...(state.currentConnectionId
              ? { expectedConnectionId: state.currentConnectionId }
              : {}),
          },
        );
      },
    };
    const coordinator = new RuntimeDeliveryCoordinator({
      bridge: {
        runtimeWake: params => {
          const connectionId = state.currentConnectionId;
          if (!connectionId) {
            return Promise.reject(
              new Error('outbound connection changed before runtime_wake'),
            );
          }
          const transport = this.requireTransport();
          return transport.sendCommand(hostId, 'runtime_wake', params, {
            timeoutMs: 10_000,
            expectedConnectionId: connectionId,
          });
        },
      },
      cache,
      inboxAck: {
        markDelivered: ids => this.inboxRepo.markDelivered([...ids]),
      },
      callbacks: {
        hasPendingInbox: (cid, aid) =>
          this.inboxRepo.listPending(cid, aid).length > 0,
        combineGated: texts =>
          combineGatedBatch(texts, 'silverhand message send'),
        publishActivity: runState => {
          this.opts.events.publish(runState.conversationId, {
            kind: 'agent_activity',
            payload: runState,
          });
          this.activityLog?.write(runState);
        },
      },
      logger: this.opts.logger,
    });
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
      onParsedEvent: (cid, aid, event) =>
        coordinator.onParsedEvent(cid, aid, event),
      onRuntimeExit: (cid, aid, meta) =>
        coordinator.onRuntimeExit(cid, aid, meta),
      onInitTimeout: (cid, aid) =>
        coordinator.clearWakeWatchdog(cid, aid, 'timeout'),
      onReadyForDrain: (cid, aid) => {
        const connectionId = state.currentConnectionId;
        if (!connectionId) {
          this.opts.logger.warn(
            { kind: 'inbox', hostId, conversationId: cid, agent_id: aid },
            'outbound ready_for_drain has no current connection; pending inbox rows remain pending',
          );
          return;
        }
        return this.replayPendingForAgent(hostId, connectionId, cid, aid);
      },
      activityLog: this.activityLog ?? undefined,
      logger: this.opts.logger,
    });
    state.coordinator = coordinator;
    state.handler = handler;
    this.states.set(hostId, state);
    return state;
  }

  private async replayPendingForAgent(
    hostId: string,
    connectionId: string,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    const claimed = this.inboxRepo.claimPending(
      conversationId,
      agentId,
      connectionId,
    );
    if (claimed.length === 0) return;
    const batch = this.pendingBatch(conversationId, agentId, claimed);
    try {
      const decision = await this.stateForHost(
        hostId,
      ).coordinator.submitReadyForDrainDeliveryBatch(
        conversationId,
        agentId,
        [{
          deliveryIds: batch.deliveryIds,
          dedupKey: claimed[0]!.message.id,
          text: batch.text,
          driver: {
            runtime: batch.agentRuntime,
            oneShot: batch.driver.oneShot,
            busyDeliveryMode: batch.driver.busyDeliveryMode,
            kickoffMode: batch.driver.kickoffMode,
          },
        }],
      );
      if (decision.kind !== 'wake_dispatched') {
        this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      }
    } catch (err) {
      this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
  }

  private async deliverLivePendingForAgent(
    hostId: string,
    connectionId: string,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    const claimed = this.inboxRepo.claimPending(
      conversationId,
      agentId,
      connectionId,
    );
    if (claimed.length === 0) return;
    const batch = this.pendingBatch(conversationId, agentId, claimed);
    try {
      const decision = await this.stateForHost(
        hostId,
      ).coordinator.submitLiveDeliveryBatch(
        conversationId,
        agentId,
        [{
          deliveryIds: batch.deliveryIds,
          dedupKey: claimed[0]!.message.id,
          text: batch.text,
          driver: {
            runtime: batch.agentRuntime,
            oneShot: batch.driver.oneShot,
            busyDeliveryMode: batch.driver.busyDeliveryMode,
            kickoffMode: batch.driver.kickoffMode,
          },
        }],
      );
      if (decision.kind !== 'wake_dispatched') {
        this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      }
    } catch (err) {
      this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
  }

  private pendingBatch(
    conversationId: string,
    agentId: string,
    claimed: readonly ClaimedConversationInboxItem[],
  ): PendingDeliveryBatch {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const driver = getDriver(agent.runtime);
    return {
      deliveryIds: claimed.map(row => row.inboxId),
      text: formatInboxBatch(
        [...claimed],
        id => this.agents.get(id)?.name,
        id => this.users.get(id)?.name,
        this.defaultUserHandle(conversationId),
        agent.name,
        sendMessageToolName(driver),
      ),
      agentRuntime: agent.runtime,
      agentName: agent.name,
      driver,
    };
  }

  private defaultUserHandle(conversationId: string): string | undefined {
    const viewerId = singleConversationViewerUserId(
      this.conversations,
      conversationId,
    );
    if (!viewerId) return undefined;
    return this.users.get(viewerId)?.name ?? undefined;
  }

  private hostIdForAgent(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const host = this.hosts.get(agent.host_id);
    if (!host) {
      throw new Error(`host ${agent.host_id} for agent ${agentId} not found`);
    }
    if (host.revoked_at !== null) {
      throw new Error(`host ${host.id} for agent ${agentId} has been revoked`);
    }
    return host.id;
  }

  private connectedConnectionId(hostId: string): string {
    const transport = this.requireTransport();
    const connectionId = transport.connectionIdForHost(hostId);
    if (!connectionId) {
      throw new Error(`outbound host ${hostId} is not connected`);
    }
    return connectionId;
  }

  private requireTransport(): HostWsServerController {
    const transport = this.opts.transport();
    if (!transport) {
      throw new Error('outbound host command transport is not installed');
    }
    return transport;
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

function daemonKeyFromReady(daemonPid: number, startedAt: number): string {
  return `${daemonPid}@${startedAt}`;
}
