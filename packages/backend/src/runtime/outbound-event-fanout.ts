import type { Database } from 'better-sqlite3';
import {
  EventFrameSchema,
  type EventFrame,
  type OutboundDaemonToServerEventFrame,
  type OutboundServerCommandKind,
  type RuntimeStartParams,
  type RuntimeStopParams,
} from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type { AgentRunState, AgentRunTerminalReason } from '@silverhand/shared';
import type { AgentTokenStore } from '../auth/agent-token-store.js';
import type { BackendLogger, SilverhandCliLauncher } from '../context.js';
import { systemSubtype } from '@silverhand/shared';
import { AgentRepo } from '../repos/agent-repo.js';
import {
  ConversationInboxRepo,
  type ClaimedConversationInboxItem,
} from '../repos/conversation-inbox-repo.js';
import { ConversationRepo } from '../repos/conversation-repo.js';
import { HostRepo } from '../repos/host-repo.js';
import { MessageRepo } from '../repos/message-repo.js';
import { UserRepo } from '../repos/user-repo.js';
import { WorkspaceRepo } from '../repos/workspace-repo.js';
import { MembershipService } from '../services/membership-service.js';
import type { HostWsEventSink } from '../ws/host-ws-server.js';
import {
  OutboundFrameTransportError,
  type OutboundFrameAdapter,
} from './outbound-frame-adapter.js';
import { singleConversationViewerUserId } from '../viewer-scope.js';
import { JsonlActivityLogWriter, type ActivityLogWriter } from './activity-log-writer.js';
import {
  CLEAR_SESSION_EXIT_TIMEOUT_MS,
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
  DEFAULT_SOFT_DIRECTIVE,
  type ClearSessionResult,
} from './agent-runtime-host.js';
import { RuntimeDeliveryCoordinator } from './delivery-coordinator.js';
import {
  RuntimeEventHandler,
  type EventPublisher,
  type InboxAckSink,
  type RuntimeEventSource,
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
  transport: () => OutboundFrameAdapter | null;
  logger: BackendLogger;
  silverhandDir: string;
  workspacesRoot: string;
  silverhandCli: SilverhandCliLauncher;
  agentTokens: AgentTokenStore;
  serverUrl: () => string;
  proxyPolicy: () => RuntimeStartProxyPolicy;
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

interface HostFanoutState {
  cache: RunStateCache;
  coordinator: RuntimeDeliveryCoordinator;
  handler: RuntimeEventHandler;
  currentConnectionId: string | null;
  currentDaemonKey: string | null;
}

/**
 * D4.c C7 — one-shot waiter for `clearSession`'s bounded wait on
 * the post-`runtime_clear_session` `runtime_exit` event landing in
 * projection. Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6` final.
 *
 * Lifecycle:
 *
 *   1. Registered BEFORE `transport.sendCommand('runtime_clear_session')`
 *      so a `runtime_exit` that lands during the WS round-trip cannot
 *      be missed (the daemon emits the event from `onChildExit`,
 *      which can race the command response).
 *   2. `notifyExit` is called from `stateForHost.onRuntimeExit`'s
 *      callback wrapper after the cache/SSE has already updated.
 *      Latches `exited = true` and resolves any awaiter.
 *   3. `clearSession` calls `awaitExit(timeoutMs)` after dispatch;
 *      either resolves immediately (latched) or races the timeout.
 *   4. `finally` cleanup (Cindy `nPqEVJjCLjuNDH-6` constraint #2)
 *      removes the entry from `clearSessionWaiters` regardless of
 *      success/timeout/dispatch-fail/DB-tx-fail.
 */
interface ClearSessionWaiter {
  exited: boolean;
  resolveExited: (() => void) | null;
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
  private readonly messages: MessageRepo;
  private readonly membership: MembershipService;
  private readonly inboxAck: InboxAckSink;
  private readonly activityLog: ActivityLogWriter | null;
  private readonly ownsActivityLog: boolean;
  /**
   * D4.c C7 — keyed by `${conversationId}|${agentId}`. Presence of
   * an entry means a `clearSession` is awaiting `runtime_exit` for
   * that pair; concurrent dispatch on the same pair fails fast with
   * {@link ClearSessionInProgressError}.
   */
  private readonly clearSessionWaiters = new Map<string, ClearSessionWaiter>();
  private readonly clearSessionExitTimeoutMs: number;

  constructor(private readonly opts: OutboundRuntimeEventFanoutOptions) {
    this.inboxRepo = new ConversationInboxRepo(opts.db);
    this.conversations = new ConversationRepo(opts.db);
    this.agents = new AgentRepo(opts.db);
    this.hosts = new HostRepo(opts.db);
    this.users = new UserRepo(opts.db);
    this.workspaces = new WorkspaceRepo(opts.db, {
      workspacesRoot: opts.workspacesRoot,
    });
    this.messages = new MessageRepo(opts.db);
    this.membership = new MembershipService({
      agents: new AgentRepo(opts.db),
      users: new UserRepo(opts.db),
      conversations: new ConversationRepo(opts.db),
    });
    this.clearSessionExitTimeoutMs =
      opts.clearSessionExitTimeoutMs ?? CLEAR_SESSION_EXIT_TIMEOUT_MS;
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
    if (!this.assertEventOwnership(hostId, event)) {
      return;
    }
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

  /**
   * D4.c C5 — runtime perimeter check. Returns `true` when the
   * event is allowed to proceed into per-host state mutation
   * + dispatch; `false` after logging and dropping a mismatch.
   *
   * Daemon-level frames (no `agent_id` — currently `ready` and
   * `shutting_down`) are owned by the connection's hostId by
   * construction and always pass. Future daemon-level event
   * kinds without `agent_id` will be admitted automatically.
   *
   * Per-agent frames are runtime claims — daemon X is asserting
   * "agent A on conversation C just produced event E". The full
   * runtime pair claim must hold against the server's DB state,
   * otherwise host X could (a) emit events for someone else's
   * agent, OR (b) emit events using its own agent but TARGETING
   * someone else's conversation, leaking projections / DB writes /
   * SSE into another tenant. Cindy `dgCAVQ3fbHoOFvvN` P1 was the
   * second arm: a previous version only checked `agent.host_id`
   * which left the `(agent_id == mine, conversation_id == theirs)`
   * shape uncovered.
   *
   * Validation chain (short-circuited; first failure wins):
   *
   *   1. `agents.get(agent_id)` exists.
   *      → fail: drop, log `outbound_event_unknown_agent`.
   *   2. `agent.host_id === hostId`.
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'agent_host_mismatch'`.
   *   3. `conversations.get(conversation_id)` exists.
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'conversation_unknown'`.
   *   4. `workspaces.get(conversation.workspace_id).workspace_host_id === hostId`.
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'conversation_host_mismatch'`. Workspace
   *        host equality is the right axis here, not just agent
   *        host: we already required (2), so `agent.host_id` and
   *        `workspace.workspace_host_id` must agree on the same
   *        host or the runtime claim is impossible.
   *   5. `conversations.getAgent(conversation_id, agent_id)`
   *      exists (i.e. the (cid, aid) pair is in `conversation_agents`).
   *      → fail: drop, log `outbound_event_perimeter_mismatch`
   *        with `reason: 'agent_not_in_conversation'`.
   *
   * We keep `outbound_event_unknown_agent` as a separate warn
   * action because "host references a non-existent agent" is a
   * different operational signal (likely DB rollback / migration
   * skew) from "host crossed the runtime boundary".
   *
   * We deliberately do NOT close the WS on any of these. A single
   * bad frame may be a transient bug (race / refactor glitch);
   * kicking the socket would also break the host's legitimate
   * runtimes. Anti-abuse rate-counting is out of scope (D5 / T2).
   */
  private assertEventOwnership(
    hostId: string,
    event: OutboundDaemonToServerEventFrame,
  ): boolean {
    if (!('agent_id' in event)) {
      // Daemon-level frame — owned by the connection's hostId by
      // construction (no per-agent target), admitted.
      return true;
    }
    const agent = this.agents.get(event.agent_id);
    if (!agent) {
      this.opts.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          eventKind: event.kind,
          action: 'outbound_event_unknown_agent',
        },
        'outbound event references unknown agent — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    if (agent.host_id !== hostId) {
      this.opts.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          agentHostId: agent.host_id,
          eventKind: event.kind,
          reason: 'agent_host_mismatch',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event from host A references agent owned by host B — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    // Per-agent frames carry conversation_id by schema construction
    // (every OutboundDaemonToServerEventFrame variant with
    // `agent_id` also has `conversation_id`). A missing field
    // here would be a schema bug.
    const conversationId = (event as { conversation_id: string }).conversation_id;
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      this.opts.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          conversationId,
          eventKind: event.kind,
          reason: 'conversation_unknown',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event references unknown conversation — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    const workspace = this.workspaces.get(conversation.workspace_id);
    if (!workspace || workspace.workspace_host_id !== hostId) {
      this.opts.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          conversationId,
          workspaceId: conversation.workspace_id,
          workspaceHostId: workspace?.workspace_host_id ?? null,
          eventKind: event.kind,
          reason: 'conversation_host_mismatch',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event from host A targets a conversation owned by host B — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    if (!this.conversations.getAgent(conversationId, event.agent_id)) {
      this.opts.logger.warn(
        {
          connectionHostId: hostId,
          agentId: event.agent_id,
          conversationId,
          eventKind: event.kind,
          reason: 'agent_not_in_conversation',
          action: 'outbound_event_perimeter_mismatch',
        },
        'outbound event claims an agent that is not a member of the conversation — dropped (D4.c C5 perimeter)',
      );
      return false;
    }
    return true;
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

  /**
   * D4.c C7 — standalone-side `clearSession`.
   *
   * Mirrors `DaemonAgentRuntimeHost.clearSession` (embedded path)
   * with one architectural addition: a bounded wait for the
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
   *      delivery-state cleanup (cancel wake watchdog, drop
   *      pending/busy markers).
   *   8. DB transaction (Cindy `szDHSdeKwtEUlxZb` P3): the
   *      `updateAgentRuntime(cliSessionId: null)` write AND the
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
    const waiterKey = clearSessionKey(conversationId, agentId);
    if (this.clearSessionWaiters.has(waiterKey)) {
      throw new ClearSessionInProgressError(conversationId, agentId);
    }

    const hostId = this.hostIdForAgent(agentId);
    const state = this.stateForHost(hostId);

    // 3. Snapshot pre-state.
    const prevCliSessionId = existing.cli_session_id;
    const cacheEntryBefore = state.cache.get(conversationId, agentId);
    const wasRunning =
      cacheEntryBefore !== undefined && cacheEntryBefore.phase !== 'exited';

    // 4. Register waiter BEFORE dispatch.
    const waiter: ClearSessionWaiter = { exited: false, resolveExited: null };
    this.clearSessionWaiters.set(waiterKey, waiter);

    try {
      // 5. Dispatch over WS. Connection must exist; outbound
      //    transport throws typed `transport_no_connection` /
      //    `transport_disconnected` which the route maps to 503
      //    `host_attach_pending`. DB is still untouched on throw.
      const connectionId = this.connectedConnectionId(
        hostId,
        'runtime_clear_session',
      );
      const result = await this.requireTransport().sendCommand(
        hostId,
        'runtime_clear_session',
        { conversation_id: conversationId, agent_id: agentId },
        { timeoutMs: 10_000, expectedConnectionId: connectionId },
      );

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
      //        during dispatch) — `awaitRuntimeExitLanded` resolves
      //        immediately when `waiter.exited` is true, otherwise
      //        races the configured bound. On timeout throw
      //        `ClearSessionExitTimeoutError`; DB UNCHANGED.
      //      - `result.cleared === false` → daemon had no handle
      //        for this pair; skip wait. This is the legitimate
      //        fast path for already-exited / orphan-row clears.
      if (result.cleared) {
        await this.awaitRuntimeExitLanded(waiter, conversationId, agentId);
      }

      // 7. Coordinator-side cleanup.
      state.coordinator.clearRuntime(conversationId, agentId, 'stopped');

      // 8. DB tx — audit insert + cli_session_id clear in one shot.
      const shouldAudit = wasRunning || prevCliSessionId !== null;
      const { updated, auditMessage } = this.opts.db.transaction(() => {
        const updated = this.conversations.updateAgentRuntime(
          conversationId,
          agentId,
          { cliSessionId: null },
        );
        if (!updated) {
          throw new Error(
            `agent ${agentId} is not a member of conversation ${conversationId}`,
          );
        }
        const auditMessage = shouldAudit
          ? this.insertSessionClearedAuditMessage({
              conversationId,
              agentId,
              agentName: agent.name,
              actorUserId,
              prevCliSessionId,
              wasRunning,
            })
          : null;
        return { updated, auditMessage };
      })();

      // 9. SSE + per-peer best-effort delivery (outside tx).
      this.opts.events.publish(conversationId, {
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
      this.clearSessionWaiters.delete(waiterKey);
    }
  }

  /**
   * D4.c C7 — race a one-shot `runtime_exit` waiter against the
   * configured timeout. Throws {@link ClearSessionExitTimeoutError}
   * on timeout; resolves on `runtime_exit` projection landed.
   *
   * The waiter is held by `clearSession`'s `try/finally`; this
   * helper does NOT delete the entry — the caller's `finally` does
   * that for both branches (success & timeout).
   */
  private awaitRuntimeExitLanded(
    waiter: ClearSessionWaiter,
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    if (waiter.exited) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timer = null;
        // Detach the resolver so a late `runtime_exit` doesn't try
        // to call `resolve` on an already-rejected promise.
        waiter.resolveExited = null;
        reject(new ClearSessionExitTimeoutError(conversationId, agentId));
      }, this.clearSessionExitTimeoutMs);
      waiter.resolveExited = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        waiter.resolveExited = null;
        resolve();
      };
    });
  }

  /**
   * D4.c C7 — invoked from the `RuntimeEventHandler.onRuntimeExit`
   * callback wrapper after the cache and SSE have already updated.
   * Latches `exited = true` on any in-flight waiter for this pair
   * and resolves the awaiter (if one is parked).
   *
   * Idempotent: a second `runtime_exit` for the same pair is a
   * no-op (the resolver is null after first fire).
   */
  private notifyClearSessionWaiter(
    conversationId: string,
    agentId: string,
  ): void {
    const waiter = this.clearSessionWaiters.get(
      clearSessionKey(conversationId, agentId),
    );
    if (!waiter) return;
    waiter.exited = true;
    const resolve = waiter.resolveExited;
    if (resolve) resolve();
  }

  /**
   * D4.c C7 — mirrors `DaemonAgentRuntimeHost.insertSessionClearedAuditMessage`
   * (`daemon-agent-runtime-host.ts:679-705`). Lifted inline rather
   * than shared because the embedded path is the legacy duplicate;
   * once D4 is fully cut over the standalone version is the single
   * implementation. R4 invariant: same audit row shape on both
   * deployment adapters.
   */
  private insertSessionClearedAuditMessage(params: {
    conversationId: string;
    agentId: string;
    agentName: string;
    actorUserId: string | null;
    prevCliSessionId: string | null;
    wasRunning: boolean;
  }) {
    const actor = params.actorUserId ? `@${params.actorUserId}` : 'A user';
    const prevLabel = params.prevCliSessionId
      ? `${params.prevCliSessionId.slice(0, 8)}...`
      : 'none';
    return this.messages.insertForConversation({
      conversationId: params.conversationId,
      fromKind: 'system',
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
      client: noopRuntimeEventSource(),
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
      onRuntimeExit: (cid, aid, meta) => {
        // D4.c C7 — notify any in-flight `clearSession` waiter
        // BEFORE handing off to the coordinator. The coordinator's
        // own respawn-gate logic doesn't care whether a clear-session
        // is awaiting; the waiter does. Order: waiter first so a
        // synchronous resolve cannot race the next microtask.
        this.notifyClearSessionWaiter(cid, aid);
        coordinator.onRuntimeExit(cid, aid, meta);
      },
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

function daemonKeyFromReady(daemonPid: number, startedAt: number): string {
  return `${daemonPid}@${startedAt}`;
}

function clearSessionKey(conversationId: string, agentId: string): string {
  return `${conversationId}|${agentId}`;
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
