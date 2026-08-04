import type { Database as Db } from 'better-sqlite3';
import type { BindAddressScope, ServerConfig } from '@silverhand/shared';
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

export interface BackendContext {
  db: Db;
  /** Optional process-local Prometheus registry. Disabled unless an operator
   * explicitly configures the private metrics listener. */
  metrics?: BackendMetrics;
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
