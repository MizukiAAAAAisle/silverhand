/**
 * `RuntimeBridge` — backend's command-side seam to silverhand-daemon.
 *
 * ## Responsibility scope (Cindy `KMJFmcS4hf_tJ5hj` boundary 1)
 *
 * Sends intents TO the daemon and returns the typed result. Does NOT:
 *   - Subscribe to events (`RuntimeEventHandler` owns that)
 *   - Hold or mutate cache state (`RunStateCache` owns that)
 *   - Touch the DB, SSE, inbox, or activity log
 *   - Implement business rules around when to start / stop (caller —
 *     `ConversationManager` post-flip — owns that)
 *
 * Concretely, the bridge is a thin typed proxy over `HostClient`
 * intents that injects two backend-only concerns the daemon cannot
 * compute on its own:
 *
 *   1. **Proxy env layering.** Backend is the only Settings/DB reader
 *      (Cindy `KzTBo4xxUmcx77yR` + shiki `piIb3YZgFjA5qaaE`). Daemon
 *      stays dumb — it never reads `app_settings`. The bridge looks
 *      up `proxy_url` / `proxy_runtimes` from the caller-supplied
 *      `ProxySettingsSource` and layers `applyProxyEnv()` over the
 *      caller's `options.env` BEFORE shipping `runtime_start` to the
 *      daemon. The daemon's own merge step
 *      (`{ ...process.env, ...wire.env }`) will pick the proxy
 *      vars up unchanged.
 *
 *   2. **Naming clarity for `clearRuntimeSession`** (Cindy
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
import { applyProxyEnv, parseProxyRuntimes } from './proxy-env.js';

/**
 * Caller-supplied read-only view of backend Settings. Kept tiny so
 * tests can pass an in-memory `{get: () => ...}` without dragging in
 * `SettingsRepo` / DB. The bridge calls this on every spawn — it does
 * NOT cache the result. Proxy URL changes in Settings take effect on
 * the next runtime_start without restart.
 */
export interface ProxySettingsSource {
  /** Returns the raw stored value, or `null` if unset. */
  get(key: 'proxy_url' | 'proxy_runtimes'): string | null;
}

/**
 * Spawn input the bridge translates into a `runtime_start` request.
 *
 * `baseEnv` is the env the caller already shaped (silverhand vars +
 * driver.applyEnv merge if any) — the bridge layers proxy keys on
 * top per the allowlist. `runtime` is the agent's runtime kind
 * (`'claude' | 'codex' | 'cursor' | 'gemini'`), used to check the
 * proxy allowlist; `options` is the daemon-side spawn options
 * (driver kind, cwd, cli session id, etc).
 *
 * The `options.env` field is what daemon spreads into the child env;
 * we replace it with `applyProxyEnv(baseEnv, runtime, ...)`. Callers
 * MUST therefore pass the env they want the child to see via
 * `baseEnv`, NOT pre-populate `options.env`.
 */
export interface RuntimeStartInput {
  conversationId: string;
  agentId: string;
  /** Used only for proxy allowlist matching. Daemon already knows
   *  the runtime from `options.runtime`; we don't re-derive it from
   *  there to avoid coupling allowlist semantics to the wire shape. */
  runtime: string;
  /** Env caller wants the child to see, minus proxy keys (the bridge
   *  layers them on per allowlist). */
  baseEnv: NodeJS.ProcessEnv;
  /** Daemon-side spawn options. The bridge OVERWRITES `env` on this
   *  object; any other fields (`runtime`, `cwd`, `cli_session_id`,
   *  driver-specific argv) flow through verbatim. */
  options: Omit<RuntimeStartParams['options'], 'env'> & {
    env?: NodeJS.ProcessEnv;
  };
  /** Optional spawn-time inbox drain. Same shape as
   *  `RuntimeStartParams.startup_delivery`. */
  startupDelivery?: RuntimeStartParams['startup_delivery'];
}

export class RuntimeBridge {
  constructor(
    private readonly client: HostClient,
    private readonly proxySettings: ProxySettingsSource,
  ) {}

  /**
   * Start a runtime. Layers proxy env per `proxy_url` /
   * `proxy_runtimes` Settings, then forwards to
   * `HostClient.runtimeStart`. Returns the daemon's typed result —
   * either `{started: true, pid, started_at, startup_delivery_accepted?}`
   * or the business-state arm `{started: false, reason: 'init_cooldown', cooldown_until}`.
   *
   * Throws `HostClientError` on transport / daemon `internal_error`;
   * caller handles those separately from business state.
   */
  async runtimeStart(input: RuntimeStartInput): Promise<RuntimeStartResult> {
    const env = applyProxyEnv(input.baseEnv, input.runtime, {
      proxyUrl: this.proxySettings.get('proxy_url'),
      allowlist: parseProxyRuntimes(this.proxySettings.get('proxy_runtimes')),
    });
    const params: RuntimeStartParams = {
      conversation_id: input.conversationId,
      agent_id: input.agentId,
      options: { ...input.options, env },
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
