import {
  EventFrameSchema,
  isHostActiveRuntimePhase,
  layoutMigrationOutcomeFromCapabilities,
  type EventFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type RuntimeStartParams,
  type RuntimeStatusResult,
  type RuntimeStopParams,
} from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type {
  AgentDto,
  AgentRunState,
  AgentRunTerminalReason,
  RuntimeKind,
} from '@silverhand/shared';
import { isBaselineReasoningEffort } from '@silverhand/shared';
import {
  HOST_AGENT_LIVENESS_CHANGED_EVENT,
  type HostAgentLivenessChangedEvent,
} from '@silverhand/shared';
import type { AgentTokenStore } from '../auth/agent-token-store.js';
import {
  conversationRuntimePrincipal,
  type RuntimePrincipal,
} from '../auth/runtime-principal.js';
import type { BackendLogger, SilverhandCliLauncher } from '../context.js';
import { systemSubtype } from '@silverhand/shared';
import type {
  RuntimeClaimedInboxDelivery,
  DbLiveRuntime,
  RuntimeFanoutPersistence,
  RuntimeMemberRosterPort,
  RuntimeSessionTxScope,
} from './persistence-ports.js';
import {
  HostWsCommandTransportError,
  type HostWsEventSink,
} from '../ws/host-ws-server.js';
import {
  OutboundFrameTransportError,
  type OutboundFrameAdapter,
} from './outbound-frame-adapter.js';
import { JsonlActivityLogWriter, type ActivityLogWriter } from './activity-log-writer.js';
import { makeDaemonInstanceKey } from './daemon-instance-key.js';
import {
  CLEAR_SESSION_EXIT_TIMEOUT_MS,
  ClearSessionInProgressError,
  type ClearSessionResult,
  type ReapIdleRuntimesOptions,
  type ReapIdleRuntimesResult,
  type StopOptions,
} from './agent-runtime-host.js';
import { RuntimeDeliveryCoordinator, type RuntimeDelivery } from './delivery-coordinator.js';
import {
  RuntimeEventHandler,
  type ConversationActivitySink,
  type EventPublisher,
  type InboxAckSink,
  type RuntimeEventSource,
  type RuntimeStatusBridge,
} from './event-handler.js';
import type { RuntimeStatusProjector } from './status-projector.js';
import { RunStateCache, type CachedRuntimeEntry } from './run-state-cache.js';
import type { HostRuntimeActivityView } from './host-status-read-model.js';
import {
  formatInboxBatchPresentation,
  sendMessageToolName,
} from './stdin-format.js';
import { createReferenceMemo } from './reference-memo.js';
import {
  buildRuntimeStartOptions,
} from './runtime-start-options.js';
import { type AgentL2SeedEnsurer } from './agent-l2-seed-ensurer.js';
import { planRuntimeStartFilesystemEnsure } from './runtime-filesystem-plan.js';
import type { RuntimeEventPerimeterPort } from './event-perimeter.js';
import { ClearSessionWaiterRegistry } from './clear-session-registry.js';

export interface OutboundRuntimeEventFanoutOptions {
  /**
   * Everything durable this fanout touches, as driver-free facets (#task:1982
   * W3). The fanout holds no `Database`: process-state authority (cache,
   * coordinator, waiter registry, perimeter) stays here, storage decisions do
   * not.
   */
  persistence: RuntimeFanoutPersistence;
  /** Conversation roster for a spawn's platform prompt. */
  members: RuntimeMemberRosterPort;
  /** D4.c C5 — validates inbound event ownership before dispatch. A PORT, not
   *  the guard class: the verdict is all the fanout may know, and a class type
   *  would be nominal (private fields) and so unimplementable by any other
   *  deployment. Built in composition because its checks are DB-backed. */
  perimeter: RuntimeEventPerimeterPort;
  /** Owns the whole runtime-event → runtime-slot observation mapping plus
   *  the matching `agent_status` publish. Stateless, so one instance serves
   *  every host. */
  statusProjector: RuntimeStatusProjector;
  /**
   * Persists `conversation_events` and publishes `conversation_activity`.
   * REQUIRED even though `RuntimeEventHandler` takes it optionally: unwired,
   * activity persistence stops silently with no type error, so composition is
   * not allowed to omit it.
   */
  conversationActivity: ConversationActivitySink;
  events: EventPublisher;
  transport: () => OutboundFrameAdapter | null;
  logger: BackendLogger;
  silverhandCli: SilverhandCliLauncher | null;
  coLocatedHostId?: string;
  agentTokens: AgentTokenStore;
  /**
   * #task:1588 slice 2 — viewer-scope publisher for the
   * `host_agent_liveness_changed` invalidation event. Injected as a
   * narrow port (composition root wires it to
   * `ctx.events.publishToScope('viewer:...')`) so the fanout stays off
   * the full ScopeEventBus surface. Optional: unwired in harnesses
   * that don't exercise the renderer event path.
   */
  publishHostScopeEvent?: (
    ownerUserId: string,
    kind: string,
    payload: unknown,
  ) => void;
  /**
   * #task:1588 slice 2 — fired on every daemon `ready` event (fresh
   * connection generation). The composition root wires this to the
   * host-status read model's eager seed so the FIRST `/status` read of
   * a generation is already a memory read.
   */
  onHostReady?: (hostId: string, connectionId: string) => void;
  /**
   * Cross-computer slice 1 (#task:1596) — pre-spawn L2 seed on the dispatch
   * host. The active workspace's L2 for the spawning agent must exist under
   * THAT computer's local root before the runtime starts; membership-time
   * seeding only covers the workspace's home computer. Optional in the type
   * for protocol-only assemblies, but LOAD-BEARING for spawning: a
   * regular-workspace runtime_start/deliver fails closed when unwired.
   */
  agentL2SeedEnsurer?: AgentL2SeedEnsurer;
  logDir?: string;
  activityLog?: ActivityLogWriter | null;
  /**
   * D4.c C7 — override the bounded wait `clearSession` blocks on
   * the post-`runtime_clear_session` `runtime_exit` event landing
   * in projection. Tests inject a small value (a few ms) to
   * exercise the timeout branch without `setTimeout(10000)`.
   * Defaults to {@link CLEAR_SESSION_EXIT_TIMEOUT_MS} (10s).
   */
  clearSessionExitTimeoutMs?: number;
}

const HYDRATE_RECONCILE_BASELINE = Symbol('hydrate-reconcile-baseline');
type RequestBoundRuntimeStatus = RuntimeStatusResult & {
  readonly [HYDRATE_RECONCILE_BASELINE]: readonly DbLiveRuntime[];
};

interface HostFanoutState {
  cache: RunStateCache;
  coordinator: RuntimeDeliveryCoordinator;
  handler: RuntimeEventHandler;
  currentConnectionId: string | null;
  currentDaemonKey: string | null;
  dispatchConnectionId: string | null;
  /**
   * #task:1588 — daemon key whose `runtime_status` hydrate has
   * completed (atomic whole-set replace into `cache`). Compared
   * against `currentDaemonKey` by {@link OutboundRuntimeEventFanout.hostRuntimeView}:
   * only a match makes the cache authoritative for host-level agent
   * liveness. Never reset explicitly — a daemon swap changes
   * `currentDaemonKey`, and the stale value simply stops matching.
   */
  hydratedDaemonKey: string | null;
  /** Connection whose status snapshot completed. A reconnect to the same
   * daemon instance still has to hydrate before any new start/deliver: bearer
   * continuity and the snapshot are properties of the backend connection, not
   * merely of the daemon process key. */
  hydratedConnectionId: string | null;
  hydrateInProgress: boolean;
  hydrateWaiters: Map<string, Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>>;
  /**
   * #task:1613 — daemon boot key (`makeDaemonInstanceKey`) whose
   * layout-migration outcome has already been logged. IN-PROCESS
   * BEST-EFFORT dedupe only: it survives socket reconnects of the same
   * boot (deliberately NOT reset in
   * {@link OutboundRuntimeEventFanout.onDisconnect}) but not a backend
   * restart, so duplicate lines are possible; the deletion gate dedupes
   * by (hostId, daemonInstance, outcome) when counting.
   */
  layoutMigrationLoggedDaemonKey: string | null;
  /**
   * #task:1588 slice 2 — signature of the last PUBLISHED active-agent
   * set (sorted, joined). `maybePublishLivenessChanged` compares the
   * current fold against it and publishes the invalidation event only
   * on a real change — never a per-event broadcast.
   */
  lastLivenessSignature: string;
}

interface PendingDeliveryBatch {
  deliveryIds: number[];
  deliveredUpToSeq: number;
  deliveries: RuntimeDelivery[];
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
  private readonly staleEventConnectionsWarned = new Set<string>();
  // Named persistence facets, destructured once so the call sites below read as
  // domain acts rather than as `opts.persistence.…` chains.
  private readonly inbox: RuntimeFanoutPersistence['inbox'];
  private readonly conversations: RuntimeFanoutPersistence['conversations'];
  private readonly agents: RuntimeFanoutPersistence['agents'];
  private readonly hosts: RuntimeFanoutPersistence['hosts'];
  private readonly users: RuntimeFanoutPersistence['users'];
  private readonly workspaces: RuntimeFanoutPersistence['workspaces'];
  private readonly runtimeCustody: RuntimeFanoutPersistence['runtimeCustody'];
  private readonly hydrateReconcile: RuntimeFanoutPersistence['hydrateReconcile'];
  private readonly session: RuntimeFanoutPersistence['session'];
  private readonly members: RuntimeMemberRosterPort;
  private readonly inboxAck: InboxAckSink;
  private readonly activityLog: ActivityLogWriter | null;
  private readonly ownsActivityLog: boolean;
  /** D4.c C5 — validates inbound event ownership before dispatch. */
  private readonly perimeter: RuntimeEventPerimeterPort;
  /** D4.c C7 — bounded-wait registry for `clearSession`. */
  private readonly clearSessions: ClearSessionWaiterRegistry;
  /**
   * #task:2000 (option B) — the addressing set of a message, derived once and
   * reused across every recipient its batch is framed for. Instance-scoped
   * because all three delivery paths (live, replay, ready-for-drain) reach
   * `pendingBatch` on this one object; sound because `messages.content` never
   * changes. See `reference-memo.ts` for the bound and that invariant.
   */
  private readonly references = createReferenceMemo();

  constructor(private readonly opts: OutboundRuntimeEventFanoutOptions) {
    this.inbox = opts.persistence.inbox;
    this.conversations = opts.persistence.conversations;
    this.agents = opts.persistence.agents;
    this.hosts = opts.persistence.hosts;
    this.users = opts.persistence.users;
    this.workspaces = opts.persistence.workspaces;
    this.runtimeCustody = opts.persistence.runtimeCustody;
    this.hydrateReconcile = opts.persistence.hydrateReconcile;
    this.session = opts.persistence.session;
    this.members = opts.members;
    this.clearSessions = new ClearSessionWaiterRegistry(
      opts.clearSessionExitTimeoutMs ?? CLEAR_SESSION_EXIT_TIMEOUT_MS,
    );
    this.perimeter = opts.perimeter;
    this.inboxAck = {
      markDelivered: ids => this.inbox.markDelivered([...ids]),
      markUndelivered: (ids, reason) => {
        this.inbox.rollbackInFlightAnyOwner(ids);
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
    // Replacement-safe event ingress. A daemon/socket can still have
    // buffered frames in flight after the backend has accepted a newer
    // outbound connection for the same host. Those stale frames must
    // not write `currentConnectionId` back to the old value: otherwise
    // a late `runtime_ready_for_drain` can immediately issue a
    // `runtime_deliver` pinned to a dead connection and leave rows
    // pending behind `transport_disconnected`. The command side already
    // has an `expectedConnectionId` guard; mirror that boundary on the
    // event side before any state mutation.
    const liveConnectionId =
      this.opts.transport()?.connectionIdForHost(hostId) ?? null;
    if (liveConnectionId !== connectionId) {
      this.onDisconnect(hostId, connectionId);
      const warnKey = JSON.stringify([hostId, connectionId]);
      if (!this.staleEventConnectionsWarned.has(warnKey)) {
        this.staleEventConnectionsWarned.add(warnKey);
        this.opts.logger.warn(
          {
            connectionHostId: hostId,
            eventKind: event.kind,
            eventConnectionId: connectionId,
            liveConnectionId,
            action: 'outbound_event_stale_connection',
          },
          'outbound event arrived from a stale connection — dropped',
        );
      }
      return;
    }

    // D4.c C5 — runtime perimeter check. The connection is
    // already authenticated to `hostId` at the WS layer (host
    // token verify). What we DON'T trust is the per-event
    // `agent_id` daemon X claims to act on: a bug or malicious
    // daemon can attach as host X and emit events that reference
    // an agent owned by host Y, which would otherwise:
    //
    //   - allocate / mutate `this.states` for hostId via
    //     `stateForHost` (lazy `Map.set` even if no fields are
    //     written, polluting the host index)
    //   - write `currentConnectionId` / `currentDaemonKey`
    //   - mutate `cache.applyPhase` for the wrong host
    //   - dispatch the event into `state.handler` and onward
    //     into projection / DB / bus
    //
    // We reject mismatches BEFORE `stateForHost` to keep the
    // promise that a rejected event leaves zero per-host state
    // residue. We deliberately do NOT close the WS — a single
    // mismatch frame may be a transient bug (race, refactor
    // glitch); kicking the socket would also break the host's
    // legitimate runtimes. Anti-abuse rate-counting is out of
    // scope (D5 / T2).
    if (!this.perimeter.assert(hostId, event)) {
      return;
    }
    const state = this.stateForHost(hostId);
    state.currentConnectionId = connectionId;
    if (event.kind === 'ready') {
      state.hydratedConnectionId = null;
      state.hydrateInProgress = true;
      state.currentDaemonKey = makeDaemonInstanceKey(
        event.daemon_pid,
        event.started_at,
      );
      // #task:1613 — observation log for the layout-v2 migration-unit
      // deletion gate. The daemon advertises its migration outcome as a
      // `layout_migration.v2.*` capability token; log it once per daemon
      // boot within this backend process (in-process best-effort dedupe
      // keyed by the boot's instance key — it survives socket reconnects
      // but NOT a backend restart or an A→B→A host-state eviction, so
      // duplicates are possible; consumers of the deletion gate dedupe by
      // (hostId, daemonInstance, outcome)). No token = pre-#1613 daemon
      // build = unobserved: deliberately not logged, so the gate stays
      // closed for that computer instead of silently passing.
      // Contradictory tokens (both outcomes at once) are malformed
      // evidence: warn, never a success status. The log is evidence
      // only — never a persistent migration authority (the marker file is).
      const layoutOutcome = layoutMigrationOutcomeFromCapabilities(
        event.capabilities,
      );
      if (
        layoutOutcome !== null &&
        state.layoutMigrationLoggedDaemonKey !== state.currentDaemonKey
      ) {
        state.layoutMigrationLoggedDaemonKey = state.currentDaemonKey;
        if (layoutOutcome === 'contradictory') {
          this.opts.logger.warn(
            {
              action: 'layout_migration_status_contradictory',
              hostId,
              layoutVersion: 2,
              daemonVersion: event.daemon_version,
              daemonInstance: state.currentDaemonKey,
            },
            'attaching daemon advertised BOTH layout migration outcomes — malformed evidence, not counted',
          );
        } else {
          this.opts.logger.info(
            {
              action: 'layout_migration_status',
              hostId,
              outcome: layoutOutcome,
              layoutVersion: 2,
              daemonVersion: event.daemon_version,
              daemonInstance: state.currentDaemonKey,
            },
            'layout-v2 migration status reported by attaching daemon',
          );
        }
      }
      // Reattach re-drive is wired through the handler's
      // `onHydrateComplete` callback (see `stateForHost` below), NOT
      // here on `ready`. The handler's `onDaemonReady(ready)` path
      // triggers a fire-and-forget `hydrateSafely('daemon_ready', ...)`
      // that fetches the daemon's `runtime_status` snapshot and
      // populates the cache; only after that does `replayPendingForHost`
      // re-drive the runtimes the snapshot reports as ALREADY ALIVE
      // (`phase === 'ready'`), live-delivery-only. It never derives a spawn from
      // the DB pending set — that was the boot-herd bug. Firing on
      // `ready` itself would race the hydrate and act on a stale cache.
    }
    state.dispatchConnectionId = connectionId;
    try {
      state.handler.dispatch(outboundEventToEventFrame(event));
    } finally {
      state.dispatchConnectionId = null;
    }
    if (event.kind === 'ready') {
      // Fresh connection generation: let the composition root eager-
      // seed the host-status read model (fire-and-forget there).
      try {
        this.opts.onHostReady?.(hostId, connectionId);
      } catch (err) {
        this.opts.logger.warn(
          { kind: 'event', hostId, err: (err as Error).message },
          'onHostReady callback threw',
        );
      }
    }
    this.maybePublishLivenessChanged(hostId, state);
  }

  onDisconnect(hostId: string, connectionId: string): void {
    this.inbox.rollbackInFlightForOwner(connectionId);
    const state = this.states.get(hostId);
    if (!state) return;
    if (state.currentConnectionId === connectionId || state.currentConnectionId === null) {
      this.rejectHydrateWaiters(
        state,
        connectionId,
        new Error(`host ${hostId} disconnected before runtime_status hydrate completed`),
      );
      state.currentConnectionId = null;
      state.currentDaemonKey = null;
      state.hydratedConnectionId = null;
      state.hydrateInProgress = false;
      state.dispatchConnectionId = null;
      for (const entry of state.cache.list()) {
        state.coordinator.clearRuntime(
          entry.conversationId,
          entry.agentId,
          'stopped',
        );
      }
      state.cache.clearAll();
      this.maybePublishLivenessChanged(hostId, state);
    }
  }

  /**
   * #task:1588 — per-host liveness view for the host-status read model
   * (`GET /api/hosts/:id/status` zero-RPC read path).
   *
   * `activeAgentIds` mirrors the daemon's own `host_status`
   * derivation: agents with at least one runtime in an ACTIVE phase,
   * scoped to the current daemon generation. `hydratedForCurrentDaemon`
   * is the trust gate — false until the current daemon's
   * `runtime_status` hydrate (atomic whole-set replace) has landed, so
   * the read model falls back to its generation-bound seed instead of
   * reading a not-yet-populated cache as "everything offline".
   */
  hostRuntimeView(hostId: string): HostRuntimeActivityView | null {
    const state = this.states.get(hostId);
    if (!state) return null;
    return {
      connectionId: state.currentConnectionId,
      hydratedForCurrentDaemon:
        state.currentDaemonKey !== null &&
        state.hydratedDaemonKey === state.currentDaemonKey &&
        state.hydratedConnectionId === state.currentConnectionId,
      activeAgentIds: activeAgentIdsFromCacheEntries(
        state.cache.list(),
        state.currentDaemonKey,
      ),
    };
  }

  /**
   * #task:1588 slice 2 — publish `host_agent_liveness_changed` to the
   * host owner's viewer scope when the active-agent set actually
   * changed. Pure invalidation: the payload is `{host_id}` — renderers
   * refetch `/status` (a memory read) for the state. Runs after every
   * dispatched event / hydrate / disconnect; the sorted-signature diff
   * keeps the emit rate at "real transitions only" (an agent's first
   * runtime up, or its last one gone) — never per runtime_state frame.
   *
   * `force` (hydrate path only): the signature diff compares cache
   * against cache, but at hydrate completion the READ MODEL's authority
   * switches from the seed's `active_agent_ids` to the cache. A seed
   * set the hydrate contradicts (seed `{A}` → hydrate `{}`) produces NO
   * cache-signature change, yet clients that cached the seed-based
   * response would stay stale forever with polling gone. One forced
   * publish per hydrate makes the authority switch always observable
   * (Cindy slice-2 review P1-2).
   */
  private maybePublishLivenessChanged(
    hostId: string,
    state: HostFanoutState,
    opts?: { force?: boolean },
  ): void {
    const signature = activeAgentIdsFromCacheEntries(
      state.cache.list(),
      state.currentDaemonKey,
    )
      .sort()
      .join(',');
    if (!opts?.force && signature === state.lastLivenessSignature) return;
    state.lastLivenessSignature = signature;
    const publish = this.opts.publishHostScopeEvent;
    if (!publish) return;
    const ownerUserId = this.hosts.routingView(hostId)?.ownerUserId ?? null;
    if (ownerUserId === null) return;
    try {
      publish(ownerUserId, HOST_AGENT_LIVENESS_CHANGED_EVENT, {
        host_id: hostId,
      } satisfies HostAgentLivenessChangedEvent);
    } catch (err) {
      this.opts.logger.warn(
        { kind: 'event', hostId, err: (err as Error).message },
        'host_agent_liveness_changed publish threw',
      );
    }
  }

  private reconcileMissingRuntimesAfterHydrate(
    hostId: string,
    state: HostFanoutState,
    snapshot: RuntimeStatusResult,
  ): void {
    // A daemon swap cannot adopt the prior daemon's child processes; its
    // runtime_status snapshot is authoritative. If DB still says a runtime
    // on this host is active/starting but the snapshot omits it, project a
    // terminal state so the UI does not keep showing a stale live agent.
    const livePairs = new Set(
      state.cache
        .list()
        .filter(entry => entry.phase !== 'exited')
        .map(entry => clearSessionKey(entry.conversationId, entry.agentId)),
    );

    const staleRows = (
      snapshot as Partial<RequestBoundRuntimeStatus>
    )[HYDRATE_RECONCILE_BASELINE] ?? [];

    for (const row of staleRows) {
      if (livePairs.has(clearSessionKey(row.conversationId, row.agentId))) {
        continue;
      }
      const updated = this.hydrateReconcile.markCrashed(row);
      if (!updated) continue;
      if (row.daemonInstanceId) {
        this.opts.agentTokens.revokeFor(conversationRuntimePrincipal({
          conversationId: row.conversationId,
          agentId: row.agentId,
          generation: row.generation,
          daemonInstanceId: row.daemonInstanceId,
        }));
      }
      this.opts.events.publishSide(row.conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: row.agentId,
          status: 'crashed',
          pid: null,
          reason: 'daemon_hydrate_missing',
        },
      });
      this.opts.logger.warn(
        {
          kind: 'runtime',
          action: 'stale_runtime_reconciled_after_hydrate',
          hostId,
          conversationId: row.conversationId,
          agent_id: row.agentId,
          previous_status: row.status,
          previous_pid: row.pid,
        },
        'runtime_status hydrate omitted a DB-active runtime; marked it crashed',
      );
    }
  }

  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    const delivery = this.inbox.ensureDelivery(
      conversationId,
      agentId,
      messageId,
    );
    if (delivery.deliveredAt !== null) return;
    // Runtime transition owns spawn/delivery custody. Keep the durable inbox
    // row pending; the transition use case re-drives it after atomic commit.
    if (this.runtimeTransitioning(agentId)) return;
    const hostId = this.hostIdForAgent(agentId);
    // #task:1417 Stage 2b — no cache-phase fork. Claim pending + submit a
    // live `runtime_deliver`; the daemon decides spawn-vs-admit-vs-refuse.
    // The desyncable cache projection no longer gates delivery (root #1416
    // fix). The connection is resolved under the `runtime_deliver` label.
    const connectionId = this.connectedConnectionId(hostId, 'runtime_deliver');
    await this.awaitHydratedConnection(hostId, connectionId);
    await this.deliverLivePendingForAgent(
      hostId,
      connectionId,
      conversationId,
      agentId,
    );
  }

  /**
   * D4.b-4: dispatch `runtime_stop` over the outbound WS. The
   * standalone backend owns the projection of the resulting
   * `runtime_exit` event (`RuntimeStatusProjector.runtimeExit`).
   *
   * `opts.hostId` is the CAPTURED routing authority: `hostIdForAgent` re-reads
   * `agents` + `hosts`, so a caller stopping runs whose rows it has already
   * deleted (the delete-computer cascade, by design, stops after its commit)
   * must name the host itself or the dispatch would throw and be degraded to a
   * warning — a silent no-op leaving the daemon's child alive (#task:1616).
   */
  async stop(
    conversationId: string,
    agentId: string,
    opts?: StopOptions,
  ): Promise<void> {
    const hostId = opts?.hostId ?? this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId, 'runtime_stop');
    const current = this.runtimeCustody.currentConversation(conversationId, agentId);
    const runtimeGeneration = opts?.runtimeGeneration
      ?? current?.custody.generation
      ?? this.states.get(hostId)?.cache.get(
        conversationId,
        agentId,
      )?.runtimeGeneration;
    if (!runtimeGeneration) return;
    await this.dispatchStop(
      hostId,
      connectionId,
      conversationId,
      agentId,
      runtimeGeneration,
    );
  }

  private async dispatchStop(
    hostId: string,
    expectedConnectionId: string,
    conversationId: string,
    agentId: string,
    runtimeGeneration: number,
  ): Promise<void> {
    const params: RuntimeStopParams = {
      conversation_id: conversationId,
      agent_id: agentId,
      runtime_generation: runtimeGeneration,
      mode: 'hard',
    };
    await this.requireTransport().sendCommand(hostId, 'runtime_stop', params, {
      expectedConnectionId,
    });
  }

  async reapIdleRuntimes(
    opts: ReapIdleRuntimesOptions,
  ): Promise<ReapIdleRuntimesResult> {
    const result: ReapIdleRuntimesResult = {
      considered: 0,
      eligible: 0,
      reaped: 0,
      skipped: 0,
      failed: 0,
    };
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) return result;

    const transport = this.opts.transport();
    if (!transport) return result;

    const now = opts.now ?? Date.now();
    const runtimeEnabled = opts.runtimeEnabled ?? idleReapRuntimeEnabled;

    for (const [hostId, state] of this.states.entries()) {
      const selectedConnectionId = state.currentConnectionId;
      if (!selectedConnectionId) continue;
      if (transport.connectionIdForHost(hostId) !== selectedConnectionId) {
        result.skipped += state.cache.list().length;
        continue;
      }

      for (const entry of state.cache.list()) {
        result.considered++;

        if (!this.isIdleReapCandidate(entry, now, opts.ttlMs, runtimeEnabled)) {
          result.skipped++;
          continue;
        }

        if (this.inbox.hasUndeliveredForPair(entry.conversationId, entry.agentId)) {
          result.skipped++;
          continue;
        }

        const freshEntry = state.cache.get(entry.conversationId, entry.agentId);
        if (
          !freshEntry ||
          !this.isIdleReapCandidate(
            freshEntry,
            now,
            opts.ttlMs,
            runtimeEnabled,
          ) ||
          state.currentConnectionId !== selectedConnectionId ||
          transport.connectionIdForHost(hostId) !== selectedConnectionId ||
          this.inbox.hasUndeliveredForPair(entry.conversationId, entry.agentId)
        ) {
          result.skipped++;
          continue;
        }

        result.eligible++;
        try {
          await this.dispatchStop(
            hostId,
            selectedConnectionId,
            entry.conversationId,
            entry.agentId,
            entry.runtimeGeneration,
          );
          result.reaped++;
        } catch (err) {
          result.failed++;
          this.opts.logger.warn(
            {
              kind: 'runtime',
              action: 'idle_reap_stop_failed',
              hostId,
              conversationId: entry.conversationId,
              agent_id: entry.agentId,
              err,
            },
            'idle reaper failed to stop runtime; continuing',
          );
        }
      }
    }

    return result;
  }

  private isIdleReapCandidate(
    entry: CachedRuntimeEntry,
    now: number,
    ttlMs: number,
    runtimeEnabled: (runtime: RuntimeKind) => boolean,
  ): boolean {
    if (entry.phase !== 'ready') return false;
    const runState = entry.runState;
    if (!runState || runState.status !== 'idle') return false;
    if (!Number.isFinite(runState.lastActivityAt)) return false;
    if (now - runState.lastActivityAt <= ttlMs) return false;
    const agent = this.agents.get(entry.agentId);
    return !!agent && runtimeEnabled(agent.runtime);
  }

  /**
   * D4.c C7 — clearSession over the outbound daemon transport.
   *
   * Uses a bounded wait for the
   * `runtime_exit` event to land in projection BEFORE we touch the
   * DB, so the audit row + `cli_session_id=null` write sees a
   * coherent post-exit state and the renderer's `agent_status` SSE
   * follows the death event in the right order.
   *
   * Sequence (Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6` final):
   *
   *   1. Validate the (conv, agent) triplet against the DB.
   *   2. Concurrent same-(cid,aid) → fail-fast
   *      {@link ClearSessionInProgressError}; clear-session is a
   *      user-explicit one-shot, share-waiter would be over-engineered.
   *   3. Snapshot pre-state (`prevCliSessionId`, `wasRunning` from
   *      the cache) — captured BEFORE dispatch so the post-state
   *      observed under `runtime_exit` doesn't pollute the audit
   *      content.
   *   4. Register the one-shot `runtime_exit` waiter BEFORE
   *      `transport.sendCommand`. The daemon emits `runtime_exit`
   *      from `onChildExit` synchronously after the SIGKILL grace
   *      window, which can race the command response on the WS;
   *      registering first guarantees no missed notification.
   *   5. Dispatch `runtime_clear_session` with
   *      `expectedConnectionId` so a daemon-bounce mid-flight surfaces
   *      as `transport_disconnected` (→ 503 `host_attach_pending`)
   *      with DB untouched.
   *   6. Bounded wait for `runtime_exit` projection landed. The
   *      daemon's `cleared` flag is the AUTHORITATIVE signal of
   *      "did the daemon trigger a kill?":
   *      - `cleared === true` → bounded wait MUST happen. Even if
   *        the cache currently shows empty / `phase === 'exited'`,
   *        the cache can be stale across a backend restart, a
   *        pre-hydrate window, or a recent reattach (Cindy
   *        `Z3drVLxYkw5GUvGd` P1). If the waiter is already
   *        latched (the matching `runtime_exit` raced the command
   *        response, which it can on the same WS), the wait
   *        resolves immediately. Otherwise it races
   *        `clearSessionExitTimeoutMs`; on timeout throw
   *        {@link ClearSessionExitTimeoutError} — DB UNCHANGED, no
   *        audit, no `cli_session_id` clear.
   *      - `cleared === false` → daemon authoritatively reports it
   *        had no handle; skip wait. Covers `cleared:false` /
   *        already-exited / orphan-row clears.
   *   7. `coordinator.clearRuntime` mirrors the embedded path's
   *      delivery-state cleanup (cancel delivery watchdog, drop
   *      pending/busy markers).
   *   8. DB transaction (Cindy `szDHSdeKwtEUlxZb` P3): the
   *      runtime-slot `cli_session_id=null` write AND the
   *      audit-message insert MUST land in the same SQLite tx so a
   *      crash between them can't leave a row with a dangling audit
   *      pointer (or vice versa).
   *   9. Outside the tx (best-effort, mirrors embedded):
   *      - Publish `agent_status` SSE.
   *      - Publish `message` SSE for the audit row.
   *      - Per-peer `deliverMessage` so each OTHER agent in the
   *        conversation sees the cleared-session signal (their own
   *        chat history / inbox-if-offline). Per-delivery failures
   *        are warn-level only — clearSession-as-a-whole stays
   *        successful.
   *
   *  10. `finally` (Cindy `nPqEVJjCLjuNDH-6` constraint #2): delete
   *      the waiter from the resolver table regardless of which
   *      branch we exited through (success / timeout / dispatch
   *      throw / DB tx throw).
   */
  async clearSession(
    conversationId: string,
    agentId: string,
    actorUserId: string | null = null,
  ): Promise<ClearSessionResult> {
    // 1. Validate.
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const existing = this.conversations.getAgent(conversationId, agentId);
    if (!existing) {
      throw new Error(
        `agent ${agentId} is not a member of conversation ${conversationId}`,
      );
    }

    // 2. Concurrent guard.
    if (this.clearSessions.inProgress(conversationId, agentId)) {
      throw new ClearSessionInProgressError(conversationId, agentId);
    }

    const hostId = this.hostIdForAgent(agentId);
    const state = this.stateForHost(hostId);

    // 3. Snapshot pre-state.
    const prevCliSessionId = existing.cli_session_id;
    const cacheEntryBefore = state.cache.get(conversationId, agentId);
    const wasRunning =
      cacheEntryBefore !== undefined && cacheEntryBefore.phase !== 'exited';
    const currentCustody = this.runtimeCustody.currentConversation(
      conversationId,
      agentId,
    );

    // 4. Register waiter BEFORE dispatch.
    this.clearSessions.begin(conversationId, agentId);

    try {
      // 5. Dispatch over WS. Connection must exist; outbound
      //    transport throws typed `transport_no_connection` /
      //    `transport_disconnected` which the route maps to 503
      //    `host_attach_pending`. DB is still untouched on throw.
      const result = currentCustody
        ? await this.requireTransport().sendCommand(
            hostId,
            'runtime_clear_session',
            {
              conversation_id: conversationId,
              agent_id: agentId,
              runtime_generation: currentCustody.custody.generation,
            },
            {
              timeoutMs: 10_000,
              expectedConnectionId: this.connectedConnectionId(
                hostId,
                'runtime_clear_session',
              ),
            },
          )
        : { cleared: false };

      // 6. Bounded wait for runtime_exit projection landed.
      //    The daemon's `cleared` flag is the AUTHORITATIVE signal
      //    of "did the daemon trigger a kill?". Backend cache alone
      //    is NOT trustworthy: across a backend restart, a stale
      //    hydrate, or a disconnect-and-reattach window, the cache
      //    can be empty (or stale `exited`) while the daemon still
      //    holds a handle. If we let the cache fast-path skip the
      //    wait when the daemon answered `{cleared:true}`, the DB
      //    tx would commit a `cli_session_id=null` + audit before
      //    the runtime_exit landed — exactly what C7 was meant to
      //    prevent (Cindy `Z3drVLxYkw5GUvGd` P1).
      //
      //    Rules:
      //      - `result.cleared === true` → MUST wait. The waiter
      //        may already be latched (synchronous runtime_exit
      //        during dispatch) — `clearSessions.awaitExit` resolves
      //        immediately when the waiter is already latched, otherwise
      //        races the configured bound. On timeout throw
      //        `ClearSessionExitTimeoutError`; DB UNCHANGED.
      //      - `result.cleared === false` → daemon had no handle
      //        for this pair; skip wait. This is the legitimate
      //        fast path for already-exited / orphan-row clears.
      if (result.cleared) {
        await this.clearSessions.awaitExit(conversationId, agentId);
      }

      // 7. Coordinator-side cleanup.
      state.coordinator.clearRuntime(conversationId, agentId, 'stopped');

      // 8. DB tx — audit insert + cli_session_id clear in one shot.
      const shouldAudit = wasRunning || prevCliSessionId !== null;
      const { updated, auditMessage } = this.session.atomically(scope => {
        const updated = scope.clearCliSession(conversationId, agentId);
        if (!updated) {
          throw new Error(
            `agent ${agentId} is not a member of conversation ${conversationId}`,
          );
        }
        const auditMessage = shouldAudit
          ? this.insertSessionClearedAuditMessage(scope, {
              conversationId,
              agentId,
              agentName: agent.name,
              actorUserId,
              prevCliSessionId,
              wasRunning,
            })
          : null;
        return { updated, auditMessage };
      });

      // 9. SSE + per-peer best-effort delivery (outside tx).
      this.opts.events.publishSide(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: updated.status,
          pid: updated.pid,
          cli_session_id: null,
        },
      });
      if (auditMessage) {
        this.opts.events.publish(conversationId, {
          kind: 'message',
          payload: { message: auditMessage },
        });
        // Universe alignment (design doc §5.2): the cleared agent needs
        // the audit row too — without one, its observed cursor could
        // never pass this head-bump under the signal-only stale contract
        // (its old session died; nothing else delivers this row). Row
        // only, NO dispatch: the fresh session drains it at next spawn —
        // clearing a session must not auto-respawn the runtime.
        this.inbox.ensureDelivery(conversationId, agentId, auditMessage.id);
        for (const ca of this.conversations.listAgents(conversationId)) {
          if (ca.agent_id === agentId) continue;
          await this.deliverMessage(
            conversationId,
            ca.agent_id,
            auditMessage.id,
          ).catch(err =>
            this.opts.logger.warn(
              {
                kind: 'runtime',
                mode: 'standalone',
                conversationId,
                agent_id: ca.agent_id,
                msg_id: auditMessage.id,
                err: err instanceof Error ? err.message : String(err),
              },
              'clear-session: audit delivery to peer agent failed',
            ),
          );
        }
      }

      return { prevCliSessionId, wasRunning };
    } finally {
      // 10. Finally cleanup — Cindy `nPqEVJjCLjuNDH-6` #2.
      this.clearSessions.end(conversationId, agentId);
    }
  }

  /**
   * D4.c C7 — render and insert the clear-session audit message. The wording
   * and metadata stay here (they are domain content, not a storage detail);
   * only the insert belongs to the scope, which is why the scope is a
   * parameter: this row can be written ONLY inside the atomic pair with
   * `clearCliSession`, never on its own.
   */
  private insertSessionClearedAuditMessage(
    scope: RuntimeSessionTxScope,
    params: {
      conversationId: string;
      agentId: string;
      agentName: string;
      actorUserId: string | null;
      prevCliSessionId: string | null;
      wasRunning: boolean;
    },
  ) {
    const actor = params.actorUserId ? `@${params.actorUserId}` : 'A user';
    const prevLabel = params.prevCliSessionId
      ? `${params.prevCliSessionId.slice(0, 8)}...`
      : 'none';
    return scope.insertSystemMessage({
      conversationId: params.conversationId,
      fromUserId: params.actorUserId,
      content:
        `${actor} cleared @${params.agentName}'s CLI session context ` +
        `(prev session: ${prevLabel}). Next start will use a fresh session; ` +
        'pending deliveries remain queued.',
      metadata: {
        subtype: systemSubtype('session_cleared'),
        agent_id: params.agentId,
        agent_name: params.agentName,
        actor_user_id: params.actorUserId,
        previous_cli_session_id_prefix: params.prevCliSessionId
          ? params.prevCliSessionId.slice(0, 8)
          : null,
        was_running: params.wasRunning,
      },
    });
  }

  /**
   * #task:1417 Stage 2b — drain the pending inbox for a (conv, agent) via
   * `runtime_deliver` (the SOLE delivery command). Spawns-with-batch when
   * the daemon has no live handle, admits when ready — the daemon decides.
   * Renamed from `startDeliveryBacked`: "start" (lifecycle) and "deliver"
   * (message) are now separate planes, and this one carries a message, so
   * it lives on the delivery plane. Returns true iff there was pending work
   * to dispatch (or an in-flight claim already owns it); false when the
   * inbox was empty (caller falls back to a lifecycle `startDirect`).
   */
  async deliverPending(
    conversationId: string,
    agentId: string,
  ): Promise<boolean> {
    if (this.runtimeTransitioning(agentId)) return false;
    const hostId = this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId, 'runtime_deliver');
    await this.awaitHydratedConnection(hostId, connectionId);
    const staleInFlight = this.inbox.rollbackInFlightForPairExceptOwner(
      conversationId,
      agentId,
      connectionId,
    );
    if (staleInFlight > 0) {
      this.opts.logger.warn(
        {
          kind: 'inbox',
          action: 'stale_in_flight_reclaimed_before_start',
          hostId,
          conversationId,
          agent_id: agentId,
          reclaimed_count: staleInFlight,
        },
        'outbound start reclaimed stale inbox rows claimed by an old host connection',
      );
    }
    if (this.inbox.listPending(conversationId, agentId).length === 0) {
      // Idempotency guard for concurrent claimants. A pending row can
      // already be in-flight when an explicit `runtimeHost.start` / HTTP
      // POST `/start` races another path that just claimed it — the
      // scoped reattach re-drive of a LIVE runtime
      // (`replayPendingForHost`), a per-pair `ready_for_drain` replay,
      // or another in-flight start. The racing caller then sees an empty
      // `listPending` even though a `runtime_start`/delivery dispatch is
      // already in flight (the winner transitioned the rows to
      // `in_flight_owner = <conn>`). Without this guard the explicit
      // start would throw `HostRuntimeDisabledError` ("nothing to
      // drain") and the route would return a generic 400 — strictly
      // worse UX than an idempotent success.
      //
      // We treat rows claimed by this live connection as proof that
      // the runtime is being started, and return success. Rows claimed
      // by old connection ids are stale leases and were reclaimed
      // above; they must not make an explicit restart/start look
      // successful while dispatching nothing.
      if (
        this.inbox.countInFlightForPairOwner(
          conversationId,
          agentId,
          connectionId,
        ) > 0
      ) {
        return true;
      }
      return false;
    }
    // #task:1417 Stage 2b — NO cache-entry-live fork. We claim pending and
    // submit `runtime_deliver`; the daemon decides spawn-vs-admit. The
    // ready-for-drain submit path runs the fs guards + injects
    // `spawn_options` in the coordinator's bridge closure.
    const claimed = this.inbox.claimPending(
      conversationId,
      agentId,
      connectionId,
    );
    if (claimed.length === 0) return false;
    const batch = this.pendingBatch(conversationId, agentId, claimed);
    try {
      const decision = await this.stateForHost(
        hostId,
      ).coordinator.submitReadyForDrainDeliveryBatch(conversationId, agentId, [
        {
          deliveryIds: batch.deliveryIds,
          deliveredUpToSeq: batch.deliveredUpToSeq,
          deliveries: batch.deliveries,
          dedupKey: claimed[0]!.message.id,
          text: batch.text,
          driver: {
            runtime: batch.agentRuntime,
            oneShot: batch.driver.oneShot,
            releaseProfile: batch.driver.releaseProfile,
            kickoffMode: batch.driver.kickoffMode,
          },
        },
      ]);
      // Custody: `dispatched` transfers to the daemon (rows stay in-flight,
      // ack awaits async `runtime_delivery_consumed`). Anything else
      // (`refused`, incl. a live oneShot the daemon sync-refuses) took
      // nothing → roll back to pending. A thrown dispatch (transport /
      // fs-guard) rolls back below.
      if (decision.kind !== 'dispatched') {
        this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      }
    } catch (err) {
      this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
    return true;
  }

  async start(conversationId: string, agentId: string): Promise<void> {
    // Automatic start callers are allowed to queue work while a transition
    // owns the agent. The transition resumes previously-live and pending pairs
    // after commit, so a no-op here avoids spawning the old runtime.
    if (this.runtimeTransitioning(agentId)) return;
    // #task:1417 Stage 2b — two planes. If there is pending inbox work,
    // drain it via the delivery plane (`deliverPending` → `runtime_deliver`,
    // which spawns-with-batch). Otherwise spawn a bare lifecycle runtime
    // (`startDirect` → `runtime_start`, no message).
    if (await this.deliverPending(conversationId, agentId)) return;
    await this.startDirect(conversationId, agentId);
  }

  private async startDirect(
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    if (this.runtimeTransitioning(agentId)) return;
    const hostId = this.hostIdForAgent(agentId);
    const connectionId = this.connectedConnectionId(hostId, 'runtime_start');
    await this.awaitHydratedConnection(hostId, connectionId);
    const state = this.stateForHost(hostId);
    const entry = this.cacheEntryForLiveConnection(
      state,
      connectionId,
      conversationId,
      agentId,
    );
    if (entry && entry.phase !== 'idle' && entry.phase !== 'exited') {
      return;
    }
    await this.seedRuntimeStartL2BestEffort(hostId, conversationId, agentId);
    const transport = this.requireTransport();
    if (this.runtimeTransitioning(agentId)) {
      throw new Error(`agent ${agentId} is switching runtime`);
    }
    const credential = this.prepareRuntimeCredential(
      hostId,
      state,
      conversationId,
      agentId,
    );
    let commandInvoked = false;
    try {
      const options = this.runtimeStartOptions(
        hostId,
        conversationId,
        agentId,
        credential.token,
      );
      commandInvoked = true;
      const result = await transport.sendCommand(
        hostId,
        'runtime_start',
        {
          conversation_id: conversationId,
          agent_id: agentId,
          runtime_generation: credential.principal.custody.generation,
          options,
        } satisfies RuntimeStartParams,
        { timeoutMs: 60_000, expectedConnectionId: connectionId },
      );
      if (!result.started && credential.newlyClaimed) {
        this.abandonRuntimeCredential(credential.principal);
      }
    } catch (err) {
      if (
        credential.newlyClaimed
        && this.isProvenNotDispatched(err, commandInvoked)
      ) {
        this.abandonRuntimeCredential(credential.principal);
      }
      throw err;
    }
  }

  private runtimeStartOptions(
    hostId: string,
    conversationId: string,
    agentId: string,
    agentToken: string,
  ): RuntimeStartParams['options'] {
    if (this.runtimeTransitioning(agentId)) {
      throw new Error(`agent ${agentId} is switching runtime`);
    }
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`conversation ${conversationId} not found`);
    const workspace = this.workspaces.get(conversation.workspace_id);
    if (!workspace) {
      throw new Error(`workspace ${conversation.workspace_id} not found`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    this.assertReasoningEffortSendable(hostId, agent);
    const sessionAgent = this.conversations.getAgent(conversationId, agentId);
    if (!sessionAgent) {
      throw new Error(
        `conversation_agent row missing for ${conversationId}/${agentId}`,
      );
    }
    return buildRuntimeStartOptions({
      conversation,
      workspace,
      agent,
      sessionAgent,
      members: this.members.listMembers(conversation.id),
      workspacesForAgent: this.workspaces.listForAgent(agent.id),
      silverhandCli:
        this.opts.coLocatedHostId === hostId ? this.opts.silverhandCli : null,
      agentToken,
    });
  }

  private prepareRuntimeCredential(
    hostId: string,
    state: HostFanoutState,
    conversationId: string,
    agentId: string,
  ): { principal: RuntimePrincipal; token: string; newlyClaimed: boolean } {
    const attachment = this.opts.transport()?.getAttachment(hostId) ?? null;
    const daemonInstanceId =
      state.currentDaemonKey
      ?? attachment?.daemonInstanceId;
    if (!daemonInstanceId) {
      throw new Error('runtime credential requires a ready daemon instance');
    }
    const current = this.runtimeCustody.currentConversation(
      conversationId,
      agentId,
    );
    const principal = current?.custody.daemonInstanceId === daemonInstanceId
      ? current
      : this.runtimeCustody.claimConversation({
          conversationId,
          agentId,
          daemonInstanceId,
        });
    if (!principal) {
      throw new Error(`runtime slot missing for ${conversationId}/${agentId}`);
    }
    return {
      principal,
      token: this.opts.agentTokens.issue(principal),
      newlyClaimed: principal !== current,
    };
  }

  private abandonRuntimeCredential(principal: RuntimePrincipal): void {
    if (principal.kind !== 'conversation_slot') return;
    const finalized = this.runtimeCustody.finalizeConversation({
      conversationId: principal.conversationId,
      agentId: principal.agentId,
      generation: principal.custody.generation,
      daemonInstanceId: principal.custody.daemonInstanceId,
      status: 'crashed',
    });
    if (finalized) this.opts.agentTokens.revokeFor(principal);
  }

  /** Finalizing after an ambiguous transport error can orphan a child that did
   * receive the frame. Only local construction failures and transport errors
   * proven to occur before websocket dispatch may end the new claim here.
   * Timeouts, send failures, disconnects with a request id, response mismatch,
   * and daemon errors are reconciled by generation-bound status instead. */
  private isProvenNotDispatched(err: unknown, commandInvoked: boolean): boolean {
    if (!commandInvoked) return true;
    if (!(err instanceof HostWsCommandTransportError)) return false;
    if (
      err.code === 'transport_no_connection'
      || err.code === 'transport_invalid_command'
    ) {
      return true;
    }
    return err.code === 'transport_disconnected' && !err.details.requestId;
  }

  /**
   * SEND preflight (#task:1486, Cindy P1). A non-baseline reasoning token (e.g.
   * Codex `ultra`) may only ride `runtime_start` / `runtime_deliver`'s spawn arm
   * to a daemon that advertised `runtime.codex.reasoning.v1` on its live
   * connection — an older daemon's strict enum would reject the whole frame.
   * We throw BEFORE dispatch (surfaced via the existing runtime-start error
   * path — NO new wire result/error arm, since the capability is only
   * daemon→backend and cannot negotiate a response shape) rather than silently
   * coerce the effort to a default, which would run a semantically different
   * task than the user chose. Baseline efforts always pass; the write gate is
   * what prevents persisting an unsupported combo in the first place, and this
   * is the belt for a host that changed under an already-persisted value.
   */
  private assertReasoningEffortSendable(hostId: string, agent: AgentDto): void {
    const effort = agent.reasoning_effort;
    if (!effort || agent.runtime !== 'codex') return;
    if (isBaselineReasoningEffort('codex', effort)) return;
    const capabilities =
      this.opts.transport()?.getAttachment(hostId)?.capabilities ?? [];
    if (!capabilities.includes('runtime.codex.reasoning.v1')) {
      throw new Error(
        `runtime_start blocked: reasoning_effort '${effort}' requires the target computer's daemon to advertise runtime.codex.reasoning.v1 — update the computer's Silverhand daemon or lower the effort`,
      );
    }
  }

  /**
   * Cross-computer slice 1 (#task:1596) / #task:1612 / relocation-v1 §7 task 4 —
   * pre-dispatch L2 seed on the dispatch (agent's) host, BEST-EFFORT: it seeds
   * enrichment, it NEVER gates dispatch (the shiki+Cindy pivot, 2026-08-04).
   *
   * The ONLY hard runtime-start gate is the supervisor's host-side session-cwd
   * ensure (`cwd_ready`). L1/L2 memory is enrichment: it is seeded when it can
   * be, and neither its absence nor a failure to seed it may hold a spawn
   * hostage. So this method dispatches the ACTIVE workspace's seed and records
   * ANY outcome as a DIAGNOSTIC ONLY — it returns nothing, and every caller
   * ALWAYS proceeds. The real hard conditions (transport health, the semantic
   * ref, the session cwd) are each judged SEPARATELY downstream by the runtime
   * send / resolver / supervisor; folding them into a seed-layer per-code gate
   * here duplicated that judgment and, worse, let a memory-seed failure decide
   * dispatch — which the pivot forbids. A missing ensurer (unwired dep) is
   * likewise logged and skipped: it cannot block a spawn either.
   *
   * Only the ACTIVE workspace is seeded (memoized per host/workspace/agent on
   * SUCCESS; failures retry next spawn). The seed performs NO workspace
   * provision — the daemon mkdir's the deterministic agent-centric bundle
   * coordinate directly. Peer memory-index workspaces are NEVER touched here:
   * already-materialized ones resolve daemon-side, un-materialized ones degrade
   * per-entry to "unavailable on this computer". `agent_home` is skipped
   * (daemon resolves it homedir-side).
   */
  private async seedRuntimeStartL2BestEffort(
    hostId: string,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const plan = planRuntimeStartFilesystemEnsure(
      this.workspaces.get(conversation.workspace_id) ?? undefined,
    );
    if (!plan.seedWorkspaceId) return;

    const seeder = this.opts.agentL2SeedEnsurer;
    if (!seeder) {
      this.opts.logger.warn(
        {
          kind: 'inbox',
          action: 'runtime_start_l2_seed_unwired',
          hostId,
          conversationId,
          agent_id: agentId,
          workspace_id: plan.seedWorkspaceId,
        },
        'runtime_start proceeding: L2 seed dependency unwired; spawning with reduced L2 context (memory is best-effort enrichment, not a spawn gate)',
      );
      return;
    }

    const seed = await seeder.ensure(hostId, plan.seedWorkspaceId, agentId);
    if (!seed.ok) {
      // Best-effort enrichment: ANY seed failure is a diagnostic, never an
      // admission gate. The next spawn retries (not memoized on failure). The
      // sole hard runtime-start gate — the session cwd — is enforced
      // SEPARATELY host-side, so proceeding here can never let a child start
      // without a usable cwd.
      this.opts.logger.warn(
        {
          kind: 'inbox',
          action: 'runtime_start_l2_seed_degraded',
          hostId,
          conversationId,
          agent_id: agentId,
          workspace_id: plan.seedWorkspaceId,
          code: seed.failure.code,
        },
        'runtime_start proceeding: agent L2 memory seed did not complete; spawning with reduced L2 context (best-effort enrichment; cwd is the only hard gate, judged host-side)',
      );
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
      this.opts.events.publishSide(conversationId, {
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
        this.opts.events.publishSide(conversationId, {
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

  /**
   * D5.a-3 P1-4 — bulk shutdown across every connected outbound host.
   *
   * The old embedded path routed `stopAll` to `bridge.runtimeStopAll()`
   * (one daemon); the unified outbound path can hold several connected
   * hosts, so we dispatch `runtime_stop_all` to each `connectedHostIds()`
   * over the SAME outbound command (`outbound-protocol.ts` →
   * `runtime_stop_all`). Per-host failures are best-effort/warn so one
   * unreachable host cannot block the rest of shutdown. Never a no-op:
   * the previous `ControlPlaneRuntimeHost.stopAll` silently dropped this,
   * which would orphan daemon children after backend exit.
   */
  async stopAll(): Promise<void> {
    const transport = this.opts.transport();
    if (!transport) return;
    for (const hostId of transport.connectedHostIds()) {
      try {
        await transport.sendCommand(hostId, 'runtime_stop_all', {});
      } catch (err) {
        this.opts.logger.warn(
          { kind: 'runtime', action: 'stop_all_dispatch_failed', hostId, err },
          'outbound runtime_stop_all dispatch failed for host; continuing shutdown',
        );
      }
    }
  }

  /**
   * D5.a-3 P1-4 — flush + close the activity log on shutdown.
   *
   * Asks every connected host to flush its runtime-side buffers via the
   * existing outbound `runtime_close_activity_log` command (mirrors the
   * old `bridge.runtimeCloseActivityLog()`), then closes the
   * backend-owned activity JSONL writer. Per-host dispatch is
   * best-effort/warn. Not a no-op (the old `ControlPlaneRuntimeHost`
   * silently dropped both halves).
   */
  async closeActivityLog(): Promise<void> {
    const transport = this.opts.transport();
    if (transport) {
      for (const hostId of transport.connectedHostIds()) {
        try {
          await transport.sendCommand(hostId, 'runtime_close_activity_log', {});
        } catch (err) {
          this.opts.logger.warn(
            {
              kind: 'runtime',
              action: 'close_activity_log_dispatch_failed',
              hostId,
              err,
            },
            'outbound runtime_close_activity_log dispatch failed for host; continuing',
          );
        }
      }
    }
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
      dispatchConnectionId: null,
      hydratedDaemonKey: null,
      hydratedConnectionId: null,
      hydrateInProgress: false,
      hydrateWaiters: new Map(),
      layoutMigrationLoggedDaemonKey: null,
      lastLivenessSignature: '',
    };
    const bridge: RuntimeStatusBridge = {
      runtimeStatus: async () => {
        const transport = this.requireTransport();
        const expectedConnectionId =
          state.dispatchConnectionId ?? state.currentConnectionId;
        const reconcileBaseline =
          this.hydrateReconcile.listDbLiveRuntimesForHost(hostId);
        const snapshot = await transport.sendCommand(
          hostId,
          'runtime_status',
          {},
          {
            timeoutMs: 5_000,
            ...(expectedConnectionId
              ? { expectedConnectionId }
              : {}),
          },
        );
        if (state.currentConnectionId !== expectedConnectionId) {
          throw new Error('outbound connection changed during runtime_status hydrate');
        }
        return {
          ...snapshot,
          [HYDRATE_RECONCILE_BASELINE]: reconcileBaseline,
        } satisfies RequestBoundRuntimeStatus;
      },
    };
    const coordinator = new RuntimeDeliveryCoordinator({
      bridge: {
        // #task:1417 Stage 2b — `runtime_deliver` is the SOLE message
        // delivery command. The daemon owns spawn-vs-admit, so ANY deliver
        // may spawn: run the same fs guards the old delivery-backed start
        // ran (host-equality fail-closed + L2 seed) and inject
        // `spawn_options` BEFORE dispatch. The seed is memoized, so the
        // ready-admit hot path pays only an in-memory set lookup after the
        // first seed.
        runtimeDeliver: async params => {
          if (this.runtimeTransitioning(params.agent_id)) {
            throw new Error(`agent ${params.agent_id} is switching runtime`);
          }
          // Pin the deliver to the SAME connection the caller resolved and
          // claimed rows under. During event dispatch (respawn / drain
          // replay) that is `dispatchConnectionId` (the event's connection,
          // already staleness-gated at ingress). For a route-driven deliver
          // there is no dispatch context, so fall back to the transport's
          // CURRENT connection — NOT `currentConnectionId`, which is only
          // seeded by a processed `ready` and is legitimately null/stale in
          // the reconnect window (new socket attached, its `ready` not yet
          // processed). `connectedConnectionId` throws a typed
          // `transport_no_connection` when the host has no live connection.
          const connectionId =
            state.dispatchConnectionId ??
            this.connectedConnectionId(hostId, 'runtime_deliver');
          await this.seedRuntimeStartL2BestEffort(
            hostId,
            params.conversation_id,
            params.agent_id,
          );
          if (
            (this.opts.transport()?.connectionIdForHost(hostId) ?? null) !==
            connectionId
          ) {
            throw new Error('outbound connection changed during runtime_deliver guards');
          }
          const credential = this.prepareRuntimeCredential(
            hostId,
            state,
            params.conversation_id,
            params.agent_id,
          );
          let commandInvoked = false;
          try {
            const spawn_options = this.runtimeStartOptions(
              hostId,
              params.conversation_id,
              params.agent_id,
              credential.token,
            );
            const transport = this.requireTransport();
            if (this.runtimeTransitioning(params.agent_id)) {
              throw new Error(`agent ${params.agent_id} is switching runtime`);
            }
            commandInvoked = true;
            const result = await transport.sendCommand(
              hostId,
              'runtime_deliver',
              {
                ...params,
                runtime_generation: credential.principal.custody.generation,
                spawn_options,
              },
              { timeoutMs: 60_000, expectedConnectionId: connectionId },
            );
            if (
              result.disposition === 'refused'
              && credential.newlyClaimed
            ) {
              this.abandonRuntimeCredential(credential.principal);
            }
            return result;
          } catch (err) {
            if (
              credential.newlyClaimed
              && this.isProvenNotDispatched(err, commandInvoked)
            ) {
              this.abandonRuntimeCredential(credential.principal);
            }
            throw err;
          }
        },
      },
      cache,
      callbacks: {
        // Auto-respawn-to-drain on non-fatal runtime exit with pending
        // inbox. The coordinator's `onRuntimeExit` gate
        // (intentional===false AND !initTimedOut AND !fatalError AND
        // hasPendingInbox) is the ONLY correct redelivery path for a
        // runtime that exited while inbox rows are still pending: a
        // `runtime_deliver` with no live handle spawns a fresh runtime
        // that drains the batch in its init phase. `deliverPending` is
        // idempotent (in-flight guard + atomic claim) so a spurious or
        // duplicate call is a benign no-op. Mapped to `Promise<void>` so
        // any rejection still reaches the coordinator's best-effort
        // `.catch`.
        respawn: (cid, aid) =>
          this.deliverPending(cid, aid).then(() => undefined),
        hasPendingInbox: (cid, aid) =>
          !this.runtimeTransitioning(aid)
          && this.inbox.listPending(cid, aid).length > 0,
        publishActivity: runState => {
          this.opts.events.publishSide(runState.conversationId, {
            kind: 'agent_activity',
            payload: runState,
          });
          this.activityLog?.write(runState);
        },
      },
      logger: this.opts.logger,
    });
    const handler = new RuntimeEventHandler({
      client: noopRuntimeEventSource(),
      bridge,
      cache,
      events: this.opts.events,
      inboxAck: this.inboxAck,
      statusProjector: this.opts.statusProjector,
      daemonInstanceId: () =>
        state.currentDaemonKey
        ?? this.opts.transport()?.getAttachment(hostId)?.daemonInstanceId
        ?? null,
      acceptRuntimeCustody: input => {
        const current = this.runtimeCustody.currentConversation(
          input.conversationId,
          input.agentId,
        );
        return current?.kind === 'conversation_slot'
          && current.custody.generation === input.custody.generation
          && current.custody.daemonInstanceId
            === input.custody.daemonInstanceId;
      },
      hasRuntimeCredential: input =>
        this.opts.agentTokens.hasActiveFor(conversationRuntimePrincipal({
          conversationId: input.conversationId,
          agentId: input.agentId,
          generation: input.custody.generation,
          daemonInstanceId: input.custody.daemonInstanceId,
        })),
      onHydrateRuntimeRejected: async input => {
        const connectionId = this.connectedConnectionId(
          hostId,
          'runtime_stop',
        );
        this.opts.logger.warn(
          {
            kind: 'runtime',
            action: 'hydrate_runtime_rejected',
            hostId,
            conversationId: input.conversationId,
            agent_id: input.agentId,
            runtime_generation: input.custody.generation,
            reason: input.reason,
          },
          'hydrate cannot adopt runtime; stopping exact generation before retry',
        );
        await this.dispatchStop(
          hostId,
          connectionId,
          input.conversationId,
          input.agentId,
          input.custody.generation,
        );
      },
      onRuntimeCustodyFinalized: principal =>
        this.opts.agentTokens.revokeFor(principal),
      conversationActivity: this.opts.conversationActivity,
      onParsedEvent: (cid, aid, event) =>
        coordinator.onParsedEvent(cid, aid, event),
      onRuntimeExit: (cid, aid, meta) => {
        // D4.c C7 — notify any in-flight `clearSession` waiter
        // BEFORE handing off to the coordinator. The coordinator's
        // own respawn-gate logic doesn't care whether a clear-session
        // is awaiting; the waiter does. Order: waiter first so a
        // synchronous resolve cannot race the next microtask.
        this.clearSessions.notifyExit(cid, aid);
        coordinator.onRuntimeExit(cid, aid, meta);
      },
      onInitTimeout: (cid, aid) =>
        coordinator.clearDeliveryWatchdog(cid, aid, 'timeout'),
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
      // Reattach re-drive. Fires AFTER the daemon's `runtime_status`
      // snapshot has hydrated the cache, scoped (in
      // `replayPendingForHost`) to runtimes the snapshot reports as
      // ALREADY ALIVE — live-delivery-only, never spawn. We dispatch via
      // `queueMicrotask` so the hydrate code path returns first (the
      // dispatch awaits the WS round-trip and we don't want to nest
      // that inside the hydrate callback).
      onHydrateComplete: (_trigger, snapshot) => {
        const connectionId = state.currentConnectionId;
        if (!connectionId) {
          // Hydrate-without-connection shouldn't happen in
          // practice (hydrate runs from inside an event path that
          // just set currentConnectionId), but bail safely if it
          // does.
          return;
        }
        // #task:1588 — the cache now holds the daemon's atomic
        // whole-set snapshot; host-level liveness reads may trust it
        // for this generation. Force-publish: the seed→cache authority
        // switch must be observable even when the cache signature
        // didn't move (see maybePublishLivenessChanged).
        state.hydratedDaemonKey = state.currentDaemonKey;
        state.hydratedConnectionId = connectionId;
        state.hydrateInProgress = false;
        this.resolveHydrateWaiters(state, connectionId);
        this.maybePublishLivenessChanged(hostId, state, { force: true });
        this.reconcileMissingRuntimesAfterHydrate(hostId, state, snapshot);
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
   * Re-drive pending inbox drain after a daemon reattach, scoped to the
   * runtimes that are **already alive** in the just-hydrated snapshot.
   * Called from `onHydrateComplete` via `queueMicrotask` so the WS read
   * loop stays unblocked.
   *
   * Why scoped to live runtimes (root-cause fix for the boot herd):
   * we must NOT derive "runtimes to start" from the DB's full pending
   * set. The previous implementation enumerated every pending
   * (conversation, agent) pair for the host (a since-removed
   * `listPendingPairsForHost` repo query) and called
   * `startDeliveryBacked` per pair, which `runtime_start`-spawns a
   * fresh runtime whenever the pair has no live cache entry. On a cold
   * daemon boot the hydrated cache is empty, so EVERY historical
   * pending (conversation, agent) pair took the spawn path — an agent
   * that's a member of N backlogged conversations booted N persistent
   * `claude` processes at once (O(conversations) memory, one ~280MB
   * process each). A daemon reattach is not an instruction to execute
   * every historical inbox.
   *
   * New contract: only runtimes the daemon reports as alive (`phase ===
   * 'ready'`) in the hydrate snapshot are re-driven, via the live-delivery-only
   * `replayPendingForAgent` path (it submits a ready-for-drain batch to
   * an existing runtime and can never `runtime_start`). This handles the
   * real reattach concern — a live runtime whose in-flight delivery got
   * rolled back across the reconnect window. Pending for a pair with NO
   * live runtime stays a durable inbox and drains lazily on the next
   * live delivery to that specific pair (`startDeliveryBacked`), never
   * here. Cold boot with no live runtimes therefore spawns nothing.
   *
   *   - `expectedConnectionId` guard: if `currentConnectionId` flipped to
   *     a newer one between the `queueMicrotask` schedule and execution
   *     (the daemon bounced again), abort. The newer ready frame
   *     schedules its own replay.
   *   - Per-pair try/catch: one bad pair must not poison the rest of the
   *     host's drain.
   */
  private async replayPendingForHost(
    hostId: string,
    expectedConnectionId: string,
  ): Promise<void> {
    const state = this.states.get(hostId);
    if (!state || state.currentConnectionId !== expectedConnectionId) return;
    // Live runtimes only — derived from the hydrated cache, NOT from the
    // DB pending set. `phase === 'ready'` is the only drainable-live
    // phase (a 'starting' runtime drains on its own ready_for_drain
    // event; 'draining'/'exited'/'idle' are not deliverable here).
    const liveReady = state.cache
      .list()
      .filter(entry => entry.phase === 'ready');
    for (const { conversationId, agentId } of liveReady) {
      if (
        !this.states.get(hostId) ||
        this.states.get(hostId)?.currentConnectionId !== expectedConnectionId
      ) {
        // Connection bounced between scheduling and execution. Bail —
        // the newer connection's hydrate will replay.
        this.opts.logger.info(
          {
            hostId,
            expectedConnectionId,
            currentConnectionId:
              this.states.get(hostId)?.currentConnectionId ?? null,
          },
          'outbound replay-on-reattach: connection changed mid-drain, aborting',
        );
        return;
      }
      if (this.inbox.listPending(conversationId, agentId).length === 0) {
        continue;
      }
      try {
        await this.replayPendingForAgent(
          hostId,
          expectedConnectionId,
          conversationId,
          agentId,
        );
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
    if (this.runtimeTransitioning(agentId)) return;
    const claimed = this.inbox.claimPending(
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
          deliveredUpToSeq: batch.deliveredUpToSeq,
          deliveries: batch.deliveries,
          dedupKey: claimed[0]!.message.id,
          text: batch.text,
          driver: {
            runtime: batch.agentRuntime,
            oneShot: batch.driver.oneShot,
            releaseProfile: batch.driver.releaseProfile,
            kickoffMode: batch.driver.kickoffMode,
          },
        }],
      );
      // #task:1417 Stage 2b — `dispatched` transfers custody to the daemon
      // (rows stay in-flight, ack awaits `runtime_delivery_consumed`).
      // ready-for-drain never queues mid-turn, so anything else (`refused`,
      // incl. a live oneShot the daemon sync-refuses) took nothing → roll
      // back.
      if (decision.kind !== 'dispatched') {
        this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      }
    } catch (err) {
      this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
  }

  private cacheEntryForLiveConnection(
    state: HostFanoutState,
    connectionId: string,
    conversationId: string,
    agentId: string,
  ): CachedRuntimeEntry | undefined {
    if (state.currentConnectionId !== connectionId) {
      state.currentConnectionId = null;
      state.currentDaemonKey = null;
      state.dispatchConnectionId = null;
      state.cache.clearAll();
      return undefined;
    }
    return state.cache.get(conversationId, agentId);
  }

  /**
   * A freshly attached connection is not a command authority until its atomic
   * runtime_status snapshot has converged. In particular, backend restart
   * leaves live children whose bearer secret is no longer in memory: allowing a
   * route-driven start/deliver to race their cleanup can drop the new child's
   * early events into the pre-hydrate window.
   */
  private async awaitHydratedConnection(
    hostId: string,
    connectionId: string,
  ): Promise<void> {
    const state = this.stateForHost(hostId);
    // A command that predates the daemon's `ready` event has no hydrate to
    // await. Once ready has begun the atomic snapshot, however, commands must
    // remain behind it until custody/credential cleanup converges.
    if (!state.hydrateInProgress) return;
    if (
      state.currentConnectionId === connectionId
      && state.currentDaemonKey !== null
      && state.hydratedDaemonKey === state.currentDaemonKey
      && state.hydratedConnectionId === connectionId
    ) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiters = state.hydrateWaiters.get(connectionId) ?? new Set();
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) state.hydrateWaiters.delete(connectionId);
          reject(new Error(
            `host ${hostId} runtime_status hydrate did not complete for connection ${connectionId}`,
          ));
        }, 30_000),
      };
      waiters.add(waiter);
      state.hydrateWaiters.set(connectionId, waiters);
    });
  }

  private resolveHydrateWaiters(
    state: HostFanoutState,
    connectionId: string,
  ): void {
    const waiters = state.hydrateWaiters.get(connectionId);
    if (!waiters) return;
    state.hydrateWaiters.delete(connectionId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectHydrateWaiters(
    state: HostFanoutState,
    connectionId: string,
    error: Error,
  ): void {
    const waiters = state.hydrateWaiters.get(connectionId);
    if (!waiters) return;
    state.hydrateWaiters.delete(connectionId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private async deliverLivePendingForAgent(
    hostId: string,
    connectionId: string,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    if (this.runtimeTransitioning(agentId)) return;
    const claimed = this.inbox.claimPending(
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
          deliveredUpToSeq: batch.deliveredUpToSeq,
          deliveries: batch.deliveries,
          dedupKey: claimed[0]!.message.id,
          text: batch.text,
          driver: {
            runtime: batch.agentRuntime,
            oneShot: batch.driver.oneShot,
            releaseProfile: batch.driver.releaseProfile,
            kickoffMode: batch.driver.kickoffMode,
          },
        }],
      );
      // #task:1417 Stage 3 custody — roll back ONLY when the batch found no
      // owner: `refused` (daemon took nothing, incl. a live oneShot it
      // sync-refuses; that oneShot drains on its next respawn-with-batch).
      // `dispatched` covers `admitted`/`spawning` AND the daemon's
      // `deferred` (held in the daemon's own mid-turn queue) — all keep the
      // rows in-flight (owner=conn). A disconnect rolls those back via
      // `rollbackInFlightForOwner` (paired with the daemon's owner-scoped
      // `cleanupDeferredForOwner`); a thrown dispatch rolls back below.
      if (decision.kind === 'refused') {
        this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      }
    } catch (err) {
      this.inbox.rollbackInFlight(batch.deliveryIds, connectionId);
      throw err;
    }
  }

  private pendingBatch(
    conversationId: string,
    agentId: string,
    claimed: readonly RuntimeClaimedInboxDelivery[],
  ): PendingDeliveryBatch {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const driver = getDriver(agent.runtime);
    const format = (rows: readonly RuntimeClaimedInboxDelivery[]) =>
      formatInboxBatchPresentation(
        [...rows],
        id => this.agents.get(id)?.name,
        id => this.agents.get(id)?.host_id,
        id => this.users.nameOf(id) ?? undefined,
        this.defaultUserHandle(conversationId),
        agent.name,
        sendMessageToolName(),
        message => this.references.referencesOf(message),
      );
    const formatted = format(claimed);
    return {
      deliveryIds: claimed.map(row => row.inboxId),
      deliveredUpToSeq: Math.max(...claimed.map(row => row.message.seq)),
      deliveries: claimed.map((row, index) => ({
        delivery_id: row.inboxId,
        message_id: row.message.id,
        seq: row.message.seq,
        thread_root_id: row.message.thread_root_id,
        delivery_kind: row.deliveryKind,
        presentation: formatted.presentations[index]!,
      })),
      text: formatted.text,
      agentRuntime: agent.runtime,
      driver,
    };
  }

  private runtimeTransitioning(agentId: string): boolean {
    return this.agents.isRuntimeTransitioning(agentId);
  }

  private defaultUserHandle(conversationId: string): string | undefined {
    const viewerId = this.conversations.singleViewerUserId(conversationId);
    if (!viewerId) return undefined;
    return this.users.nameOf(viewerId) ?? undefined;
  }

  private hostIdForAgent(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const host = this.hosts.routingView(agent.host_id);
    if (!host) {
      throw new Error(`host ${agent.host_id} for agent ${agentId} not found`);
    }
    if (host.revokedAt !== null) {
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
      throw new OutboundFrameTransportError(
        'transport_no_connection',
        `outbound host ${hostId} is not connected`,
        { hostId, commandKind },
      );
    }
    return connectionId;
  }

  private requireTransport(): OutboundFrameAdapter {
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

function noopRuntimeEventSource(): RuntimeEventSource {
  return {
    subscribe: () => () => {},
    onReconnect: () => () => {},
  };
}

function clearSessionKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
}

function idleReapRuntimeEnabled(_runtime: RuntimeKind): boolean {
  return true;
}

/**
 * Pure: agents with at least one runtime in an active phase, scoped to
 * `daemonKey` (entries from a previous daemon generation never count).
 * Aggregates per agent across conversations — one runtime exiting must
 * not mark an agent offline while another of its runtimes lives.
 *
 * The phase whitelist is the SHARED `HOST_ACTIVE_RUNTIME_PHASES` from
 * `@silverhand/host` protocol — the same set the daemon's own
 * `host_status.active_agent_ids` derivation filters on, so backend and
 * daemon liveness cannot drift (fail-closed on unknown phases).
 */
export function activeAgentIdsFromCacheEntries(
  entries: readonly CachedRuntimeEntry[],
  daemonKey: string | null,
): string[] {
  if (daemonKey === null) return [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.daemonInstanceKey !== daemonKey) continue;
    if (!isHostActiveRuntimePhase(entry.phase)) continue;
    ids.add(entry.agentId);
  }
  return [...ids];
}
