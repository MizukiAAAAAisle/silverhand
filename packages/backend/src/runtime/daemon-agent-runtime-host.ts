/**
 * `DaemonAgentRuntimeHost` — daemon-mode implementation of
 * `AgentRuntimeHost`.
 *
 * # Scope of this sub-commit (2b-ii, slices 1-4c)
 *
 * Every method on the `AgentRuntimeHost` interface is now implemented:
 *
 *   - **Read methods** — `getAgentRunStates`, `resolveRun`,
 *     `resolveConversationRuns` — backed by `RunStateCache` + an
 *     `EventPublisher` for the SSE side of `resolveRun`.
 *   - **Stop** — both `'hard'` and `'soft'`. Hard delegates straight
 *     to `bridge.runtimeStop`; soft composes the directive line via
 *     the agent's driver and ships it as `soft_directive`.
 *   - **Bulk shutdown** — `stopAll` → `bridge.runtimeStopAll`;
 *     `closeActivityLog` → daemon flush ack + backend-owned
 *     activity JSONL writer close.
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
 *   - **Start** — `start` lifts CM's prompt-context assembly into the
 *     shared `runtime/prompt-context.ts` module, drives
 *     `prepareSpawnFiles`, composes either `startup_delivery`
 *     (streamed drivers) or `initial_prompt` (oneShot drivers) from
 *     the pending inbox, builds the spawn env via the existing
 *     `buildAgentSpawnEnv` helper, and ships the whole bundle through
 *     `bridge.runtimeStart`. The `{started:false, reason:'init_cooldown'}`
 *     arm is projected to an `agent_status` SSE with
 *     `reason:'init_cooldown'` + `cooldown_until` (mirrors CM's
 *     `publishInitCooldown`); the success arm flips the row to
 *     `starting` + the daemon-reported pid.
 *
 * Daemon is the only supported runtime path. The legacy in-process
 * ConversationManager runtime was removed in #task:512 cleanup
 * Commit B; the `SILVERHAND_RUNTIME_HOST` env switch was removed in
 * Commit C. There is no runtime fallback — backend `startBackend`
 * throws if no `HostClient` is passed; `silverhand-daemon` is
 * mandatory.
 *
 * # Why throws (and how this file uses them, preserved from 2a)
 *
 * Cindy `0G5uJBydO_4qt_2r`: "daemon mode 对这类未覆盖场景 fail
 * loudly / 明确保留 pending，不能假装 delivered、也不能改变
 * markDelivered 时点." A silent no-op would silently lose messages or
 * orphan UI state when a future surface lands before its tests do.
 * The `notImplemented` helper is preserved for that case — it formats
 * a loud error with method name and the "no runtime fallback" recovery
 * note.
 */
import type { AgentRunState, AgentRunTerminalReason, ServerConfig } from '@silverhand/shared';
import { systemSubtype } from '@silverhand/shared';
import type { HostClient } from '@silverhand/host';
import { getDriver } from '@silverhand/host/drivers';
import type { Database } from 'better-sqlite3';
import type { BackendLogger, SilverhandCliLauncher } from '../context.js';
import type {
  AgentRuntimeHost,
  ClearSessionResult,
  StartOptions,
} from './agent-runtime-host.js';
import type { AgentTokenStore } from '../auth/agent-token-store.js';
import { buildSystemPromptFor } from '../drivers/index.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { SettingsRepo } from '../repos/settings-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { MembershipService } from '../services/membership-service.js';
import { prepareSpawnFiles } from '../spawn-prep.js';
import type { ActivityLogWriter } from './activity-log-writer.js';
import type { RuntimeBridge } from './bridge.js';
import type { LiveDeliveryRequest, RuntimeDeliveryCoordinator } from './delivery-coordinator.js';
import type { RuntimeEventHandler } from './event-handler.js';
import type { EventPublisher } from './event-handler.js';
import type { RuntimeHostPlacement } from './host-placement.js';
import { buildPromptContext } from './prompt-context.js';
import type { RunStateCache } from './run-state-cache.js';
import { buildBridgeBaseEnv } from './spawn-env.js';
import { formatInboxBatch, formatLiveMessage, sendMessageToolName } from './stdin-format.js';

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
  /** Workspace repo — used by `start` to look up workspace metadata
   *  for prompt-context assembly + the workspace-memory index. */
  workspaces: WorkspaceRepo;
  /** V1 host placement gate. It resolves `agent.host_id` and fails
   *  closed when the owning host row is missing or revoked. It does
   *  not route to another transport; daemon mode still uses the one
   *  local socket wired into `bridge`. */
  placement: RuntimeHostPlacement;
  /** Membership projection used by `start` to render the prompt's
   *  "Members in this conversation" block. Same instance CM uses so
   *  the two runtime hosts produce byte-identical prompts. */
  membership: MembershipService;
  /** Path to the `~/.silverhand` directory used by `start` to locate
   *  L1 `system_prompt.md` for the spawning agent. Wired from
   *  `BackendContext.silverhandDir` at boot. */
  silverhandDir: string;
  /** `silverhand` CLI launcher passed to `prepareSpawnFiles`. CLI shim
   *  inside the spawn dir resolves to this command. */
  silverhandCli: SilverhandCliLauncher;
  /** Per-spawn auth token issuer for the agent's CLI. The token is
   *  embedded in the spawn env and rotates on every `start`. */
  agentTokens: AgentTokenStore;
  /** Backend's HTTP URL — read once per `start` and embedded in the
   *  spawn env so the agent's `silverhand` CLI can reach the internal
   *  routes. Wired as a thunk because `BackendContext.serverConfig`
   *  is mutated after the Hono server binds its port. */
  serverConfig: () => ServerConfig;
  /**
   * Parent process environment used as the inherited base for the
   * spawn env. Defaults to `process.env`. **Production must NOT
   * override this** — the parent's proxy vars (HTTP_PROXY etc.) MUST
   * propagate to codex so it can reach the model endpoint behind a
   * corporate proxy (shiki invariant). The seam exists purely so
   * tests can pin "wire env contains only SILVERHAND_* + PATH" with
   * a deterministic `{}` instead of the developer's shell env.
   */
  baseProcessEnv?: NodeJS.ProcessEnv;
  /** Backend-owned `agent_activity` JSONL writer. The daemon itself
   *  has no activity log stream; this host closes the backend writer
   *  during the normal shutdown sequence after asking daemon to flush
   *  its outbound buffers. */
  activityLog?: ActivityLogWriter;
  /** Used by `clearSession` to wrap the row-update + audit insert in
   *  a single sqlite transaction (matches CM behavior). */
  db: Database;
  logger: BackendLogger;
}

/**
 * Standard error message body for methods that remain
 * not-yet-implemented in this sub-commit. Centralised so the recovery
 * recipe phrasing cannot drift between methods. Kept around even after
 * the last `start` throw was removed — future surface additions can
 * reuse it without re-inventing the diagnostic. Post-Commit B the
 * recipe MUST NOT advertise `=legacy` as a runtime fallback (Cindy
 * `0aTZCqe07rmqA08k` blocker 1) — the legacy in-process
 * ConversationManager runtime was removed in Commit B; daemon is the
 * only runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function notImplemented(method: string): Error {
  return new Error(
    `silverhand-daemon: ${method}() is not yet implemented. ` +
      `There is no runtime fallback — the legacy in-process ConversationManager runtime ` +
      `was removed in #task:512 cleanup Commit B; daemon is the only supported runtime.`,
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
  private readonly workspaces: WorkspaceRepo;
  private readonly placement: RuntimeHostPlacement;
  private readonly membership: MembershipService;
  private readonly silverhandDir: string;
  private readonly silverhandCli: SilverhandCliLauncher;
  private readonly agentTokens: AgentTokenStore;
  private readonly serverConfig: () => ServerConfig;
  private readonly baseProcessEnv: NodeJS.ProcessEnv;
  private readonly activityLog?: ActivityLogWriter;
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
    this.workspaces = deps.workspaces;
    this.placement = deps.placement;
    this.membership = deps.membership;
    this.silverhandDir = deps.silverhandDir;
    this.silverhandCli = deps.silverhandCli;
    this.agentTokens = deps.agentTokens;
    this.serverConfig = deps.serverConfig;
    this.baseProcessEnv = deps.baseProcessEnv ?? process.env;
    this.activityLog = deps.activityLog;
    this.db = deps.db;
    this.logger = deps.logger;
    this._client = deps.client;
  }

  // ── lifecycle ───────────────────────────────────────────────────
  /**
   * Spawn a runtime via the daemon. Mirrors CM's `start` orchestration
   * but delegates the actual child-process management to the daemon
   * over the IPC bridge:
   *
   *   1. Resolve conversation / agent / workspace + ensure the
   *      `(conv, agent)` join row exists.
   *   2. Idempotent cache check — if a live (non-`exited`) entry
   *      already exists, no-op. The daemon-side `runtime_start` is
   *      itself idempotent (returns the existing pid on repeat), but
   *      we still short-circuit here so we don't waste a round-trip
   *      + re-run prompt assembly.
   *   3. Issue a fresh per-spawn agent token + build the prompt
   *      context (lifted to `runtime/prompt-context.ts` so CM and
   *      daemon mode produce byte-identical system prompts) + write
   *      spawn files via `prepareSpawnFiles`.
   *   4. Compose inbox payload:
   *        - oneShot drivers (cursor) — drain inbox now; the formatted
   *          text becomes `options.initial_prompt` (argv body for
   *          cursor-agent). Daemon never emits a delivery-consumed
   *          event for this path, so we `markDelivered` ourselves on
   *          the success arm.
   *        - streamed drivers (claude/codex) — drain inbox + encode
   *          one stream-json line, ship as `startup_delivery`. Daemon
   *          emits `runtime_startup_delivery_consumed` on success;
   *          `RuntimeEventHandler` routes that event to
   *          `inbox.markDelivered`. We DO NOT mark here.
   *   5. Build the spawn env (same `buildAgentSpawnEnv` CM uses) and
   *      call `bridge.runtimeStart` — the bridge layers proxy keys
   *      on top of `baseEnv` per the allowlist.
   *   6. Project the response:
   *        - `{started: true}` → flip the row to `starting` + publish
   *          `agent_status`. Daemon will emit `runtime_state` /
   *          `runtime_ready_for_drain` events as the runtime
   *          transitions through its watchdog stages; the cache
   *          tracks those.
   *        - `{started: false, reason: 'init_cooldown'}` → flip the
   *          row to `crashed` + publish `agent_status` with
   *          `reason: 'init_cooldown'` + `cooldown_until`. Mirrors
   *          CM's `publishInitCooldown` projection (Cindy
   *          `5Yrv3roymWkCPxo1` — pre-gate lives daemon-side; backend
   *          only projects the result arm).
   *
   * Throws on transport / daemon `internal_error` (the bridge
   * surfaces those as `HostClientError`); callers handle those the
   * same way they handled CM throws — propagate to the originating
   * request, log via `recordStartFailure` is a CM-only concept and is
   * not replicated here because daemon mode does not own init-retry
   * state.
   */
  async start(conversationId: string, agentId: string, opts: StartOptions = {}): Promise<void> {
    this.placement.resolveForAgent(agentId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    if (conversation.closed_at !== null) {
      throw new Error(`conversation ${conversationId} is closed`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const workspace = this.workspaces.get(conversation.workspace_id);
    if (!workspace) {
      throw new Error(`workspace ${conversation.workspace_id} not found`);
    }

    // Idempotent: if the cache says we already have a live runtime,
    // no-op. We compare against the cache (not the DB row's `status`)
    // because the cache is the daemon's authoritative projection — a
    // stale `starting` row that the reconcile sweep hasn't cleared yet
    // would otherwise short-circuit us when daemon has nothing.
    const cacheEntry = this.cache.get(conversationId, agentId);
    if (cacheEntry && cacheEntry.phase !== 'exited') {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          phase: cacheEntry.phase,
        },
        'start: no-op, runtime already live per daemon cache',
      );
      return;
    }

    // Ensure the join row exists (callers may have skipped addAgent).
    let sessionAgent = this.conversations.getAgent(conversationId, agentId);
    if (!sessionAgent) {
      sessionAgent = this.conversations.addAgent(conversationId, agentId);
    }

    const driver = getDriver(agent.runtime);
    const agentToken = this.agentTokens.issue(conversationId, agentId);

    // Synthesize prompt + write spawn files.
    const promptCtx = await buildPromptContext({
      conversation,
      workspace,
      agent,
      silverhandDir: this.silverhandDir,
      listMembers: id => this.membership.listMembers(id),
      listWorkspacesForAgent: id => this.workspaces.listForAgent(id),
      getConversation: id => this.conversations.get(id),
    });
    const systemPromptText = buildSystemPromptFor(driver.kind, promptCtx);
    const spawnPrep = await prepareSpawnFiles({
      conversationId,
      agentId,
      systemPromptText,
      silverhandCli: this.silverhandCli,
    });

    // Drain inbox per driver kind. For oneShot drivers the inbox
    // can't ride over stdin — there is no persistent stdin loop on
    // the daemon side either — so we drain now and pass the formatted
    // text as `initial_prompt`. For streamed drivers we hand the
    // daemon the raw text and let it encode via its in-process driver
    // instance (Option A v2 — Cindy `UMGu36zoTDVuKWXi`); the legacy
    // backend-side `driver.encodeStdinMessage` call was the codex
    // delivery blocker (stateless instance, no threadId).
    let initialPrompt = '';
    let startupDelivery: { delivery_ids: number[]; text: string } | undefined;
    let oneShotPreDrainedIds: number[] = [];
    const pending = this.inboxes.listPending(conversationId, agentId);
    if (pending.length > 0) {
      const text = formatInboxBatch(
        pending,
        id => this.agents.get(id)?.name,
        id => this.users.get(id)?.name,
        this.resolveDefaultUserHandle(),
        agent.name,
        sendMessageToolName(driver),
      );
      if (driver.oneShot) {
        initialPrompt = text;
        oneShotPreDrainedIds = pending.map(p => p.inboxId);
      } else {
        startupDelivery = {
          delivery_ids: pending.map(p => p.inboxId),
          text,
        };
      }
    }

    // Build the spawn env via `buildBridgeBaseEnv` — the *base* env
    // contract the bridge expects. Bridge layers proxy keys on top
    // per the `proxy_runtimes` allowlist; we MUST NOT pre-apply proxy
    // here (would either double-overlay or bypass the bridge's
    // single-point proxy-injection boundary — Cindy B5 contract from
    // commit 5 unit 1 `spawn-env.ts` docstring).
    const baseEnv = buildBridgeBaseEnv({
      driver,
      runtime: agent.runtime,
      conversationId,
      agentId,
      serverUrl: this.serverConfig().url,
      token: agentToken,
      binDir: spawnPrep.binDir,
      baseProcessEnv: this.baseProcessEnv,
    });

    const options: NonNullable<Parameters<RuntimeBridge['runtimeStart']>[0]['options']> = {
      runtime: agent.runtime,
      cwd: conversation.workspace_path,
      agent_name: agent.name,
      cli_session_id: sessionAgent.cli_session_id,
      model: opts.model ?? agent.model,
      reasoning_effort: agent.reasoning_effort,
      fast_mode: agent.fast_mode,
      system_prompt_path: spawnPrep.systemPromptPath,
      initial_prompt: initialPrompt,
    };

    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        conversationId,
        agent_id: agentId,
        runtime: agent.runtime,
        has_startup_delivery: startupDelivery !== undefined,
        one_shot: driver.oneShot,
        pending_inbox_count: pending.length,
      },
      'start: requesting runtime_start',
    );

    const result = await this.bridge.runtimeStart({
      conversationId,
      agentId,
      runtime: agent.runtime,
      baseEnv,
      options,
      ...(startupDelivery ? { startupDelivery } : {}),
    });

    if (!result.started) {
      // init_cooldown arm — project to SSE so the renderer drops the
      // spawn affordance and shows the cooldown timer. Mirrors CM's
      // `publishInitCooldown`. We DO NOT mark inbox rows delivered;
      // they survive the cooldown and drain on the next start.
      this.conversations.updateAgentRuntime(conversationId, agentId, {
        status: 'crashed',
        pid: null,
      });
      this.events.publish(conversationId, {
        kind: 'agent_status',
        payload: {
          agent_id: agentId,
          status: 'crashed',
          reason: 'init_cooldown',
          cooldown_until: result.cooldown_until,
        },
      });
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          cooldown_until: result.cooldown_until,
        },
        'start: daemon refused with init_cooldown; surfaced to SSE',
      );
      return;
    }

    // Success arm — flip the DB row to `starting`. Daemon will emit
    // `runtime_state` / `runtime_ready_for_drain` as the runtime
    // crosses init / ready boundaries; `RuntimeEventHandler` advances
    // `agent_status` from there. We DO NOT prematurely flip to
    // `active` here.
    this.conversations.updateAgentRuntime(conversationId, agentId, {
      status: 'starting',
      pid: result.pid,
    });
    this.events.publish(conversationId, {
      kind: 'agent_status',
      payload: {
        agent_id: agentId,
        status: 'starting',
        pid: result.pid,
      },
    });

    // oneShot drivers consume `initial_prompt` synchronously at
    // child-spawn time, and daemon does NOT emit a delivery-consumed
    // event for that path (it has no batch to ack). Mark the rows we
    // pre-drained delivered now — leaving them pending would cause
    // the next spawn to redeliver the same content. Streamed drivers
    // are acked async via `runtime_startup_delivery_consumed`, which
    // `RuntimeEventHandler` already routes to `inbox.markDelivered`.
    if (oneShotPreDrainedIds.length > 0) {
      this.inboxes.markDelivered(oneShotPreDrainedIds);
    }

    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        conversationId,
        agent_id: agentId,
        pid: result.pid,
        started_at: result.started_at,
        startup_delivery_accepted: result.startup_delivery_accepted ?? null,
        one_shot_marked_delivered: oneShotPreDrainedIds.length,
      },
      'start: daemon accepted runtime_start',
    );
  }

  /**
   * Stop a runtime via the daemon.
   *
   * - **Hard** (`mode='hard'`, default): ship `runtime_stop({mode:'hard'})`
   *   to the daemon; daemon does its SIGTERM→SIGKILL cascade and emits
   *   the trailing `runtime_exit` event. Backend does NOT touch the
   *   cache here — `RuntimeEventHandler` will apply `applyRuntimeExit`
   *   when the event lands.
   * - **Soft** (`mode='soft'`): ship the unencoded directive text inside
   *   `runtime_stop({mode:'soft', soft_directive: text})`. Daemon
   *   encodes via its in-process driver instance (Option A v2 — Cindy
   *   `UMGu36zoTDVuKWXi`) and writes the resulting bytes to the child's
   *   stdin. Default directive matches CM's wording ("user requested a
   *   course correction…"). Pre-`readyToEncode()` soft stop surfaces as
   *   `directive_delivered:false` with `reason:'driver_refused'`
   *   (Cindy `wYjG20JdGjLpwq8K`: kept on the existing enum, no new
   *   `driver_not_ready` arm for soft stop because directives are
   *   not retried).
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
    this.placement.resolveForAgent(agentId);
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
    const directive =
      softDirective ??
      '[user requested a course correction — pause your current direction and ' + 'wait for the next instruction]';
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): ship raw directive text;
    // daemon encodes via its in-process driver instance whose state
    // (codex threadId etc.) is authoritative. Pre-`readyToEncode()`
    // soft stop maps to existing `driver_refused` per Cindy
    // `wYjG20JdGjLpwq8K` (no new enum arm).
    const result = await this.bridge.runtimeStop({
      conversation_id: conversationId,
      agent_id: agentId,
      mode: 'soft',
      soft_directive: directive,
    });
    if (result.mode === 'soft' && !result.directive_delivered) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
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
    this.placement.resolveForAgent(agentId);
    // 1. Validate.
    const conversation = this.conversations.get(conversationId);
    if (!conversation) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`agent ${agentId} not found`);
    const existing = this.conversations.getAgent(conversationId, agentId);
    if (!existing) {
      throw new Error(`agent ${agentId} is not a member of conversation ${conversationId}`);
    }

    // 2. Snapshot pre-state.
    const prevCliSessionId = existing.cli_session_id;
    const cacheEntry = this.cache.get(conversationId, agentId);
    const wasRunning = cacheEntry !== undefined && cacheEntry.phase !== 'exited';

    // 3. Bridge first. Transport / internal_error rejections propagate
    //    and leave DB untouched (Cindy `BYHZJI9ALSVmmlFr`). Both arms
    //    of the daemon result continue to step 4.
    await this.bridge.clearRuntimeSession(conversationId, agentId);
    this.coordinator.clearRuntime(conversationId, agentId, 'stopped');

    // 4. DB tx + audit + SSE.
    const shouldAudit = wasRunning || prevCliSessionId !== null;
    const { updated, auditMessage } = this.db.transaction(() => {
      const updated = this.conversations.updateAgentRuntime(conversationId, agentId, { cliSessionId: null });
      if (!updated) {
        throw new Error(`agent ${agentId} is not a member of conversation ${conversationId}`);
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
      // Mirror CM `publishAndDeliverSessionClearedAudit`: deliver the
      // audit message to every OTHER agent in the conversation so they
      // see the cleared-session signal in their own context (their
      // chat history, their inbox if offline). The cleared agent
      // itself does NOT receive its own audit. Per-delivery failures
      // are warn-level only — clearSession as a whole stays successful.
      for (const ca of this.conversations.listAgents(conversationId)) {
        if (ca.agent_id === agentId) continue;
        await this.deliverMessage(conversationId, ca.agent_id, auditMessage.id).catch(err =>
          this.logger.warn(
            {
              kind: 'runtime',
              mode: 'daemon',
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
    const prevLabel = params.prevCliSessionId ? `${params.prevCliSessionId.slice(0, 8)}...` : 'none';
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
        previous_cli_session_id_prefix: params.prevCliSessionId ? params.prevCliSessionId.slice(0, 8) : null,
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

  async setConversationLogDebug(
    conversationId: string,
    enabled: boolean,
    expiresAt?: number | null,
  ): Promise<void> {
    await this.bridge.setConversationLogDebug(conversationId, enabled, expiresAt);
  }

  /**
   * Ask daemon to flush its outbound buffers, then close the
   * backend-owned activity JSONL writer. RealSupervisor's
   * `runtime_close_activity_log` is a noop ack for activity logging
   * itself; the file lives in backend so shutdown does not depend on
   * host internals.
   *
   * Safe to call when `logDir` is absent or this is called twice.
   */
  async closeActivityLog(): Promise<void> {
    await this.bridge.runtimeCloseActivityLog();
    await this.activityLog?.close();
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
  async deliverMessage(conversationId: string, agentId: string, messageId: string): Promise<void> {
    this.placement.resolveForAgent(agentId);
    const msg = this.messages.getById(messageId);
    if (!msg) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          msg_id: messageId,
        },
        'deliver: messageId not found in messages table',
      );
      return;
    }

    const delivery = this.inboxes.ensureDelivery(conversationId, agentId, messageId);
    if (delivery.deliveredAt !== null) {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
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
          conversationId,
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
          conversationId,
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
        // manual start. The catch swallows start failures so the
        // inbox row is not corrupted — operator sees the error in the
        // agent log and retries explicitly.
        this.start(conversationId, agentId).catch(err =>
          this.logger.error(
            {
              kind: 'runtime',
              mode: 'daemon',
              conversationId,
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
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): no backend-side encode
    // probe. Daemon owns encoding via its in-process driver instance;
    // it returns `driver_not_ready` (codex pre-handshake — row stays
    // pending, redelivers on `runtime_ready_for_drain`) or
    // `driver_refused` (driver bug — fail loud) and the coordinator
    // keeps the inbox row pending on both arms. oneShot drivers are
    // filtered downstream via `driver.busyDeliveryMode === 'none'`.

    const decision = await this.coordinator.submitLiveDelivery(conversationId, agentId, {
      deliveryIds: [delivery.inboxId],
      dedupKey: messageId,
      text,
      driver: {
        runtime: agent.runtime,
        oneShot: driver.oneShot,
        busyDeliveryMode: driver.busyDeliveryMode,
        kickoffMode: driver.kickoffMode,
      },
    });
    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        conversationId,
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

  // ── drain on ready ─────────────────────────────────────────────────
  /**
   * Drain every pending `conversation_inboxes` row for (conv, agent).
   * Wired to `RuntimeEventHandler.onReadyForDrain` so that when a
   * daemon-side runtime flips to the `ready` phase AFTER startup
   * (e.g. an empty-inbox claude spawn that crossed startup_pending →
   * ready without ever being woken), the rows that arrived during the
   * startup_pending window do not leak.
   *
   * Pre-B2 (Cindy `usjxj8AxX4AvJ5E-`): `runtime_ready_for_drain` was
   * unwired — `submitLiveDelivery` returns `noop_phase` while the
   * runtime is `startup_pending`, the row stays pending in the inbox,
   * and no event ever fires to re-attempt it. The DB rows would only
   * drain on the NEXT `start()` via `startup_delivery`, which never
   * comes if the runtime is already up. This method closes the gap.
   *
   * # Batch contract: inbox-drain wrapper + combine-before-encode
   *   (Cindy `nKFVSvx4CyBLxPNq` blocker 2 + `Mqf1h-FKudtEbH1O`)
   *
   * Semantically this is the analogue of legacy CM's `drainInbox()` at
   * spawn time — the agent has just become live and is about to be
   * fed messages that arrived while it was not active. The right
   * wrapper is `formatInboxBatch` ("You have N messages waiting since
   * you were last active..."), NOT `combineGatedBatch` ("messages that
   * arrived while you were busy") which is the coordinator's flush
   * vocabulary for mid-turn arrivals.
   *
   * We therefore pre-combine on the caller side: read every pending
   * row → produce ONE inbox-batch text via `formatInboxBatch` → submit
   * a SINGLE `LiveDeliveryRequest` whose `deliveryIds` covers every
   * inbox id. The coordinator sees a 1-element batch, encodes once
   * via the request's `encode` closure, and dispatches a single
   * `runtime_wake` carrying every `delivery_id`. Ack is atomic across
   * the whole group:
   *
   *   - on `{delivered:true}` → `markDelivered` runs once with every
   *     id (or the entire group is stashed for the B3 init gate to
   *     flush atomically on `session_init`);
   *   - on `{delivered:false}` or throw → NO ids are acked; every row
   *     stays pending so the next ready_for_drain replays the whole
   *     group.
   *
   * Per-row looping or feeding driver-encoded JSON lines through
   * `combineGated` would: (a) change claude's visible turn boundary
   * (N user turns instead of one batched payload), (b) degrade ack
   * into partial-success, and (c) ship malformed stream-json to the
   * child — all forbidden.
   *
   * NOTE on ordering with B3 (initObserved gating): for claude
   * (`kickoffMode='requires_first_message'`) the wake we dispatch here
   * may arrive BEFORE the daemon emits
   * `runtime_parsed_event(session_init)`. The coordinator's B3 gate
   * stashes the entire group's `delivery_ids` and flushes them as one
   * `markDelivered` when session_init lands — preserving the
   * all-or-nothing semantics across the gate.
   */
  async drainPending(conversationId: string, agentId: string): Promise<void> {
    this.placement.resolveForAgent(agentId);
    const pending = this.inboxes.listPending(conversationId, agentId);
    if (pending.length === 0) {
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
        },
        'drain: no pending inbox rows; ready_for_drain noop',
      );
      return;
    }
    this.logger.info(
      {
        kind: 'runtime',
        mode: 'daemon',
        conversationId,
        agent_id: agentId,
        pending_count: pending.length,
      },
      'drain: ready_for_drain — combining inbox batch from pending rows',
    );

    // Resolve agent + driver once — every pending row is for the same
    // (conv, agent) by construction.
    const agent = this.agents.get(agentId);
    if (!agent) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          pending_count: pending.length,
        },
        'drain: agent not found in agents table; batch left pending',
      );
      return;
    }
    const driver = getDriver(agent.runtime);
    const defaultUserHandle = this.resolveDefaultUserHandle();

    // ONE inbox-batch text covering every pending row. `formatInboxBatch`
    // is the inbox-drain wrapper (not `combineGatedBatch` which is the
    // mid-turn-busy wrapper). The coordinator never re-combines because
    // we submit a 1-element batch with multi `deliveryIds`.
    //
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): no backend-side encode
    // probe. Daemon owns the encode via its in-process driver instance
    // and returns `driver_not_ready` / `driver_refused` if it can't.
    // Coordinator keeps the inbox batch pending on both arms; the next
    // `runtime_ready_for_drain` triggers a re-drain.
    const batchText = formatInboxBatch(
      pending,
      id => this.agents.get(id)?.name,
      id => this.users.get(id)?.name,
      defaultUserHandle,
      agent.name,
      sendMessageToolName(driver),
    );

    const deliveryIds = pending.map(row => row.inboxId);
    const req: LiveDeliveryRequest = {
      deliveryIds,
      // Use the first row's message id as the dedup key. Mid-turn
      // gated re-arrival of the same row would attempt to re-enqueue,
      // dedupe skips it.
      dedupKey: pending[0]!.message.id,
      text: batchText,
      driver: {
        runtime: agent.runtime,
        oneShot: driver.oneShot,
        busyDeliveryMode: driver.busyDeliveryMode,
        kickoffMode: driver.kickoffMode,
      },
    };

    try {
      const decision = await this.coordinator.submitLiveDelivery(conversationId, agentId, req);
      this.logger.info(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          batch_size: pending.length,
          delivery_ids: deliveryIds,
          decision: decision.kind,
        },
        'drain: coordinator inbox-batch decision',
      );
    } catch (err) {
      this.logger.warn(
        {
          kind: 'runtime',
          mode: 'daemon',
          conversationId,
          agent_id: agentId,
          batch_size: pending.length,
          delivery_ids: deliveryIds,
          err: err instanceof Error ? err.message : String(err),
        },
        'drain: coordinator inbox-batch threw; entire batch stays pending',
      );
    }
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
   *      `cli_session_id` so the next start uses `--resume`. Recovery
   *      contract inherited from the original ConversationManager
   *      runtime, except we never SIGKILL — daemon owns the child
   *      processes, not us.
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
  resolveRun(conversationId: string, agentId: string, reason: AgentRunTerminalReason, runId?: string): void {
    const terminal = this.cache.resolveRun(conversationId, agentId, reason, runId);
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
  resolveConversationRuns(conversationId: string, reason: AgentRunTerminalReason = 'conversation_closed'): void {
    const terminals = this.cache.resolveConversationRuns(conversationId, reason);
    for (const terminal of terminals) {
      this.events.publish(conversationId, {
        kind: 'agent_activity',
        payload: terminal,
      });
    }
  }
}
