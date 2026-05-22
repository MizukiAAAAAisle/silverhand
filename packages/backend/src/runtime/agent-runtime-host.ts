/**
 * `AgentRuntimeHost` — the backend-side facade for agent runtime
 * lifecycle (start/stop/wake/clear-session/inbox delivery/run-state).
 * The only implementation is `DaemonAgentRuntimeHost`, which delegates
 * to `silverhand-daemon` over `RuntimeBridge` and reads passive
 * run-state from `RunStateCache` (events flow back through
 * `RuntimeEventHandler`).
 *
 * **NOT related to workspace host identity.** The `host_id` column on
 * agents / workspaces and the `HostRepo` row identify a physical host
 * (currently always `'local'`). `AgentRuntimeHost` is a runtime-side
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
} from '@silverhand/shared';

/** Optional `start()` overrides. Kept thin — only fields services
 *  actually pass at call time. */
export interface StartOptions {
  /** Override the model (e.g. `sonnet-4-6`). Falls back to agent.model. */
  model?: string | null;
}

/** Pre-clear snapshot returned by `clearSession()`. Callers use this
 *  to decide whether to publish an audit message and what to log. */
export interface ClearSessionResult {
  prevCliSessionId: string | null;
  wasRunning: boolean;
}

/**
 * Backend-side facade for the per-(conversation, agent) runtime
 * lifecycle. Only implementation: `DaemonAgentRuntimeHost`.
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
   * Stop the (conv, agent) runtime.
   *
   * @param mode `'soft'` requests graceful shutdown (e.g. claude
   *   `/exit` directive), `'hard'` SIGTERMs then SIGKILLs.
   * @param softDirective free-form directive text passed to soft
   *   shutdown protocols (driver-specific).
   */
  stop(
    conversationId: string,
    agentId: string,
    mode?: 'soft' | 'hard',
    softDirective?: string,
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
   * the runtime is offline; injects via `runtime_wake` if running.
   */
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
