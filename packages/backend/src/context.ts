import type { Database as Db } from 'better-sqlite3';
import type { ServerConfig } from '@silverhand/shared';
import type { ScopeEventBus } from './ws/scope-event-bus.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import type { AttachmentService } from './services/attachment-service.js';
import type { AgentService } from './services/agent-service.js';
import type { ChannelService } from './services/channel-service.js';
import type { ConversationMessageService } from './services/conversation-message-service.js';
import type { ScheduleService } from './services/schedule-service.js';
import type { TaskService } from './services/task-service.js';
import type { ThreadService } from './services/thread-service.js';
import type { UserService } from './services/user-service.js';
import type { BlobFileStorage } from './storage/blob-file-storage.js';
import type { AgentTokenStore } from './auth/agent-token-store.js';
import type { AuthRuntimeConfig } from './auth/config.js';
import type { EmbeddedBootstrapState } from './auth/embedded-bootstrap.js';
import type { PasswordCredentialService } from './auth/password.js';
import type { AuthSessionService } from './auth/session.js';
import type { LogLevelControl } from './logger.js';
import type { RuntimeHostPlacementControl } from './runtime/host-placement.js';
import type { HostWsServerController } from './ws/host-ws-server.js';

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
 *   - `agent`:  agent runtime spawn / drain / exit / compaction (now
 *               owned by silverhand-daemon and surfaced through
 *               `DaemonAgentRuntimeHost` + `RuntimeEventHandler`).
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
 * Host-supplied way to launch the `silverhand` CLI.
 *
 * The runtime host (`DaemonAgentRuntimeHost`, via the per-spawn prep
 * in `silverhand-daemon`) creates a per-spawn `bin/silverhand` shim
 * that forwards to this launcher so the agent sees one stable command
 * name on PATH in both dev and packaged builds.
 */
export interface SilverhandCliLauncher {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface BackendContext {
  db: Db;
  deploymentMode: BackendDeploymentMode;
  readiness: {
    migrationsApplied: boolean;
    listenReady: boolean;
    /**
     * Standalone-only: flips `true` once the
     * `OutboundRuntimeEventFanout` is constructed and registered as the
     * `HostWsServer`'s `eventSink`. Strictly a **backend-side wiring
     * indicator** — not a signal that any daemon host has connected
     * over the outbound WebSocket. The daemon-side connection lifecycle
     * is reported through `HostWsServerController.getAttachment(...)`
     * (added in D3.a Commit 1) and is independent of this flag.
     *
     * Embedded mode intentionally never wires this fanout (runtime
     * events flow over Unix-socket IPC) and therefore must NOT include
     * this check in `/readyz`; including it would deadlock embedded
     * readiness forever. `readinessResponse` switches on
     * `deploymentMode` for that reason.
     */
    outboundEventFanoutInstalled: boolean;
  };
  serverConfig: ServerConfig;
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
  /** Root for all silverhand state (`~/.silverhand`). */
  silverhandDir: string;
  /** `<silverhandDir>/workspaces/` — root for auto-generated channel workspaces. */
  workspacesRoot: string;
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
  /** Application layer that owns thread create / close side effects. */
  threadService: ThreadService;
  /** Application layer that owns task create / claim / unclaim / status side effects. */
  taskService: TaskService;
  /** Agent-owned cron-like scheduler. Owns its own setInterval/setTimeout
   *  lifecycle; `start()`/`stop()` bracket the backend process. */
  scheduleService: ScheduleService;
  /** Per-process state: last child-conversation spawn timestamp per agent (cooldown). */
  lastSpawnAtByAgent: Map<string, number>;
  /** In-process pub/sub for live UI updates. */
  events: ScopeEventBus;
  /** How the per-spawn PATH shim should invoke the Silverhand CLI. */
  silverhandCliLauncher: SilverhandCliLauncher;
  /** Per-process bearer tokens scoped to one agent/conversation runtime. */
  agentTokens: AgentTokenStore;
  /** Password credential storage and verification. */
  passwordCredentials: PasswordCredentialService;
  /** User session token issuer/validator. */
  authSessions: AuthSessionService;
  /** Shared B.3 host-placement guard for create, membership, and runtime intent paths. */
  placement: RuntimeHostPlacementControl;
  /** Late-bound outbound host WebSocket controller for standalone daemon transport. */
  hostWsController?: () => HostWsServerController | null;
  /**
   * Backend-side facade for agent runtime lifecycle. Services and
   * routes route every spawn / stop / wake / clearSession / inbox
   * delivery / run-state read through this single interface.
   *
   * Embedded mode uses `DaemonAgentRuntimeHost` (silverhand-daemon
   * over `RuntimeBridge`). Standalone mode uses a fail-loud
   * control-plane-only implementation until D2 daemon outbound exists.
   */
  runtimeHost: AgentRuntimeHost;
}

export const consoleLogger: BackendLogger = {
  info: (obj, msg) => console.log('[backend]', msg ?? '', obj),
  warn: (obj, msg) => console.warn('[backend]', msg ?? '', obj),
  error: (obj, msg) => console.error('[backend]', msg ?? '', obj),
};
