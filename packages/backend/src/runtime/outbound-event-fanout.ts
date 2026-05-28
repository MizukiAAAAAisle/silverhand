import type { Database } from 'better-sqlite3';
import {
  EventFrameSchema,
  type EventFrame,
  type HostClient,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type RuntimeStartParams,
  type RuntimeStopParams,
} from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type { AgentRunState, AgentRunTerminalReason } from '@silverhand/shared';
import type { AgentTokenStore } from '../auth/agent-token-store.js';
import type { BackendLogger, SilverhandCliLauncher } from '../context.js';
import { AgentRepo } from '../repos/agent-repo.js';
import {
  ConversationInboxRepo,
  type ClaimedConversationInboxItem,
} from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { HostRepo } from '../repos/host-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { MembershipService } from '../services/membership-service.js';
import type {
  HostWsEventSink,
  HostWsServerController,
} from '../ws/host-ws-server.js';
import { HostWsCommandTransportError } from '../ws/host-ws-server.js';
import { singleConversationViewerUserId } from '../viewer-scope.js';
import { JsonlActivityLogWriter, type ActivityLogWriter } from './activity-log-writer.js';
import { DEFAULT_SOFT_DIRECTIVE } from './agent-runtime-host.js';
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
import {
  buildRuntimeStartOptions,
  type RuntimeStartProxyPolicy,
} from './runtime-start-options.js';

export interface OutboundRuntimeEventFanoutOptions {
  db: Database;
  events: EventPublisher;
  transport: () => HostWsServerController | null;
  logger: BackendLogger;
  silverhandDir: string;
  workspacesRoot: string;
  silverhandCli: SilverhandCliLauncher;
  agentTokens: AgentTokenStore;
  serverUrl: () => string;
  proxyPolicy: () => RuntimeStartProxyPolicy;
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
  private readonly workspaces: WorkspaceRepo;
  private readonly membership: MembershipService;
  private readonly inboxAck: InboxAckSink;
  private readonly activityLog: ActivityLogWriter | null;
  private readonly ownsActivityLog: boolean;

  constructor(private readonly opts: OutboundRuntimeEventFanoutOptions) {
    this.inboxRepo = new ConversationInboxRepo(opts.db);
    this.conversations = new ConversationRepo(opts.db);
    this.agents = new AgentRepo(opts.db);
    this.hosts = new HostRepo(opts.db);
    this.users = new UserRepo(opts.db);
    this.workspaces = new WorkspaceRepo(opts.db, {
      workspacesRoot: opts.workspacesRoot,
    });
    this.membership = new MembershipService({
      agents: new AgentRepo(opts.db),
      users: new UserRepo(opts.db),
      conversations: new ConversationRepo(opts.db),
    });
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
      // D4.b P1-2 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1): auto-drain
      // is wired through the handler's `onHydrateComplete` callback
      // (see `stateForHost` below), NOT here on `ready`. The handler's
      // `onDaemonReady(ready)` path triggers a fire-and-forget
      // `hydrateSafely('daemon_ready', ...)` that fetches the
      // daemon's `runtime_status` snapshot and populates the cache;
      // only after that is the per-pair phase check (`ready` →
      // wake, absent → spawn) authoritative. Firing the drain on
      // `ready` itself raced the hydrate and took the wrong branch.
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
    const connectionId = this.connectedConnectionId(hostId, 'runtime_wake');
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

  /**
   * D4.b-4: dispatch `runtime_stop` over the outbound WS. The
   * standalone backend owns the projection of the resulting
   * `runtime_exit` event (`RuntimeStatusProjector.runtimeExit`).
   *
   * Per `RuntimeStopParamsSchema`'s `superRefine`:
   *   - `mode='hard'` MUST omit `soft_directive`.
   *   - `mode='soft'` REQUIRES a `soft_directive`. When the caller
   *     doesn't pass one we substitute `DEFAULT_SOFT_DIRECTIVE`,
   *     mirroring `DaemonAgentRuntimeHost.stop` so both deployment
   *     adapters land the same default phrasing on the wire (R4 —
   *     same envelope, transport-only divergence). Sending soft
   *     without a directive would otherwise hit
   *     `daemon → runtime_stop_params_invalid` and fail the user.
   */
  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard',
    softDirective?: string,
  ): Promise<void> {
    const hostId = this.hostIdForAgent(agentId);
    const transport = this.requireTransport();
    const params: RuntimeStopParams =
      mode === 'soft'
        ? {
            conversation_id: conversationId,
            agent_id: agentId,
            mode,
            soft_directive: softDirective ?? DEFAULT_SOFT_DIRECTIVE,
          }
        : {
            conversation_id: conversationId,
            agent_id: agentId,
            mode,
          };
    await transport.sendCommand(hostId, 'runtime_stop', params);
  }

  async startDeliveryBacked(
    conversationId: string,
    agentId: string,
  ): Promise<boolean> {
    if (this.inboxRepo.listPending(conversationId, agentId).length === 0) {
      // D4.b P1-2 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1) idempotency
      // guard. With the auto-drain on `ready` now claiming pending
      // rows the moment the daemon attaches, an explicit
      // `runtimeHost.start` / HTTP POST `/start` racing the
      // microtask will see an empty `listPending` even though a
      // `runtime_start` dispatch is already in flight (the auto-
      // drain transitioned the rows to `in_flight_owner = <conn>`).
      // Without this guard the explicit start would throw
      // `HostRuntimeDisabledError` ("nothing to drain") and the
      // route would return a generic 400 — strictly worse UX than
      // an idempotent success.
      //
      // We treat "any in-flight row for this pair" as proof that
      // the runtime is being started, and return success. The
      // already-in-flight dispatch will land the same wake/spawn;
      // the second caller is a benign no-op.
      if (this.inboxRepo.countInFlightForPair(conversationId, agentId) > 0) {
        return true;
      }
      return false;
    }
    const hostId = this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId, 'runtime_start');
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
    const options = this.runtimeStartOptions(conversationId, agentId);
    const transport = this.requireTransport();
    try {
      const result = await transport.sendCommand(
        hostId,
        'runtime_start',
        {
          conversation_id: conversationId,
          agent_id: agentId,
          options,
          startup_delivery: {
            delivery_ids: batch.deliveryIds,
            text: batch.text,
          },
        } satisfies RuntimeStartParams,
        { timeoutMs: 60_000, expectedConnectionId: connectionId },
      );
      if (result.started && result.startup_delivery_accepted !== true) {
        this.opts.logger.warn(
          {
            kind: 'inbox',
            action: 'startup_delivery_not_accepted_after_start',
            hostId,
            conversationId,
            agent_id: agentId,
            delivery_ids: batch.deliveryIds,
            result: summarizeStartupDeliveryResult(result),
          },
          'outbound startup delivery was not accepted after runtime_start reported started; rows remain pending',
        );
        this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      } else if (!result.started) {
        this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      }
      return true;
    } catch (err) {
      this.inboxRepo.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
  }

  private runtimeStartOptions(
    conversationId: string,
    agentId: string,
  ): RuntimeStartParams['options'] {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const workspace = this.workspaces.get(conversation.workspace_id);
    if (!workspace) {
      throw new Error(`workspace ${conversation.workspace_id} not found`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const sessionAgent = this.conversations.getAgent(conversationId, agentId);
    if (!sessionAgent) {
      throw new Error(
        `conversation_agent row missing for ${conversationId}/${agentId}`,
      );
    }
    const parentConversation = conversation.parent_conversation_id
      ? this.conversations.get(conversation.parent_conversation_id)
      : null;

    return buildRuntimeStartOptions({
      conversation,
      parentConversation,
      workspace,
      agent,
      sessionAgent,
      members: this.membership.listMembers(conversation.id),
      workspacesForAgent: this.workspaces.listForAgent(agent.id),
      silverhandDir: this.opts.silverhandDir,
      silverhandCli: this.opts.silverhandCli,
      serverUrl: this.opts.serverUrl(),
      agentToken: this.opts.agentTokens.issue(conversationId, agentId),
      proxy: this.opts.proxyPolicy(),
    });
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
      // D4.b P1-2 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1) — auto-drain
      // on reattach. Fires AFTER the daemon's `runtime_status`
      // snapshot has hydrated the cache, so the per-pair phase
      // check (`ready` → wake / absent → spawn) in
      // `startDeliveryBacked` is authoritative. We dispatch via
      // `queueMicrotask` so the hydrate code path returns first
      // (the dispatch awaits the WS round-trip and we don't want
      // to nest that inside the hydrate callback).
      onHydrateComplete: () => {
        const connectionId = state.currentConnectionId;
        if (!connectionId) {
          // Hydrate-without-connection shouldn't happen in
          // practice (hydrate runs from inside an event path that
          // just set currentConnectionId), but bail safely if it
          // does.
          return;
        }
        queueMicrotask(() => {
          this.replayPendingForHost(hostId, connectionId).catch(err => {
            this.opts.logger.warn(
              { hostId, connectionId, err },
              'outbound replay-on-reattach failed (host-level catch)',
            );
          });
        });
      },
      activityLog: this.activityLog ?? undefined,
      logger: this.opts.logger,
    });
    state.coordinator = coordinator;
    state.handler = handler;
    this.states.set(hostId, state);
    return state;
  }

  /**
   * D4.b P1-2 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1): drive automatic
   * drain of pending inbox rows for every (conversation, agent) pair
   * owned by `hostId` after a daemon reattach. Called from
   * `onEvent('ready', ...)` via `queueMicrotask` so the WS read loop
   * stays unblocked.
   *
   * Implementation notes:
   *
   *   - `expectedConnectionId` guard: if `currentConnectionId` flipped
   *     to a newer one between the `queueMicrotask` schedule and
   *     execution (i.e. the daemon bounced again before we even got
   *     around to the drain), abort. The newer ready frame will
   *     schedule its own replay.
   *   - Per-pair try/catch: a single bad pair (e.g. agent's
   *     host_credentials race-deleted, options builder throw) must
   *     not poison the rest of the host's drain. The caller's
   *     host-level catch is the outer net for unanticipated failures.
   *   - `startDeliveryBacked` is the right entry point even for an
   *     already-running runtime: it short-circuits to
   *     `replayPendingForAgent` (live-wake path) when the cache
   *     reports phase === 'ready', and proceeds with `runtime_start`
   *     + `startup_delivery` otherwise. On fresh daemon reattach the
   *     cache is empty (disconnect cleared it), so every pair takes
   *     the spawn path.
   */
  private async replayPendingForHost(
    hostId: string,
    expectedConnectionId: string,
  ): Promise<void> {
    const pairs = this.inboxRepo.listPendingPairsForHost(hostId);
    if (pairs.length === 0) return;
    for (const { conversationId, agentId } of pairs) {
      const state = this.states.get(hostId);
      if (!state || state.currentConnectionId !== expectedConnectionId) {
        // Connection bounced between scheduling and execution. Bail
        // out — the newer connection's ready frame will replay.
        this.opts.logger.info(
          { hostId, expectedConnectionId, currentConnectionId: state?.currentConnectionId ?? null },
          'outbound replay-on-reattach: connection changed mid-drain, aborting',
        );
        return;
      }
      try {
        await this.startDeliveryBacked(conversationId, agentId);
      } catch (err) {
        this.opts.logger.warn(
          { hostId, conversationId, agentId, err },
          'outbound replay-on-reattach pair failed',
        );
      }
    }
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
        sendMessageToolName(),
      ),
      agentRuntime: agent.runtime,
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

  /**
   * Resolve the current outbound WS connectionId for the host, or
   * throw a TYPED `HostWsCommandTransportError('transport_no_connection')`
   * so route handlers' `placementErrorResponse` /
   * `mapTransportErrorToPlacement` (`routes.ts:214`) can promote it
   * to `host_attach_pending` (503). Without the typed shape the
   * lifted A-class runtime routes would surface a generic 500/400
   * for "daemon not attached yet" — which is the exact regression
   * Cindy P1-1 (`wY_2I5y4l-FXO19h`) calls out.
   *
   * `commandKind` is required so the typed error carries enough
   * context for log → response correlation; pass the kind that
   * WOULD have been dispatched if the connection existed.
   */
  private connectedConnectionId(
    hostId: string,
    commandKind: OutboundServerCommandKind,
  ): string {
    const transport = this.requireTransport();
    const connectionId = transport.connectionIdForHost(hostId);
    if (!connectionId) {
      throw new HostWsCommandTransportError(
        'transport_no_connection',
        `outbound host ${hostId} is not connected`,
        { hostId, commandKind },
      );
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

function summarizeStartupDeliveryResult(result: {
  started: boolean;
  startup_delivery_accepted?: boolean;
  pid?: number | null;
  started_at?: number;
  error?: unknown;
}): Record<string, unknown> {
  return {
    started: result.started,
    startup_delivery_accepted: result.startup_delivery_accepted,
    pid: result.pid,
    started_at: result.started_at,
    error:
      result.error && typeof result.error === 'object' && !Array.isArray(result.error)
        ? Object.keys(result.error as Record<string, unknown>).slice(0, 10)
        : result.error,
  };
}
