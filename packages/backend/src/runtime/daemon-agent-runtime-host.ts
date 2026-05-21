/**
 * `DaemonAgentRuntimeHost` — daemon-mode implementation of
 * `AgentRuntimeHost`.
 *
 * # Scope of this sub-commit (2b-ii first slice)
 *
 * The lifecycle / delivery surface is being filled in across multiple
 * sub-commits. This file currently implements:
 *
 *   - **Read methods** — `getAgentRunStates`, `resolveRun`,
 *     `resolveConversationRuns` — backed by `RunStateCache` + an
 *     `EventPublisher` for the SSE side of `resolveRun`.
 *   - **Hard stop** — `stop(_, _, 'hard', ...)` delegates to
 *     `RuntimeBridge.runtimeStop({ mode: 'hard' })`.
 *   - **Bulk shutdown** — `stopAll` → `bridge.runtimeStopAll`;
 *     `closeActivityLog` → `bridge.runtimeCloseActivityLog`.
 *
 * The following methods still throw with a labelled
 * "not-yet-implemented-in-2b-ii" message and a rollback recipe:
 *
 *   - `start`, `deliverMessage` — require lifting CM's spawn-prep /
 *     `formatLiveMessage` / `drainInbox` into shared helpers.
 *   - `clearSession` — requires the shared session-cleared audit
 *     message + delivery path (depends on `deliverMessage`).
 *   - `reconcileOnBoot` — requires daemon `runtime_status` hydrate
 *     plus the DB diff helper.
 *   - `stop` with `mode === 'soft'` — requires the soft-directive
 *     stream-json payload composition.
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
import type { HostClient } from '@silverhand/host';
import type {
  ClearSessionResult,
  StartOptions,
} from '../conversation-manager.js';
import type { AgentRuntimeHost } from './agent-runtime-host.js';
import type { RuntimeBridge } from './bridge.js';
import type { RuntimeEventHandler } from './event-handler.js';
import type { EventPublisher } from './event-handler.js';
import type { RunStateCache } from './run-state-cache.js';
import { SILVERHAND_RUNTIME_HOST_ENV } from './runtime-host-mode.js';

/**
 * Dependencies for the daemon-mode runtime host.
 *
 * - `client` / `bridge` / `cache` / `eventHandler` were already in 2a;
 *   they remain the four-module triad the daemon path delegates to.
 * - `events` is the SSE publisher backend already plumbs through the
 *   `BackendContext`. It is used by `resolveRun` /
 *   `resolveConversationRuns` to broadcast `agent_activity` after the
 *   cache transitions the run to its terminal snapshot.
 *
 * Kept narrow — DaemonHost is intentionally thin (Cindy
 * `5Yrv3roymWkCPxo1` watchlist point 1) — only the deps actually
 * needed by methods landed in this slice appear here. Sub-2b-iii will
 * widen this to add the DB / inbox / agent / settings repos needed
 * for `clearSession`, `reconcileOnBoot`, `start`, and `deliverMessage`.
 */
export interface DaemonAgentRuntimeHostDeps {
  client: HostClient;
  bridge: RuntimeBridge;
  cache: RunStateCache;
  eventHandler: RuntimeEventHandler;
  events: EventPublisher;
}

/**
 * Standard error message body for methods that remain
 * not-yet-implemented in this sub-commit. Centralised so the rollback
 * recipe phrasing cannot drift between methods.
 */
function notImplemented(method: string): Error {
  return new Error(
    `${SILVERHAND_RUNTIME_HOST_ENV}=daemon: ${method}() is not yet implemented in sub-commit 2b-ii (this slice covers read methods + hard stop + stopAll + closeActivityLog only). ` +
      `To roll back, restart with ${SILVERHAND_RUNTIME_HOST_ENV}=legacy (or unset the variable). ` +
      `The legacy in-process ConversationManager path remains the canonical, fully-supported runtime.`,
  );
}

/**
 * Daemon-mode runtime host. See file docstring for the per-method
 * implementation status in this sub-commit.
 */
export class DaemonAgentRuntimeHost implements AgentRuntimeHost {
  // `client` and `eventHandler` are not yet read by any landed method
  // but stay on the dep object so 2b-iii lands as a body-only change
  // rather than a signature change. `bridge`, `cache`, and `events`
  // are actively used below.
  private readonly bridge: RuntimeBridge;
  private readonly cache: RunStateCache;
  private readonly events: EventPublisher;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _client: HostClient;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private readonly _eventHandler: RuntimeEventHandler;

  constructor(deps: DaemonAgentRuntimeHostDeps) {
    this.bridge = deps.bridge;
    this.cache = deps.cache;
    this.events = deps.events;
    this._client = deps.client;
    this._eventHandler = deps.eventHandler;
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
   * Stop a runtime via the daemon. Hard mode is implemented;
   * `'soft'` is deferred to sub-2b-iii because it requires composing
   * the directive stream-json payload (driver-specific, depends on
   * `cli_session_id` for codex).
   *
   * Hard-mode behavior: ship `runtime_stop({mode:'hard'})` to the
   * daemon; daemon does its SIGTERM→SIGKILL cascade and emits the
   * trailing `runtime_exit` event. Backend does NOT touch the cache
   * here — the `RuntimeEventHandler` will apply `applyRuntimeExit`
   * when the event lands, and the corresponding SSE `agent_status`
   * publish is driven by that event-handler path, not by this stop
   * call. Result is intentionally void: per the
   * `AgentRuntimeHost.stop` contract the daemon path is fire-and-await;
   * callers don't get a typed `stopped`/`exit_code` because legacy CM
   * never returned one either.
   */
  async stop(
    conversationId: string,
    agentId: string,
    mode: 'soft' | 'hard' = 'hard',
    _softDirective?: string,
  ): Promise<void> {
    if (mode === 'soft') {
      throw notImplemented('stop(mode=soft)');
    }
    await this.bridge.runtimeStop({
      conversation_id: conversationId,
      agent_id: agentId,
      mode: 'hard',
    });
  }

  async clearSession(
    _conversationId: string,
    _agentId: string,
    _actorUserId?: string | null,
  ): Promise<ClearSessionResult> {
    throw notImplemented('clearSession');
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
  async deliverMessage(
    _conversationId: string,
    _agentId: string,
    _messageId: string,
  ): Promise<void> {
    throw notImplemented('deliverMessage');
  }

  // ── boot recovery ───────────────────────────────────────────────
  async reconcileOnBoot(): Promise<void> {
    throw notImplemented('reconcileOnBoot');
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
