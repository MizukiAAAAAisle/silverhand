/**
 * `RuntimeStatusProjector` — sink for the runtime status events
 * that mutate the scoped runtime-slot projection AND
 * publish the matching `agent_status` SSE.
 *
 * ## Why a sink (Cindy `usjxj8AxX4AvJ5E-` B1 refinement)
 *
 * Before this sink existed, `RuntimeEventHandler` projected SSE for
 * `session_init` / `runtime_exit` / `runtime_init_retrying` /
 * `runtime_init_cooldown` but never wrote `conversation_agents` — the
 * DB row stayed stuck in whatever status the spawn-time write left
 * behind. CM owned both halves (DB + SSE) inline; under daemon mode
 * the DB half was simply missing.
 *
 * The naive fix is to inject `ConversationRepo` into `EventHandler`
 * and do the writes there. The refinement is **don't**: keep the
 * EventHandler as event-fan-out, and put the DB + SSE pair behind a
 * narrow sink that owns the status mapping in ONE place. This means:
 *
 *   - `EventHandler` hands the sink the raw event data (intentional,
 *     code, gating flags), NOT a pre-computed `status` string. The
 *     sink decides `idle` vs `crashed` (and `active` / `starting` etc.).
 *   - Tests for the sink can pin "this combination of inputs produces
 *     exactly this DB row + exactly this SSE" without involving an
 *     event handler at all.
 *   - Tests for the EventHandler can stub the sink and verify the
 *     fan-out reached the right method with the right inputs — they
 *     do NOT need a real DB.
 *
 * ## Idempotence
 *
 * All methods are idempotent at the DB layer (re-applying the
 * same runtime-slot projection is a no-op write) and at the SSE
 * layer (a re-broadcast of an identical `agent_status` payload is a
 * benign duplicate for the renderer). `session_init` in particular
 * fires at the start of every claude turn (`system.init` is per-turn,
 * not per-process — invariant inherited from the original
 * ConversationManager runtime); the sink does NOT dedup. Dedup of
 * side effects that ARE non-idempotent (marking init-pending inbox
 * rows delivered, calling drainInbox) is owned by the coordinator
 * (B3), not by this sink.
 */
import type { AgentRunState } from '@silverhand/shared';
import type { RuntimeSlotRepo } from '../repos/runtime-slot-repo.js';
import type { EventPublisher } from './event-handler.js';

export type InitTimeoutReason =
  | 'silence'
  | 'pre_protocol_cap'
  | 'post_protocol';

export interface SessionInitProjection {
  conversationId: string;
  agentId: string;
  cliSessionId: string;
}

export interface RuntimeReadyProjection {
  conversationId: string;
  agentId: string;
}

export interface RuntimeExitProjection {
  conversationId: string;
  agentId: string;
  intentional: boolean;
  code: number | null;
  initTimedOut: boolean;
  fatalError: boolean;
  clearCliSessionId?: boolean;
  runState: AgentRunState | null;
}

export interface InitRetryingProjection {
  conversationId: string;
  agentId: string;
  retryAttempt: number;
  maxRetries: number;
  timeoutReason: InitTimeoutReason | undefined;
}

export interface InitCooldownProjection {
  conversationId: string;
  agentId: string;
  cooldownUntil: number;
  attemptsExhausted: number;
}

export interface RuntimeStatusProjector {
  sessionInit(input: SessionInitProjection): void;
  runtimeReady(input: RuntimeReadyProjection): void;
  runtimeExit(input: RuntimeExitProjection): void;
  initRetrying(input: InitRetryingProjection): void;
  initCooldown(input: InitCooldownProjection): void;
}

/**
 * Production projector: writes `agent_runtime_slots` via
 * `RuntimeSlotRepo` AND publishes `agent_status` SSE via the shared
 * `EventPublisher`. Status mapping (idle/crashed/active/starting) lives
 * here so EventHandler's branches don't carry status logic.
 */
export class DbRuntimeStatusProjector implements RuntimeStatusProjector {
  constructor(
    private readonly runtimeSlots: RuntimeSlotRepo,
    private readonly events: EventPublisher,
  ) {}

  /**
   * Claude's `system.init` arrives at the start of every turn. CM
   * dedupes via `handle.initObserved` because the *side effects*
   * (mark init-pending inbox, drainInbox) are non-idempotent. The
   * DB write here is `status='active', cli_session_id=<id>` — both
   * idempotent. We re-apply on every call; the coordinator owns the
   * dedup of the non-idempotent steps (B3).
   */
  sessionInit({
    conversationId,
    agentId,
    cliSessionId,
  }: SessionInitProjection): void {
    this.runtimeSlots.updateCurrentConversationProjection(conversationId, agentId, {
      status: 'active',
      cliSessionId,
    });
    this.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'active',
        cli_session_id: cliSessionId,
      },
    });
  }

  /**
   * `runtime_ready_for_drain` is the daemon-side signal that the
   * child process is live and can receive stdin. Claude can withhold
   * `session_init` until the first real user message, so restart with
   * an empty inbox must not leave UI presence stuck on "Connecting".
   *
   * This deliberately preserves `cli_session_id`; `sessionInit()` will
   * fill/refresh it once the driver emits a real session id.
   */
  runtimeReady({ conversationId, agentId }: RuntimeReadyProjection): void {
    this.runtimeSlots.updateCurrentConversationProjection(conversationId, agentId, {
      status: 'active',
    });
    this.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'active',
      },
    });
  }

  /**
   * Status mapping (preserved verbatim from the original
   * ConversationManager runtime so the wire-to-DB enum stays stable
   * across the daemon cutover):
   *   initTimedOut || fatalError       -> 'crashed'
   *   intentional || code === 0        -> 'idle'
   *   otherwise                        -> 'crashed'
   *
   * `ConversationAgentStatusSchema` allows only
   * `idle|starting|active|crashed`; mapping the wire to the right
   * enum value here (rather than in the handler) means future status
   * adjustments don't have to grep every event branch.
   *
   * `pid` is always cleared on exit. `cli_session_id` is normally
   * preserved — the DB keeps the last session id so the next start
   * can `--resume` (Cindy `BYHZJI9ALSVmmlFr`). The only exception is
   * a driver-proven stale resume target (`thread_not_found`,
   * `session_archived`): preserving that id would make every future
   * start fail against the same invalid lower-level session.
   */
  runtimeExit({
    conversationId,
    agentId,
    intentional,
    code,
    initTimedOut,
    fatalError,
    clearCliSessionId,
    runState,
  }: RuntimeExitProjection): void {
    const status: 'idle' | 'crashed' =
      initTimedOut || fatalError
        ? 'crashed'
        : intentional || code === 0
          ? 'idle'
          : 'crashed';
    this.runtimeSlots.updateCurrentConversationProjection(conversationId, agentId, {
      status,
      pid: null,
      claimedByDaemonInstanceId: null,
      ...(clearCliSessionId ? { cliSessionId: null } : {}),
    });
    this.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status,
        exit_code: code,
        intentional,
        run_state: runState,
        ...(clearCliSessionId ? { cli_session_id: null } : {}),
      },
    });
  }

  /**
   * Inherited contract from the original ConversationManager runtime:
   * on init retry the row flips back to `starting` (pid cleared — the
   * failed child is
   * gone; the retry's new child gets a fresh pid via a later spawn),
   * and the SSE carries `reason='init_timeout_retrying'` so the
   * renderer's status patcher shows the retry attempt without
   * regressing to the pre-retry view.
   */
  initRetrying({
    conversationId,
    agentId,
    retryAttempt,
    maxRetries,
    timeoutReason,
  }: InitRetryingProjection): void {
    this.runtimeSlots.updateCurrentConversationProjection(conversationId, agentId, {
      status: 'starting',
      pid: null,
    });
    this.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'starting',
        reason: 'init_timeout_retrying',
        retry_attempt: retryAttempt,
        max_retries: maxRetries,
        ...(timeoutReason ? { timeout_reason: timeoutReason } : {}),
      },
    });
  }

  /**
   * Terminal init failure (CM `publishInitCooldown` line 2046-2064).
   * Row flips to `crashed` with `pid=null` — daemon has given up on
   * this runtime; backend won't auto-respawn (Cindy `BYHZJI9ALSVmmlFr`
   * pin c). SSE carries `reason='init_cooldown'` plus the unfreeze
   * timestamp so the renderer can show a countdown / disable manual
   * restart until cooldown lapses.
   */
  initCooldown({
    conversationId,
    agentId,
    cooldownUntil,
    attemptsExhausted,
  }: InitCooldownProjection): void {
    this.runtimeSlots.updateCurrentConversationProjection(conversationId, agentId, {
      status: 'crashed',
      pid: null,
    });
    this.events.publishSide(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'crashed',
        reason: 'init_cooldown',
        cooldown_until: cooldownUntil,
        attempts_exhausted: attemptsExhausted,
      },
    });
  }
}

/** Test-only noop sink — every call is dropped. Used by the
 *  EventHandler's existing tests that don't exercise projection. */
export const NOOP_STATUS_PROJECTOR: RuntimeStatusProjector = {
  sessionInit: () => {},
  runtimeReady: () => {},
  runtimeExit: () => {},
  initRetrying: () => {},
  initCooldown: () => {},
};
