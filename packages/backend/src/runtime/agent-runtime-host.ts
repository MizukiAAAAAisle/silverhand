/**
 * `AgentRuntimeHost` — the backend-side facade for agent runtime
 * lifecycle (start/stop/wake/clear-session/inbox delivery/run-state),
 * shared by the two execution paths gated by `SILVERHAND_RUNTIME_HOST`:
 *
 *   - `LegacyAgentRuntimeHost` = the existing in-process
 *     `ConversationManager` which spawns child CLIs directly.
 *   - `DaemonAgentRuntimeHost` = a thin shim that delegates to the
 *     `silverhand-daemon` over `RuntimeBridge` and reads passive
 *     run-state from `RunStateCache` (events flow back through
 *     `RuntimeEventHandler`).
 *
 * **NOT related to workspace host identity.** The `host_id` column on
 * agents / workspaces and the `HostRepo` row identify a physical host
 * (currently always `'local'`). `AgentRuntimeHost` is a runtime-side
 * dispatch boundary for "who actually owns the child process" —
 * `ConversationManager` (legacy) or the daemon (`silverhand-daemon`).
 *
 * The interface mirrors the existing `ConversationManager` public
 * surface exactly so all existing call sites (services, routes) keep
 * working with a single rename `ctx.conversationManager →
 * ctx.runtimeHost`. New shape is intentionally avoided — Cindy
 * `bJUazoeBrxK8XglK` blocker (1): "按现有 call sites 精确建模，不要发明
 * 新形状".
 */
import type {
  AgentRunState,
  AgentRunTerminalReason,
} from '@silverhand/shared';
import type {
  ClearSessionResult,
  StartOptions,
} from '../conversation-manager.js';

/**
 * Backend-side facade for the per-(conversation, agent) runtime
 * lifecycle. Two implementations:
 *
 * - `ConversationManager` (legacy in-process spawn — default).
 * - `DaemonAgentRuntimeHost` (delegates to `silverhand-daemon` via
 *    `RuntimeBridge`; gated by `SILVERHAND_RUNTIME_HOST=daemon`).
 *
 * @see ./runtime-host-mode.ts for the boot-time mode switch.
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
   * Flush and close the dedicated activity log stream. Must be called
   * after `stopAll()` so terminal events are written first.
   */
  closeActivityLog(): Promise<void>;

  // ── delivery ────────────────────────────────────────────────────
  /**
   * Hand a message to the (conv, agent) runtime. Persists to inbox if
   * the runtime is offline; injects via stdin (legacy) or
   * `runtime_wake` (daemon) if running.
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
   * - Legacy: there are no in-process handles after a crash, so any
   *   row with `status IN ('starting','active')` is stale → flip to
   *   `'idle'`, clear pid, keep `cli_session_id` so next start uses
   *   `--resume`.
   * - Daemon: `runtime_status` hydrate is the ground truth.
   *   Snapshot-active runtimes are NOT touched (daemon is supervising
   *   them); rows absent from the snapshot are stale and cleared.
   */
  reconcileOnBoot(): void;

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
