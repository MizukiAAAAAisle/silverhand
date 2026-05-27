/**
 * `RuntimeBridge` — backend's command-side seam to silverhand-daemon.
 *
 * ## Responsibility scope (Cindy `KMJFmcS4hf_tJ5hj` boundary 1)
 *
 * Sends intents TO the daemon and returns the typed result. Does NOT:
 *   - Subscribe to events (`RuntimeEventHandler` owns that)
 *   - Hold or mutate cache state (`RunStateCache` owns that)
 *   - Touch the DB, SSE, inbox, or activity log
 *   - Implement business rules around when to start / stop
 *     (`DaemonAgentRuntimeHost` owns that)
 *
 * Concretely, the bridge is a thin typed proxy over `HostClient`
 * intents. Naming clarity for `clearRuntimeSession` (Cindy
 *      `KMJFmcS4hf_tJ5hj` boundary 4). The daemon intent
 *      `runtime_clear_session` ONLY tears down host-side runtime
 *      state; backend's user-level `clearSession` (DB tx, audit
 *      message, `cli_session_id` clear) stays in `AgentService`. The
 *      bridge method is therefore named `clearRuntimeSession` — NOT
 *      `clearSession` — so backend reviewers cannot mistake one for
 *      the other at a call site.
 *
 * Everything else here is a 1-line passthrough to the matching
 * `HostClient.runtime*` typed helper. The bridge does not add retry
 * logic, does not interpret business-state results (e.g.
 * `init_cooldown`) — callers pattern-match on the discriminated union
 * the daemon returns.
 *
 * ## Why the bridge holds no state
 *
 * Cindy `KMJFmcS4hf_tJ5hj` boundary 2: separate concerns. The
 * daemon-instance-key tracking belongs to `RuntimeEventHandler` (it
 * sees the daemon's `ready` event and reacts to reconnects);
 * per-handle state belongs to `RunStateCache`; this module only
 * wraps `host.runtime*()` calls. Adding state here would force
 * tests to mock both HostClient AND the cache, defeating the split.
 */
import type {
  HostClient,
  ConversationLogDebugResult,
  RuntimeClearSessionResult,
  RuntimeCloseActivityLogResult,
  RuntimeStartParams,
  RuntimeStartResult,
  RuntimeStatusResult,
  RuntimeStopAllResult,
  RuntimeStopParams,
  RuntimeStopResult,
  RuntimeWakeParams,
  RuntimeWakeResult,
} from '@silverhand/host';

/**
 * Spawn input the bridge translates into a `runtime_start` request.
 */
export interface RuntimeStartInput {
  conversationId: string;
  agentId: string;
  /** Typed daemon-side spawn metadata. No cwd/system_prompt_path/env
   *  map is allowed by the protocol schema. */
  options: RuntimeStartParams['options'];
  /** Optional spawn-time inbox drain. Same shape as
   *  `RuntimeStartParams.startup_delivery`. */
  startupDelivery?: RuntimeStartParams['startup_delivery'];
}

export class RuntimeBridge {
  constructor(private readonly client: HostClient) {}

  /**
   * Start a runtime. Forwards typed metadata to HostClient. Returns the daemon's typed result —
   * either `{started: true, pid, started_at, startup_delivery_accepted?}`
   * or the business-state arm `{started: false, reason: 'init_cooldown', cooldown_until}`.
   *
   * Throws `HostClientError` on transport / daemon `internal_error`;
   * caller handles those separately from business state.
   */
  async runtimeStart(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    const params: RuntimeStartParams = {
      conversation_id: input.conversationId,
      agent_id: input.agentId,
      options: input.options,
      ...(input.startupDelivery
        ? { startup_delivery: input.startupDelivery }
        : {}),
    };
    return this.client.runtimeStart(params);
  }

  /**
   * Live wake — deliver one or more inbox rows to a running runtime
   * via the daemon's batched `runtime_wake` intent. The bridge does
   * NOT decide what payload to ship (caller — CM's drain logic —
   * formats the stream-json line) and does NOT mark inbox rows
   * delivered (`RuntimeEventHandler` does that on the success arm or
   * on the corresponding `runtime_startup_delivery_consumed` event
   * for spawn-time drains).
   */
  runtimeWake(params: RuntimeWakeParams): Promise<RuntimeWakeResult> {
    return this.client.runtimeWake(params);
  }

  /**
   * Stop a runtime. Both hard (SIGTERM→SIGKILL cascade in daemon) and
   * soft (directive injection) modes pass through. Result shape is a
   * discriminated union keyed on `mode` — see protocol docstring for
   * why we DON'T flatten `directive_delivered` and `stopped` into one
   * field.
   */
  runtimeStop(params: RuntimeStopParams): Promise<RuntimeStopResult> {
    return this.client.runtimeStop(params);
  }

  /**
   * Tear down host-side runtime state for a (conv, agent). Named
   * `clearRuntimeSession` — NOT `clearSession` — to make the layer
   * boundary obvious at call sites: backend's `AgentService.clearSession`
   * still owns the DB tx (audit row, `cli_session_id` clear, SSE
   * announcement) and calls THIS method to ask the daemon to clean
   * up the runtime side. Mixing the names was an outstanding review
   * blocker (Cindy `KMJFmcS4hf_tJ5hj` boundary 4); the explicit
   * `Runtime` prefix is the fix.
   */
  clearRuntimeSession(
    conversationId: string,
    agentId: string,
  ): Promise<RuntimeClearSessionResult> {
    return this.client.runtimeClearSession({
      conversation_id: conversationId,
      agent_id: agentId,
    });
  }

  /**
   * Stop every runtime the daemon is tracking. Used at backend
   * shutdown so daemon doesn't keep orphan children running.
   */
  runtimeStopAll(): Promise<RuntimeStopAllResult> {
    return this.client.runtimeStopAll();
  }

  /**
   * Tell daemon to flush any runtime-side buffers. The
   * `agent-activity-*.log` file is backend-owned in daemon mode and
   * is closed by `DaemonAgentRuntimeHost`.
   */
  runtimeCloseActivityLog(): Promise<RuntimeCloseActivityLogResult> {
    return this.client.runtimeCloseActivityLog();
  }

  setConversationLogDebug(
    conversationId: string,
    enabled: boolean,
    expiresAt?: number | null,
  ): Promise<ConversationLogDebugResult> {
    if (enabled) {
      if (!expiresAt) {
        throw new Error('setConversationLogDebug: expiresAt is required when enabling debug');
      }
      return this.client.setConversationLogDebug({
        conversation_id: conversationId,
        enabled: true,
        expires_at: expiresAt,
      });
    }
    return this.client.setConversationLogDebug({
      conversation_id: conversationId,
      enabled: false,
    });
  }

  /**
   * Hydrate query — used by `RuntimeEventHandler` on subscribe / on
   * reconnect / on daemon-pid change to repopulate `RunStateCache`.
   * Pass `conversation_id` / `agent_id` to scope; omit both to get
   * every runtime the daemon currently tracks.
   */
  runtimeStatus(
    params: { conversationId?: string; agentId?: string } = {},
  ): Promise<RuntimeStatusResult> {
    return this.client.runtimeStatus({
      ...(params.conversationId
        ? { conversation_id: params.conversationId }
        : {}),
      ...(params.agentId ? { agent_id: params.agentId } : {}),
    });
  }
}
