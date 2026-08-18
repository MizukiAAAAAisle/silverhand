import type { BindAddressScope, ServerConfig } from '@silverhand/shared';
import type { AuthorizationReadPort } from './authorization-ports.js';
import type { ScopeEventBus } from './ws/scope-event-bus.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import type { AttachmentService } from './services/attachment-service.js';
import type { AgentService } from './services/agent-service.js';
import type { ChannelService } from './services/channel-service.js';
import type { ConversationMessageService } from './services/conversation-message-service.js';
import type { IdleReaperService } from './services/idle-reaper-service.js';
import type { ScheduleService } from './services/schedule-service.js';
import type { TaskService } from './services/task-service.js';
import type { UserService } from './services/user-service.js';
import type { BlobFileStorage } from './storage/blob-file-storage.js';
import type { AgentTokenStore } from './auth/agent-token-store.js';
import type { AuthRuntimeConfig } from './auth/config.js';
import type { EmbeddedBootstrapState } from './auth/embedded-bootstrap.js';
import type { PasswordCredentialService } from './auth/password.js';
import type { AuthSessionService } from './auth/session.js';
import type { LogLevelControl } from './logger.js';
import type { RuntimeHostPlacementControl } from './runtime/host-placement.js';
import type { OutboundFrameAdapter } from './runtime/outbound-frame-adapter.js';
import type { HostRuntimeActivityView, HostStatusReadModel } from './runtime/host-status-read-model.js';
import type { AgentL2SeedEnsurer } from './runtime/agent-l2-seed-ensurer.js';
import type { HostWsServerController } from './ws/host-ws-server.js';
import type { PresenceRegistry } from './presence/presence-registry.js';
import type { BackendMetrics } from './observability/metrics.js';
import type { DbWriteProbe } from './observability/db-write-probe.js';

export type BackendDeploymentMode = 'embedded' | 'standalone';

export interface BackendLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Categorized backend loggers. Each logger writes to its own JSONL
 * file so events from different concerns can be queried separately:
 *
 *   - `system`: HTTP server, scheduler, ws, auth, DB.
 *   - `agent`:  agent runtime spawn / drain / exit / compaction, owned
 *               by silverhand-daemon and surfaced through the outbound
 *               runtime projection.
 *   - `cli`:    every CLI invocation + CLI-side pre-flight failures.
 *
 * Existing call sites keep using `ctx.logger` (the historical "system"
 * sink) until the per-call-site sweep in PR-B routes them to the right
 * category.
 */
export interface BackendLoggers {
  system: BackendLogger;
  agent: BackendLogger;
  cli: BackendLogger;
}

/**
 * Host-supplied way to launch the `silverhand` CLI in embedded mode.
 *
 * Standalone control-plane servers deliberately do not know this value:
 * the daemon-host resolves its own packaged/dev CLI locally and exposes
 * it through the per-spawn `bin/silverhand` shim.
 */
export interface SilverhandCliLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The per-process runtime capability bag: services, effect sinks, config that
 * was decided once at boot, and the narrow ports a cross-cutting concern needs.
 *
 * **It carries no database handle (#task:1983 W5).** `db: Db` used to be the
 * first field, and it made this interface a service locator with the widest
 * possible reach: any module that already took a context — a route, a
 * middleware, an authorization predicate — could construct any repository and
 * issue any statement without declaring that it touches persistence. Removing
 * the field is what turns every previous "reads the handle off the context" into
 * a compile error instead of a ledger row. Persistence now enters the process
 * exactly once, in `persistence/root.ts`, and reaches a consumer only through
 * the ports/repos it names in its own deps.
 *
 * The remaining `db*` members are deliberately NOT handles: `dbWriteProbe` is a
 * capability that answers "can this process write" without exposing what it
 * asked, and `authorizationReads` is `permissions.ts`'s private fact port.
 *
 * Tests that genuinely need the handle (schema white-box, fixture seeding,
 * contention setups) use `TestBackendContext` from `tests/utils/`, which
 * intersects this type with `{ db: Db }`. That alias exists only under `tests/`
 * — a production file cannot reach it, so the test convenience cannot become a
 * production capability.
 */
export interface BackendContext {
  /** Optional process-local Prometheus registry. Disabled unless an operator
   * explicitly configures the private metrics listener. */
  metrics?: BackendMetrics;
  /**
   * #task:1982 W4 — the `/readyz` write probe as a capability, so the HTTP
   * layer renders `db_writable` without holding the driver handle or knowing
   * which dialect's lock statements answer the question.
   */
  dbWriteProbe: DbWriteProbe;
  /**
   * #task:1983 W3 — the fact source `permissions.ts` decides on, as a
   * driver-free port instead of a raw handle it builds repos from. It is that
   * module's PRIVATE surface: no other production file may read this field
   * (Gate 8), because authorization's minimal read set is not a general
   * repository — a route that needs a row asks its own port for it.
   */
  authorizationReads: AuthorizationReadPort;
  deploymentMode: BackendDeploymentMode;
  readiness: {
    migrationsApplied: boolean;
    listenReady: boolean;
    /**
     * Flips `true` once the
     * `OutboundRuntimeEventFanout` is constructed and registered as the
     * `HostWsServer`'s `eventSink`. Strictly a **backend-side wiring
     * indicator** — not a signal that any daemon host has connected
     * over the outbound WebSocket. The daemon-side connection lifecycle
     * is reported through `HostWsServerController.getAttachment(...)`
     * and is independent of this flag.
     *
     * Embedded mode still omits this from `/readyz`: the app-managed
     * co-located host uses the local Unix-socket transport, while
     * user-managed daemon computers attach over WS. Readiness should not
     * imply that either transport has an attached daemon.
     */
    outboundEventFanoutInstalled: boolean;
  };
  serverConfig: ServerConfig;
  /**
   * D4.a Commit 4 — classification of the address the backend
   * is bound to. Surfaced on `/api/server/info` so desktop / ops
   * tooling can read `(signup_enabled, bind_address_scope)`
   * together, and used at boot to decide whether to emit the
   * "non-loopback bind + signup enabled" WARN line.
   *
   * Derived once at boot via `classifyBindAddressScope(listenHostname)`;
   * stored on the context so handlers don't re-derive (the
   * classification is deterministic but pinning it once at boot
   * keeps the log line and the response surface consistent for the
   * life of the process).
   */
  bindAddressScope: BindAddressScope;
  /** Auth/setup config resolved once during backend startup. */
  authConfig: AuthRuntimeConfig;
  /** Embedded-only one-shot session bootstrap state for this backend boot. */
  embeddedBootstrap: EmbeddedBootstrapState;
  logger: BackendLogger;
  /** Categorized sinks. Always present; defaults to `{ system, agent,
   *  cli } = { logger, logger, logger }` when no file logger is in use
   *  (e.g. tests). */
  loggers: BackendLoggers;
  /** Shared log-level and per-conversation temporary debug-window state. */
  logControl: LogLevelControl;
  /** Directory where the file logger writes. Optional — undefined when no
   *  file logger is in use (e.g. in tests). */
  logDir?: string;
  /** Shared blob/file storage infra used by application layers like
   *  message attachments and future profile avatars. */
  blobStorage: BlobFileStorage;
  /** Application layer over `blobStorage` that knows about channels,
   *  threads, message snapshots, and access policy. */
  attachmentService: AttachmentService;
  /** Application layer that owns the agent avatar blob lifecycle
   *  (write/clear/serve). Mirrors `userService` but scoped to
   *  `agents.avatar_storage_key` / `avatar_content_type`. */
  agentService: AgentService;
  /** Application layer that owns user profile reads / updates / avatar
   *  blob lifecycle. Backed by `UserRepo` + `BlobFileStorage`. */
  userService: UserService;
  /** Application layer that owns channel create / pin / unpin side effects. */
  channelService: ChannelService;
  /** Application layer that owns user/agent send-message side effects. */
  conversationMessageService: ConversationMessageService;
  /** Application layer that owns task create / claim / unclaim / status side effects. */
  taskService: TaskService;
  /** Agent-owned cron-like scheduler. Owns its own setInterval/setTimeout
   *  lifecycle; `start()`/`stop()` bracket the backend process. */
  scheduleService: ScheduleService;
  /** Process-local idle runtime reaper. Owns its own setInterval lifecycle. */
  idleReaperService: IdleReaperService;
  /** In-process pub/sub for live UI updates. */
  events: ScopeEventBus;
  /** Process-local projection of live human event-WS connections. */
  presence: PresenceRegistry;
  /** How the per-spawn PATH shim should invoke the Silverhand CLI. */
  silverhandCliLauncher: SilverhandCliLauncher | null;
  /** Per-process bearer tokens scoped to one agent/conversation runtime. */
  agentTokens: AgentTokenStore;
  /** Password credential storage and verification. */
  passwordCredentials: PasswordCredentialService;
  /** User session token issuer/validator. */
  authSessions: AuthSessionService;
  /** Shared B.3 host-placement guard for create, membership, and runtime intent paths. */
  placement: RuntimeHostPlacementControl;
  /** Late-bound outbound host WebSocket controller for user-managed daemon transport. */
  hostWsController?: () => HostWsServerController | null;
  /**
   * The EXACT host id that shares the backend's own disk. Set ONLY in
   * embedded mode (= `HostRepo.ensureLocal()` — the single `local`-named
   * host the desktop runs on); `undefined` in standalone (the backend is
   * remote, co-located with no host).
   *
   * D4.e-1 3b introduced this to gate server-side L2 seeding to the
   * co-located host. D4.e-3 made L2 seeding daemon-mediated
   * (`agent_l2_seed`), so that create gate is GONE — the owning daemon now
   * writes its OWN host-local L2 in every mode. The field stays as the
   * identity of "the host on this machine" for diagnostics and any future
   * co-location-aware logic; it is no longer a correctness gate.
   */
  coLocatedHostId?: string;
  /**
   * D5.a-3 P1-3 — late-bound formal server↔daemon dispatch port. Routes
   * that send commands (POST /api/agents materialize, retry) go through
   * this accessor so they never branch on deployment mode. Standalone
   * resolves to a WSS-backed adapter; embedded resolves to a composite
   * adapter (co-located app-managed host over Unix socket + user-managed
   * computers over WSS). Distinct from `hostWsController`, which remains
   * the WS lifecycle/control port for user-managed computers.
   */
  outboundFrameAdapter?: () => OutboundFrameAdapter | null;
  /**
   * #task:2043 B — the availability-invalidation effect edges. Availability
   * (`GET /api/agents/:id/availability` = host reachability × agent validity)
   * moves on a transition of EITHER fact, so there are two edges over ONE
   * per-agent primitive; both are optional (a harness without a fanout leaves
   * them absent and the transitions simply publish nothing):
   *
   *  - {@link publishAgentAvailabilityChangedForAgent}: the per-agent primitive,
   *    fired at the AGENT-VALIDITY edge — `deletion_started_at` flips
   *    null→timestamp at `deleteAgent`'s `begin`. Teardown neither disconnects
   *    the transport nor revokes the host, so the host edge below would never
   *    announce it; without this edge a viewer that cached `online` gets no
   *    invalidation until the eventual hard-delete's `agent_changed`.
   *  - {@link publishAgentAvailabilityChangedForHost}: the HOST-REACHABILITY
   *    edge — enumerates the host's agents and fires the per-agent primitive for
   *    each. Called by BOTH transport attach seams (WSS + embedded Unix) AND the
   *    host-revoke authority at its post-commit edge, so the invalidation is
   *    driven by the fact transition, never inferred from socket teardown
   *    (embedded local hosts have no host-WS connection to tear down).
   */
  publishAgentAvailabilityChangedForAgent?: (agentId: string) => void;
  publishAgentAvailabilityChangedForHost?: (hostId: string) => void;
  /**
   * #task:2049 — the presence-invalidation effect edge. Fired ONLY on an
   * Away→Online transition (an agent past its away deadline producing real
   * runtime activity again), driven by the presence-clock stamp in
   * `AgentActivitySink`. Per-agent only (there is no host-wide presence edge:
   * presence is a per-agent activity fact, not a shared host-reachability one).
   * Optional: a harness without a fanout leaves it absent and the transition
   * publishes nothing. Pairs with `GET /api/agents/:id/presence`.
   */
  publishAgentPresenceChangedForAgent?: (agentId: string) => void;
  /**
   * #task:1588 — late-bound per-host liveness view from the outbound
   * event fanout (event-maintained, generation-bound). The host-status
   * read model consumes it so `GET /api/hosts/:id/status` serves the
   * active-agent set from memory instead of RPCing the daemon per
   * read. Optional: a harness without a fanout leaves it absent and
   * the read model falls back to its per-generation seed.
   */
  hostRuntimeView?: (hostId: string) => HostRuntimeActivityView | null;
  /**
   * #task:1588 slice 2 — the process-wide host-status read model
   * (generation-bound seeds + event-maintained liveness). The hosts
   * route reads `/status` through it; the composition root eager-seeds
   * it on daemon attach. Optional: a route harness without the
   * composition root constructs a local instance instead.
   */
  hostStatusReadModel?: () => HostStatusReadModel;
  /**
   * Cross-computer slice 1 (#task:1596) — pre-spawn agent L2 seed on the
   * dispatch host (idempotent daemon `agent_l2_seed`, memoized per
   * (host, workspace, agent)). Consumed by the runtime start/deliver
   * filesystem-ensure chain. Optional, and its absence is NOT a spawn gate
   * (relocation-v1 §7-4): a minimal embedded boot or a test harness that omits
   * it just spawns without the L2 enrichment, recorded as a diagnostic.
   */
  agentL2SeedEnsurer?: AgentL2SeedEnsurer;
  /**
   * Backend-side facade for agent runtime lifecycle. Services and
   * routes route every spawn / stop / deliver / clearSession / inbox
   * delivery / run-state read through this single interface.
   *
   * Both embedded and standalone use `OutboundAgentRuntimeHost`; the
   * deployment-specific adapter underneath chooses the attached host
   * transport by host id.
   */
  runtimeHost: AgentRuntimeHost;
}

export const consoleLogger: BackendLogger = {
  info: (obj, msg) => console.log('[backend]', msg ?? '', obj),
  warn: (obj, msg) => console.warn('[backend]', msg ?? '', obj),
  error: (obj, msg) => console.error('[backend]', msg ?? '', obj),
};
