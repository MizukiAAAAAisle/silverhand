/**
 * `AgentRuntimeHost` — the backend-side facade for agent runtime
 * lifecycle (start/stop/deliver/clear-session/inbox delivery/run-state).
 * Both embedded and standalone use `OutboundAgentRuntimeHost`, which delegates
 * to the shared outbound event fanout; the transport underneath is selected by
 * host id.
 *
 * **NOT related to workspace host identity.** The `host_id` column on
 * agents / workspaces and the `HostRepo` row identify a physical host
 * (local app-managed or user-managed). `AgentRuntimeHost` is a runtime-side
 * dispatch boundary for "who actually owns the child process" — the
 * silverhand-daemon.
 *
 * The interface mirrors the (now-removed) `ConversationManager` public
 * surface so all existing call sites (services, routes) stayed working
 * across the cutover. Cindy `bJUazoeBrxK8XglK` blocker (1):
 * "按现有 call sites 精确建模，不要发明新形状".
 */
import type {
  AgentRunState,
  AgentRunTerminalReason,
  RuntimeKind,
} from '@silverhand/shared';

/** Optional `start()` overrides. Kept thin — only fields services
 *  actually pass at call time. */
export interface StartOptions {
  /** Override the model (e.g. `sonnet-4-6`). Falls back to agent.model. */
  model?: string | null;
}

/**
 * Narrow delivery-only face of {@link AgentRuntimeHost} (#task:1990). Post-commit
 * best-effort "hand this message to the runtime" effects depend on this port,
 * not the host class — keeping ambient `BackendContext` (and its `db`) out of
 * application use cases.
 */
export interface AgentMessageDeliveryPort {
  deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void>;
}

/** Narrow start-only face of {@link AgentRuntimeHost} (#task:1990). Same reason:
 *  the "spawn the onboarding DM runtime" effect depends on this port alone. */
export interface AgentRuntimeStartPort {
  start(conversationId: string, agentId: string): Promise<void>;
}

/**
 * Optional `stop()` overrides.
 *
 * `hostId` supplies the routing authority the dispatcher would otherwise
 * re-derive from the DB (`agents.host_id` → `hosts`). A caller that stops runs
 * whose agent/host rows are ALREADY DELETED — the delete-computer cascade stops
 * after its commit, on purpose, so a refused request destroys nothing — must
 * pass the host it captured before the commit. Without it the resolve throws
 * `agent not found`, the caller's `catch` degrades it to a warning, and the stop
 * is a silent no-op that leaves the daemon's child process running (#task:1616).
 *
 * Normal callers omit it: for a live agent the DB is the authority and must stay
 * the authority.
 */
export interface StopOptions {
  hostId?: string;
}

/** Pre-clear snapshot returned by `clearSession()`. Callers use this
 *  to decide whether to publish an audit message and what to log. */
export interface ClearSessionResult {
  prevCliSessionId: string | null;
  wasRunning: boolean;
}

export interface ReapIdleRuntimesOptions {
  ttlMs: number;
  now?: number;
  runtimeEnabled?: (runtime: RuntimeKind) => boolean;
}

export interface ReapIdleRuntimesResult {
  considered: number;
  eligible: number;
  reaped: number;
  skipped: number;
  failed: number;
}

/**
 * D4.c C7 — bounded wait the standalone fanout uses while
 * `clearSession` blocks on the post-`runtime_clear_session`
 * `runtime_exit` event landing in projection.
 *
 * 10s mirrors `runtime_deliver`'s round-trip ceiling and is the
 * largest "user-explicit" interactive action we want to make a
 * caller block on. Bigger and the renderer's spinner becomes
 * indistinguishable from a hang; smaller and a healthy daemon
 * SIGKILL grace window can race the bound on a slow box. The
 * fanout exposes an injectable override so unit tests can
 * collapse the bound to a few ms without sleeping.
 */
export const CLEAR_SESSION_EXIT_TIMEOUT_MS = 10_000;

/**
 * D4.c C7 — typed error the standalone fanout throws when a
 * dispatched `runtime_clear_session` succeeded on the daemon side
 * (`{cleared:true}`) but the resulting `runtime_exit` event did not
 * land in projection within `CLEAR_SESSION_EXIT_TIMEOUT_MS`.
 *
 * Per Cindy `nPqEVJjCLjuNDH-6`: NOT in `placementErrorStatusMap` —
 * this is a route-local error code. The `clearConversationAgentSession`
 * handler maps it directly to HTTP 503 + `code: 'clear_session_timeout'`.
 *
 * On timeout the backend leaves the DB row UNCHANGED — no audit, no
 * `cli_session_id` clear — so the next `clear-session` retry picks
 * up the same pre-state and tries again cleanly.
 */
export class ClearSessionExitTimeoutError extends Error {
  readonly code = 'clear_session_timeout' as const;
  readonly conversationId: string;
  readonly agentId: string;

  constructor(conversationId: string, agentId: string) {
    super(
      `clear-session for ${conversationId}/${agentId} timed out waiting for ` +
        'runtime_exit projection landed',
    );
    this.name = 'ClearSessionExitTimeoutError';
    this.conversationId = conversationId;
    this.agentId = agentId;
  }
}

/**
 * A spawn was requested for a conversation whose PLACEMENT carries no workspace
 * (v71, agent-scoped-session-v1 §7.3 / #task:2014).
 *
 * A runtime needs a session cwd, and the cwd IS the vendor session's identity
 * (claude/codex address their session store by a hash of it), so there is
 * exactly ONE admissible answer for a workspace-less placement: the
 * deterministic agent-scoped coordinate that the agent-scoped RuntimeScope
 * introduces (#task:2019). Substituting any workspace's path in the meantime
 * would fork the agent's vendor session into a second history — silently, and
 * unrecoverably, since the DB cannot re-associate what the vendor keyed by path.
 *
 * So this fails LOUD, and the failure is a DEFERRAL rather than a loss: whatever
 * made the runtime worth waking (today: the mention CC copy) is committed with
 * its durable inbox delivery row, so the message is drained by the next spawn
 * that DOES have a scope. Callers that can honestly defer catch this and log it;
 * they must not translate it into "delivery failed".
 */
export class RuntimePlacementUnsupportedError extends Error {
  readonly code = 'runtime_placement_unsupported' as const;
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(
      `runtime start/deliver for conversation ${conversationId} has no workspace `
        + 'placement to derive a session cwd from; the agent-scoped RuntimeScope '
        + 'lands in #task:2019 — the durable inbox row is kept for the next spawn',
    );
    this.name = 'RuntimePlacementUnsupportedError';
    this.conversationId = conversationId;
  }
}

/**
 * D4.c C7 — typed error thrown when a second `clearSession` arrives
 * for the same `(conversation, agent)` pair while the first is still
 * waiting on the `runtime_exit` projection. Clear-session is a
 * user-explicit one-shot action; concurrent dispatch is misuse, not
 * a coordination hazard worth a shared-waiter implementation.
 *
 * Routed to HTTP 409 + `code: 'clear_session_in_progress'`.
 */
export class ClearSessionInProgressError extends Error {
  readonly code = 'clear_session_in_progress' as const;
  readonly conversationId: string;
  readonly agentId: string;

  constructor(conversationId: string, agentId: string) {
    super(
      `clear-session is already in progress for ${conversationId}/${agentId}`,
    );
    this.name = 'ClearSessionInProgressError';
    this.conversationId = conversationId;
    this.agentId = agentId;
  }
}

/**
 * Backend-side facade for the per-(conversation, agent) runtime
 * lifecycle.
 */
export interface AgentRuntimeHost {
  // ── lifecycle ───────────────────────────────────────────────────
  /** Spawn (or no-op if already running) the (conv, agent) runtime. */
  start(
    conversationId: string,
    agentId: string,
    opts?: StartOptions,
  ): Promise<void>;

  /**
   * Stop the (conv, agent) runtime: SIGTERM then SIGKILL.
   *
   * Routing is derived from the DB unless {@link StopOptions.hostId} names it —
   * see `StopOptions` for the post-delete case that requires the override.
   */
  stop(
    conversationId: string,
    agentId: string,
    opts?: StopOptions,
  ): Promise<void>;

  /**
   * Clear the persisted `cli_session_id` for (conv, agent) so the next
   * spawn starts a fresh CLI session (no `--resume`). Hard-stops the
   * runtime if it is currently active. Writes an audit row and
   * publishes the resulting state.
   */
  clearSession(
    conversationId: string,
    agentId: string,
    actorUserId?: string | null,
  ): Promise<ClearSessionResult>;

  /** Stop every running handle. Used on backend shutdown. Hard mode. */
  stopAll(): Promise<void>;

  /** Best-effort idle reaper tick. Stops live, idle runtimes older than TTL. */
  reapIdleRuntimes(
    opts: ReapIdleRuntimesOptions,
  ): Promise<ReapIdleRuntimesResult>;

  /**
   * Sync the human-controlled temporary log-debug window to the
   * runtime host. Backend owns the public API and local logger state;
   * daemon keeps its own TTL as a fail-safe if backend disappears.
   */
  setConversationLogDebug(
    conversationId: string,
    enabled: boolean,
    expiresAt?: number | null,
  ): Promise<void>;

  /**
   * Flush and close the dedicated activity log stream. Must be called
   * after `stopAll()` so terminal events are written first.
   */
  closeActivityLog(): Promise<void>;

  // ── delivery ────────────────────────────────────────────────────
  /**
   * Hand a message to the (conv, agent) runtime. Persists to inbox if
   * the runtime is offline; injects via `runtime_deliver` if running.
   */
  /**
   * Drive delivery of EVERYTHING currently pending for (conv, agent)
   * through the live delivery plane (`runtime_deliver`). Returns true if
   * a batch was submitted. Used when durable rows were created outside
   * the normal send fan-out (e.g. thread-window materialization on a
   * freshness 409) and must not wait for a future spawn/drain trigger.
   */
  deliverPending(conversationId: string, agentId: string): Promise<boolean>;
  deliverMessage(
    conversationId: string,
    agentId: string,
    messageId: string,
  ): Promise<void>;

  // ── boot recovery ───────────────────────────────────────────────
  /**
   * Backend boot: reconcile stale `conversation_agents` rows.
   *
   * `runtime_status` hydrate is the ground truth: snapshot-active
   * runtimes are NOT touched (daemon is supervising them); rows
   * absent from the snapshot are stale and cleared.
   *
   * Async because the daemon hydrate needs a bridge round-trip
   * before diffing. Callers MUST `await ctx.runtimeHost.reconcileOnBoot()`.
   */
  reconcileOnBoot(): void | Promise<void>;

  // ── run-state surface (read-only views used by routes/services) ─
  /** All `AgentRunState`s belonging to the given conversation. */
  getAgentRunStates(conversationId: string): AgentRunState[];

  /**
   * Resolve the active run for (conv, agent) with the given terminal
   * reason. No-op when there is no current run or the optional
   * `runId` doesn't match the active run id.
   */
  resolveRun(
    conversationId: string,
    agentId: string,
    reason: AgentRunTerminalReason,
    runId?: string,
  ): void;

  /**
   * Resolve every active run in the conversation (used when a
   * conversation closes). Default reason is `'conversation_closed'`.
   */
  resolveConversationRuns(
    conversationId: string,
    reason?: AgentRunTerminalReason,
  ): void;
}
