/**
 * `DaemonAgentRuntimeHost` — daemon-mode implementation of
 * `AgentRuntimeHost`.
 *
 * # Scope of this sub-commit (2b-ii, slices 1-4b)
 *
 * The lifecycle / delivery surface is being filled in across multiple
 * sub-commits. This file currently implements:
 *
 *   - **Read methods** — `getAgentRunStates`, `resolveRun`,
 *     `resolveConversationRuns` — backed by `RunStateCache` + an
 *     `EventPublisher` for the SSE side of `resolveRun`.
 *   - **Stop** — both `'hard'` and `'soft'`. Hard delegates straight
 *     to `bridge.runtimeStop`; soft composes the directive line via
 *     the agent's driver and ships it as `soft_directive`.
 *   - **Bulk shutdown** — `stopAll` → `bridge.runtimeStopAll`;
 *     `closeActivityLog` → `bridge.runtimeCloseActivityLog`.
 *   - **Boot recovery** — `reconcileOnBoot` starts the event
 *     subscription (which performs the initial `runtime_status`
 *     hydrate), then diffs the daemon's snapshot against the DB's
 *     `starting` / `active` `conversation_agents` rows.
 *   - **Clear session** — `clearSession` calls the bridge BEFORE the
 *     DB tx (Cindy `5Yrv3roymWkCPxo1` #2), then writes the audit row
 *     + publishes `agent_status` + `message` SSE.
 *   - **Deliver message** — `deliverMessage` looks up the message,
 *     ensures the inbox row, formats the stream-json payload via the
 *     shared `formatLiveMessage` helper, then submits to
 *     `RuntimeDeliveryCoordinator`. Coordinator owns
 *     wake-vs-queue-vs-respawn routing + `markDelivered` timing
 *     (Cindy `5Yrv3roymWkCPxo1` #4: oneShot respawn ONLY via
 *     `start()+startup_delivery`).
 *
 * The following methods still throw with a labelled
 * "not-yet-implemented-in-2b-ii" message and a rollback recipe:
 *
 *   - `start` — requires lifting CM's `buildPromptContext` +
 *     `prepareSpawnFiles` orchestration + inbox-drain payload
 *     composition into shared helpers (slice 4c).
 *
 * Daemon mode remains opt-in via `SILVERHAND_RUNTIME_HOST=daemon`; the
 * default (unset / `legacy`) still resolves to the in-process
 * `ConversationManager`. The boot dispatch in `index.ts` does NOT yet
 * wire callers through `DaemonAgentRuntimeHost` for the
 * not-yet-implemented surface — calls that reach those throws are an
 * explicit operator opt-in to an unfinished mode.
 *
 * # Why throws, not no-ops (preserved from 2a)
 *
 * Cindy `0G5uJBydO_4qt_2r`: "daemon mode 对这类未覆盖场景 fail
 * loudly / 明确保留 pending，不能假装 delivered、也不能改变
 * markDelivered 时点." A silent no-op here would silently lose
 * messages / orphan UI state when an operator switches to daemon mode
 * prematurely. A loud throw with the exact rollback command surfaces
 * the misconfiguration immediately.
 */
import type {
  AgentRunState,
  AgentRunTerminalReason,
} from '@silverhand/shared';
import { systemSubtype } from '@silverhand/shared';
import type { HostClient } from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type { Database } from 'better-sqlite3';
import type { BackendLogger } from '../context.js';
import type {
  ClearSessionResult,
  StartOptions,
} from '../conversation-manager.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { SettingsRepo } from '../repos/settings-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { AgentRuntimeHost } from './agent-runtime-host.js';
import type { RuntimeBridge } from './bridge.js';
import type { RuntimeDeliveryCoordinator } from './delivery-coordinator.js';
import type { RuntimeEventHandler } from './event-handler.js';
import type { EventPublisher } from './event-handler.js';
import type { RunStateCache } from './run-state-cache.js';
import { SILVERHAND_RUNTIME_HOST_ENV } from './runtime-host-mode.js';
import {
  formatLiveMessage,
  sendMessageToolName,
} from './stdin-format.js';

/**
 * Dependencies for the daemon-mode runtime host.
 *
 * - `client` / `bridge` / `cache` / `eventHandler` were already in 2a;
 *   they remain the four-module triad the daemon path delegates to.
 * - `events` is the SSE publisher backend already plumbs through the
 *   `BackendContext`. Used by `resolveRun` /
 *   `resolveConversationRuns` to broadcast `agent_activity` after the
 *   cache transitions the run to its terminal snapshot. Also used by
 *   `reconcileOnBoot` to publish `agent_status` for stale rows it
 *   clears, so renderers don't show "active" badges on dead agents.
 * - `conversations` is the DB repo used by `reconcileOnBoot` to find
 *   stale `starting`/`active` rows and flip them to `idle`.
 * - `logger` is used by `reconcileOnBoot` (and future slices) for
 *   structured boot-time diagnostics — kept narrow so test fixtures
 *   can pass a no-op stub.
 *
 * Kept narrow — DaemonHost is intentionally thin (Cindy
 * `5Yrv3roymWkCPxo1` watchlist point 1) — only the deps actually
 * needed by methods landed in this slice appear here. Subsequent
 * slices will widen this with the inbox repo / agent repo / settings
 * needed for `clearSession`, `start`, and `deliverMessage`.
 */
export interface DaemonAgentRuntimeHostDeps {
  client: HostClient;
  bridge: RuntimeBridge;
  cache: RunStateCache;
  eventHandler: RuntimeEventHandler;
  events: EventPublisher;
  conversations: ConversationRepo;
  agents: AgentRepo;
  messages: MessageRepo;
  /** Inbox repo used by `deliverMessage` (`ensureDelivery` on entry).
   *  Coordinator owns `markDelivered` timing — backend never marks
   *  rows delivered outside the wake path (Cindy `0G5uJBydO_4qt_2r`). */
  inboxes: ConversationInboxRepo;
  /** User repo + settings repo used by `formatLiveMessage` to
   *  resolve sender / default-viewer mention handles. Both reads
   *  happen per-delivery; we don't cache because handle changes
   *  (rename) MUST be reflected on the next message without restart. */
  users: UserRepo;
  settings: SettingsRepo;
  /** Live-delivery decision module. DaemonHost only constructs the
   *  encoded payload + driver capability snapshot and hands them
   *  through; coordinator owns wake-vs-queue-vs-respawn routing +
   *  inbox-ack timing. */
  coordinator: RuntimeDeliveryCoordinator;
  /** Used by `clearSession` to wrap the row-update + audit insert in
   *  a single sqlite transaction (matches CM behavior). */
  db: Database;
  logger: BackendLogger;
}

/**
 * Standard error message body for methods that remain
 * not-yet-implemented in this sub-commit. Centralised so the rollback
 * recipe phrasing cannot drift between methods.
 */
function notImplemented(method: string): Error {
  return new Error(
    `${SILVERHAND_RUNTIME_HOST_ENV}=daemon: ${method}() is not yet implemented in sub-commit 2b-ii (slices 1-4b cover read methods + stop + bulk shutdown + reconcileOnBoot + clearSession + deliverMessage; start lands in slice 4c). ` +
      `To roll back, restart with ${SILVERHAND_RUNTIME_HOST_ENV}=legacy (or unset the variable). ` +
      `The legacy in-process ConversationManager path remains the canonical, fully-supported runtime.`,
  );
}

/**
 * Daemon-mode runtime host. See file docstring for the per-method
 * implementation status in this sub-commit.
 */
export class DaemonAgentRuntimeHost implements AgentRuntimeHost {
  // `client` is not yet read by any landed method but stays on the dep
  // object so future slices land as a body-only change rather than a
  // signature change. Everything else is actively used.
  private readonly bridge: RuntimeBridge;
  private readonly cache: RunStateCache;
  private readonly events: EventPublisher;
  private readonly eventHandler: RuntimeEventHandler;
  private readonly conversations: ConversationRepo;
  private readonly agents: AgentRepo;
  private readonly messages: MessageRepo;
  private readonly inboxes: ConversationInboxRepo;
  private readonly users: UserRepo;
  private readonly settings: SettingsRepo;
  private readonly coordinator: RuntimeDeliveryCoordinator;
  private readonly db: Database;
  private readonly logger: BackendLogger;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _client: HostClient;

  constructor(deps: DaemonAgentRuntimeHostDeps) {
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.events = deps.events;
    this.eventHandler = deps.eventHandler;
    this.conversations = deps.conversations;
    this.agents = deps.agents;
    this.messages = deps.messages;
    this.inboxes = deps.inboxes;
    this.users = deps.users;
    this.settings = deps.settings;
    this.coordinator = deps.coordinator;
    this.db = deps.db;
    this.logger = deps.logger;
    this._client = deps.client;
  }

  // ── lifecycle ───────────────────────────────────────────────────
  async start(
    _conversationId: string,
    _agentId: string,
    _opts?: StartOptions,
  ): Promise<void> {
    throw notImplemented('start');
  }

  /**
   * Stop a runtime via the daemon.
   *
   * - **Hard** (`mode='hard'`, default): ship `runtime_stop({mode:'hard'})`
   *   to the daemon; daemon does its SIGTERM→SIGKILL cascade and emits
   *   the trailing `runtime_exit` event. Backend does NOT touch the
   *   cache here — `RuntimeEventHandler` will apply `applyRuntimeExit`
   *   when the event lands.
   * - **Soft** (`mode='soft'`): compose the directive stream-json line
   *   via the agent's driver, ship it inside
   *   `runtime_stop({mode:'soft', soft_directive: line})`. Daemon
   *   writes the bytes to the child's stdin. Default directive matches
   *   CM's wording ("user requested a course correction…"). If the
   *   driver returns `null` from `encodeStdinMessage` (oneShot drivers
   *   that don't accept stdin) we throw — there's no meaningful soft
   *   semantics for those.
   *
   * Daemon's soft result carries `directive_delivered` + an optional
   * `reason`. Failure (`directive_delivered=false`) is logged but does
   * NOT throw — CM's soft path is best-effort; a write_failed /
   * driver_refused / not_running leaves DB+SSE state untouched
   * (`stop` doesn't return that info to callers anyway).
   *
   * Result is `void` to match the legacy `AgentRuntimeHost.stop`
   * contract — callers never received a typed stopped/exit_code.
   */
  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    softDirective?: string,
  ): Promise<void> {
    if (mode === 'hard') {
      await this.bridge.runtimeStop({
        conversation_id: conversationId,
        agent_id: agentId,
        mode: 'hard',
      });
      return;
    }
    // soft
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const sa = this.conversations.getAgent(conversationId, agentId);
    const driver = getDriver(agent.runtime);
    const directive =
      softDirective ??
      '[user requested a course correction — pause your current direction and ' +
        'wait for the next instruction]';
    const line = driver.encodeStdinMessage(directive, sa?.cli_session_id ?? null);
    if (line === null) {
      throw new Error(
        `agent ${agentId} runtime '${agent.runtime}' does not accept stdin soft directives ` +
          `(driver.encodeStdinMessage returned null). Use hard stop or skip the soft path.`,
      );
    }
    const result = await this.bridge.runtimeStop({
      conversation_id: conversationId,
      agent_id: agentId,
      mode: 'soft',
      soft_directive: line,
    });
    if (result.mode === 'soft' && !result.directive_delivered) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conv_id: conversationId,
          agent_id: agentId,
          reason: result.reason,
        },
        'soft stop directive not delivered',
      );
    }
  }

  /**
   * Clear the per-(conv, agent) CLI session (Cindy `5Yrv3roymWkCPxo1`
   * watchlist item 2: **clearRuntimeSession before DB**).
   *
   * Order:
   *
   *   1. Validate conversation + agent + conversation_agent membership
   *      exist. Throws synchronously on missing entities — same shape as
   *      CM's `clearSessionUnlocked` validation.
   *   2. Snapshot `prevCliSessionId` + `wasRunning` BEFORE we mutate
   *      anything. `wasRunning` is derived from the daemon cache (was
   *      there a non-exited phase entry for this pair?), NOT from the
   *      bridge result — the bridge `{cleared}` flag answers "did
   *      daemon actually tear something down?", which is a subtly
   *      different question (false when nothing was live to tear down,
   *      true otherwise).
   *   3. Call `bridge.clearRuntimeSession(conv, agent)`. Cindy
   *      `BYHZJI9ALSVmmlFr`: transport / `internal_error` rejections
   *      MUST propagate without touching DB — daemon ack failure means
   *      runtime side may still be alive, and clearing DB would
   *      desync the two. `{cleared:true}` AND `{cleared:false}` are
   *      both treated as "daemon-side cleared; proceed to DB" (false
   *      simply means "nothing was running to clear").
   *   4. DB tx: clear `cli_session_id` on `conversation_agents` +
   *      insert the session-cleared audit message atomically. Then
   *      publish `agent_status` SSE (so renderers drop the prior
   *      session badge) and `message` SSE (so the audit appears in
   *      chat).
   *
   * Per-agent delivery of the audit (CM does `deliverMessage` for
   * every other agent in the conversation so they see the system
   * message immediately) is DEFERRED to slice 4 — it requires
   * `deliverMessage`, which lifts CM's spawn-prep + format-inbox
   * helpers. For now the audit lands on the SSE bus and in the
   * messages table; agents will pick it up on their next wake.
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

    // 2. Snapshot pre-state.
    const prevCliSessionId = existing.cli_session_id;
    const cacheEntry = this.cache.get(conversationId, agentId);
    const wasRunning =
      cacheEntry !== undefined && cacheEntry.phase !== 'exited';

    // 3. Bridge first. Transport / internal_error rejections propagate
    //    and leave DB untouched (Cindy `BYHZJI9ALSVmmlFr`). Both arms
    //    of the daemon result continue to step 4.
    await this.bridge.clearRuntimeSession(conversationId, agentId);

    // 4. DB tx + audit + SSE.
    const shouldAudit = wasRunning || prevCliSessionId !== null;
    const { updated, auditMessage } = this.db.transaction(() => {
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

    this.events.publish(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: updated.status,
        pid: updated.pid,
        cli_session_id: null,
      },
    });
    if (auditMessage) {
      this.events.publish(conversationId, {
        kind: 'message',
        payload: { message: auditMessage },
      });
      // TODO(2b-ii slice 4): once `deliverMessage` is implemented,
      // wake every other agent in the conversation with the audit
      // message (mirror CM `publishAndDeliverSessionClearedAudit`).
      // Until then the audit shows in chat + lands in the messages
      // table, but other agents only see it on their next wake.
    }

    return { prevCliSessionId, wasRunning };
  }

  /**
   * Mirrors CM `insertSessionClearedAuditMessage` (line 1183-1214) so
   * the audit row shape (content text, metadata.subtype, the prefix
   * truncation) stays byte-identical between legacy and daemon paths.
   * Lifted inline here rather than shared because CM is being removed
   * after the cutover (commit 5+).
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

  /**
   * Stop every runtime the daemon tracks. Used on backend shutdown so
   * daemon doesn't keep orphan children running after backend exits.
   * Always hard mode (graceful shutdown is the user's job, not ours).
   */
  async stopAll(): Promise<void> {
    await this.bridge.runtimeStopAll();
  }

  /**
   * Ask daemon to flush + close its activity log file. Backend's own
   * JSONL stream for activity events lives in `ConversationManager`
   * (the legacy path); in daemon mode the daemon owns the activity
   * log file, so backend just relays the close intent.
   *
   * Safe to call when daemon hasn't opened one — daemon's intent
   * handler treats it as a no-op in that case.
   */
  async closeActivityLog(): Promise<void> {
    await this.bridge.runtimeCloseActivityLog();
  }

  // ── delivery ────────────────────────────────────────────────────
  /**
   * Hand a message to the (conv, agent) runtime.
   *
   * Daemon-mode flow (Cindy `5Yrv3roymWkCPxo1` watchlist items 1+4):
   *
   *   1. Validate the message exists. Missing → log warn + return.
   *      We deliberately do NOT throw here — CM doesn't throw on
   *      this path and a missing message is a benign "row deleted
   *      between produce and consume" race.
   *
   *   2. `ensureDelivery` on the inbox repo. This is the only DB write
   *      DaemonHost performs in the delivery path; it's idempotent
   *      (returns an existing row or creates one). If the row is
   *      already marked delivered, log + return.
   *
   *   3. Look up agent + driver. Missing agent → log warn + return.
   *
   *   4. If the cache has NO entry for (conv, agent) → agent is not
   *      running. The ensureDelivery row stays pending and will be
   *      drained on next start via `startup_delivery`. For oneShot
   *      drivers (cursor), fire `this.start(...)` to trigger that
   *      spawn — Cindy `5Yrv3roymWkCPxo1` #4: oneShot respawn ONLY
   *      goes through start+startup_delivery, NEVER via direct wake.
   *      Errors are caught + logged (best-effort; the row remains
   *      pending so the next manual start still picks it up).
   *
   *   5. Format the live-message stream-json payload via the shared
   *      `formatLiveMessage` helper (byte-identical to CM).
   *
   *   6. Encode the line via the driver. If the driver returns null
   *      (oneShot drivers like cursor that don't accept stdin), log
   *      and return — coordinator's "noop_oneshot_live" path would
   *      reach the same outcome but we short-circuit on the encoding
   *      failure to avoid sending a no-op request through the wire.
   *
   *   7. Submit to the coordinator with the driver capability snapshot.
   *      Coordinator owns:
   *         - busy-aware queue / flush (gated drivers mid-turn)
   *         - bridge.runtimeWake dispatch
   *         - `markDelivered` timing (ONLY on `{delivered:true}` ack)
   *      Decision is returned for logging but is informational; the
   *      inbox is the source of truth for retry.
   */
  async deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void> {
    const msg = this.messages.getById(messageId);
    if (!msg) {
      this.logger.warn(
        { kind: 'runtime', mode: 'daemon', conv_id: conversationId, agent_id: agentId, msg_id: messageId },
        'deliver: messageId not found in messages table',
      );
      return;
    }

    const delivery = this.inboxes.ensureDelivery(
      conversationId,
      agentId,
      messageId,
    );
    if (delivery.deliveredAt !== null) {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conv_id: conversationId,
          agent_id: agentId,
          msg_id: messageId,
          inbox_id: delivery.inboxId,
        },
        'deliver: message already delivered to agent; skipping',
      );
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conv_id: conversationId,
          agent_id: agentId,
          msg_id: messageId,
          inbox_id: delivery.inboxId,
        },
        'deliver: agent not found in agents table; row left pending',
      );
      return;
    }
    const driver = getDriver(agent.runtime);

    const cacheEntry = this.cache.get(conversationId, agentId);
    if (!cacheEntry) {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conv_id: conversationId,
          agent_id: agentId,
          msg_id: messageId,
          inbox_id: delivery.inboxId,
          one_shot: driver.oneShot,
        },
        'deliver: agent not running, enqueued to inbox',
      );
      if (driver.oneShot) {
        // Auto-start so the spawn-time `startup_delivery` drains the
        // row we just queued. start() is idempotent and best-effort
        // here; if it fails the row stays pending for the next
        // manual start. NOTE: in 2b-ii slice 4b, start() still throws
        // (slice 4c). The catch swallows the throw so the inbox row
        // is not corrupted — operator sees the error in the agent log
        // and retries explicitly.
        this.start(conversationId, agentId).catch(err =>
          this.logger.error(
            {
              kind: 'runtime',
              mode: 'daemon',
              conv_id: conversationId,
              agent_id: agentId,
              err: err instanceof Error ? err.message : String(err),
            },
            'oneShot: auto-start on deliverMessage failed; row stays pending',
          ),
        );
      }
      return;
    }

    const text = formatLiveMessage(
      msg,
      id => this.agents.get(id)?.name,
      id => this.users.get(id)?.name,
      this.resolveDefaultUserHandle(),
      agent.name,
      sendMessageToolName(driver),
    );
    const sa = this.conversations.getAgent(conversationId, agentId);
    const line = driver.encodeStdinMessage(text, sa?.cli_session_id ?? null);
    if (line === null) {
      // Driver doesn't accept stdin (e.g. cursor's oneShot path).
      // The coordinator's `noop_oneshot_live` arm would reach the
      // same conclusion but we short-circuit because there's no
      // payload to dispatch.
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conv_id: conversationId,
          agent_id: agentId,
          msg_id: messageId,
          inbox_id: delivery.inboxId,
        },
        'deliver: driver did not produce a stdin payload; row stays pending for next respawn',
      );
      return;
    }

    const decision = await this.coordinator.submitLiveDelivery(
      conversationId,
      agentId,
      {
        inboxId: delivery.inboxId,
        messageId,
        payload: line,
        driver: {
          oneShot: driver.oneShot,
          busyDeliveryMode: driver.busyDeliveryMode,
        },
      },
    );
    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        conv_id: conversationId,
        agent_id: agentId,
        msg_id: messageId,
        inbox_id: delivery.inboxId,
        decision: decision.kind,
      },
      'deliver: coordinator decision',
    );
  }

  /** Resolve the registered viewer's mention handle (used as the
   *  fallback `sender=` when a user message has a null
   *  `from_user_id`). Returns undefined when registration hasn't
   *  completed yet — formatters degrade to the bare token `user`.
   *  Mirrors CM `resolveDefaultUserHandle`. */
  private resolveDefaultUserHandle(): string | undefined {
    const viewerId = this.settings.getViewerUserId();
    if (!viewerId) return undefined;
    return this.users.get(viewerId)?.name ?? undefined;
  }

  // ── boot recovery ───────────────────────────────────────────────
  /**
   * Daemon-mode boot recovery (Cindy `5Yrv3roymWkCPxo1` watchlist
   * item 3: snapshot-aware).
   *
   * Two phases:
   *
   *   1. **Start the event subscription** via
   *      `RuntimeEventHandler.start()`. This subscribes to daemon
   *      events AND performs the initial `runtime_status` hydrate, so
   *      by the time `start()` resolves the cache holds the daemon's
   *      authoritative snapshot of every live runtime. `start()` is
   *      idempotent (no-op after the first call) so multi-call from
   *      tests is safe.
   *
   *   2. **Diff DB against snapshot.** For each
   *      `conversation_agents` row in `starting` or `active`, if the
   *      (conv, agent) pair is in the daemon snapshot, leave it alone
   *      — daemon owns that runtime. If it's NOT in the snapshot,
   *      treat it as stale: flip to `idle`, clear `pid`, KEEP
   *      `cli_session_id` so the next start uses `--resume`. Mirrors
   *      legacy CM's recovery contract (line 484-543 of
   *      conversation-manager.ts) except we never SIGKILL — daemon
   *      owns the child processes in this mode, not us.
   *
   * Safety: if hydrate failed, `cache.daemonInstanceKey` is `null`. In
   * that case we DO NOT clear any DB rows — daemon may be alive but
   * temporarily unreachable, and clearing rows here would force
   * spurious `idle` SSEs and lose the live status the next hydrate
   * would have surfaced. We log a warning instead; the next reconnect
   * (driven by `HostClient.onReconnect`) will re-trigger hydrate and
   * a manual `reconcileOnBoot` call from a follow-up boot pass can
   * re-diff.
   */
  async reconcileOnBoot(): Promise<void> {
    await this.eventHandler.start();

    if (this.cache.daemonInstanceKey === null) {
      this.logger.warn(
        { kind: 'runtime', mode: 'daemon' },
        'reconcile: daemon snapshot unavailable (hydrate failed); skipping DB diff to avoid clearing live rows',
      );
      return;
    }

    // Build the snapshot key set ONCE so the diff is O(rows) not
    // O(rows × snapshot).
    const snapshotKeys = new Set<string>();
    for (const entry of this.cache.list()) {
      snapshotKeys.add(`${entry.conversationId}|${entry.agentId}`);
    }

    const stale = this.conversations.listLiveStatusAgents();
    if (stale.length === 0) {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          snapshot_count: snapshotKeys.size,
          db_live_count: 0,
        },
        'reconcile: no live DB rows to diff',
      );
      return;
    }

    let cleared = 0;
    for (const sa of stale) {
      const key = `${sa.conversation_id}|${sa.agent_id}`;
      if (snapshotKeys.has(key)) continue; // daemon owns it — leave alone
      this.conversations.updateAgentRuntime(sa.conversation_id, sa.agent_id, {
        status: 'idle',
        pid: null,
      });
      // Publish so the renderer drops the stale spinner immediately
      // without waiting for the next snapshot push.
      this.events.publish(sa.conversation_id, {
        kind: 'agent_status',
        payload: {
          agent_id: sa.agent_id,
          status: 'idle',
          pid: null,
          reason: 'reconcile_stale',
        },
      });
      cleared += 1;
    }
    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        snapshot_count: snapshotKeys.size,
        db_live_count: stale.length,
        cleared,
      },
      'reconcile: cleared stale conversation_agents not present in daemon snapshot',
    );
  }

  // ── run-state surface ───────────────────────────────────────────
  /**
   * Project every cache entry whose `conversationId` matches into the
   * `AgentRunState[]` shape the legacy CM returned. Entries without an
   * active `runState` are omitted (matching CM's behavior — it only
   * surfaces agents with a live `AgentRunState`).
   *
   * Ordering: insertion order of the underlying cache map. Callers
   * (SSE consumers, the conversation-snapshot route) treat the result
   * as an unordered set; we don't impose a sort.
   */
  getAgentRunStates(conversationId: string): AgentRunState[] {
    const out: AgentRunState[] = [];
    for (const entry of this.cache.list()) {
      if (entry.conversationId !== conversationId) continue;
      if (entry.runState) out.push(entry.runState);
    }
    return out;
  }

  /**
   * Resolve the active run for (conv, agent). Delegates the snapshot
   * transition to `RunStateCache.resolveRun` (which clears the
   * `runState` field and projects the terminal status/reason), then
   * broadcasts the terminal `agent_activity` SSE so renderers can
   * collapse the spinner.
   *
   * No-op when there is no active run for the pair or when
   * `expectedRunId` is supplied and disagrees — cache returns `null`
   * and we publish nothing. Matches CM's `resolveRun` idempotency
   * contract.
   *
   * Returns `void` to satisfy the `AgentRuntimeHost.resolveRun`
   * signature; callers that want the terminal snapshot read it from
   * the SSE bus (same as legacy).
   */
  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void {
    const terminal = this.cache.resolveRun(
      conversationId,
      agentId,
      reason,
      runId,
    );
    if (!terminal) return;
    this.events.publish(conversationId, {
      kind: 'agent_activity',
      payload: terminal,
    });
  }

  /**
   * Resolve every (conv, *) entry with an active run. Used when a
   * conversation closes — we want to flush spinners for every agent
   * in the conversation, not just one. Default reason is
   * `'conversation_closed'` to match CM's default; callers can
   * override (e.g. the daemon-shutdown path uses something else).
   *
   * Implementation: cache returns the array of terminal snapshots
   * with `runState` already cleared; we just publish each one.
   */
  resolveConversationRuns(
    conversationId: string,
    reason: AgentRunTerminalReason = 'conversation_closed',
  ): void {
    const terminals = this.cache.resolveConversationRuns(conversationId, reason);
    for (const terminal of terminals) {
      this.events.publish(conversationId, {
        kind: 'agent_activity',
        payload: terminal,
      });
    }
  }
}
