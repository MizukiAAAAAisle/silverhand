import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { silverhandCors } from './cors.js';
import { openDatabase } from './db.js';
import type { MigrationRunResult } from './db.js';
import { createApiRouter, createInternalRouter } from './routes.js';
import type { AppEnv } from './auth/principal.js';
import {
  consoleLogger,
  type BackendDeploymentMode,
  type BackendContext,
  type BackendLogger,
  type BackendLoggers,
  type SilverhandCliLauncher,
} from './context.js';
import { AgentTokenStore } from './auth/agent-token-store.js';
import { resolveAuthRuntimeConfig } from './auth/config.js';
import {
  cleanupEmbeddedBootstrap,
  createDisabledEmbeddedBootstrapState,
  prepareEmbeddedBootstrap,
} from './auth/embedded-bootstrap.js';
import { PasswordCredentialService } from './auth/password.js';
import { AuthSessionService } from './auth/session.js';
import { HostRepo } from './repos/host-repo.js';
import { ensureWorkspacesRoot } from './provision.js';
import { ScopeEventBus } from './ws/scope-event-bus.js';
import {
  installEventWebSocketServer,
  type EventWsServerController,
} from './ws/ws-server.js';
import {
  installHostWebSocketServer,
  type HostWsServerController,
  type HostWsAttachment,
} from './ws/host-ws-server.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import { ControlPlaneRuntimeHost } from './runtime/control-plane-runtime-host.js';
import { OutboundRuntimeEventFanout } from './runtime/outbound-event-fanout.js';
import {
  DisabledRuntimeHostPlacement,
  RuntimeHostPlacementResolver,
} from './runtime/host-placement.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { ScheduleRepo } from './repos/schedule-repo.js';
import { SETTINGS_KEYS, SettingsRepo } from './repos/settings-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { AttachmentService } from './services/attachment-service.js';
import { AgentService } from './services/agent-service.js';
import { ChannelService } from './services/channel-service.js';
import { ConversationMessageService } from './services/conversation-message-service.js';
import { ScheduleService } from './services/schedule-service.js';
import { ThreadService } from './services/thread-service.js';
import { TaskService } from './services/task-service.js';
import { UserService } from './services/user-service.js';
import { UserRepo } from './repos/user-repo.js';
import { createLocalBlobFileStorage } from './storage/blob-file-storage.js';
import type { ServerConfig } from '@silverhand/shared';
import type { HostClient } from '@silverhand/host';
import type { Server as HttpServer } from 'node:http';
import { createLogLevelControl, type LogLevelControl } from './logger.js';
import type { AuthRuntimeConfig } from './auth/config.js';

export interface BackendListenOptions {
  hostname: string;
  port: number;
}

interface BaseBackendOptions {
  mode: BackendDeploymentMode;
  dbPath: string;
  silverhandDir: string;
  serverConfig: ServerConfig;
  silverhandCliLauncher?: SilverhandCliLauncher;
  listen?: BackendListenOptions;
  authConfig?: AuthRuntimeConfig;
  logger?: BackendLogger;
  /** Categorized loggers (system + agent + cli sinks). When provided
   *  this overrides whatever `logger` was passed; missing categories
   *  fall back to `logger` so callers can opt in incrementally. */
  loggers?: Partial<BackendLoggers>;
  /** Where the file logger writes. Optional. */
  logDir?: string;
  schemaUpgrade?: {
    allow: boolean;
  };
}

export interface EmbeddedBackendOptions extends BaseBackendOptions {
  mode: 'embedded';
  silverhandCliLauncher: SilverhandCliLauncher;
  /**
   * Connected `silverhand-daemon` client. **Required.** Backend
   * routes every spawn / wake / clearSession / inbox delivery /
   * run-state read through this client; without it the boot throws.
   * Legacy in-process spawn was removed in #task:512 cleanup
   * Commit B and the env switch in Commit C — there is no embedded
   * runtime fallback.
   */
  hostClient: HostClient;
}

export interface StandaloneBackendOptions extends BaseBackendOptions {
  mode: 'standalone';
  hostClient?: never;
}

export type CreateBackendOptions = EmbeddedBackendOptions | StandaloneBackendOptions;

export interface RunningBackend {
  url: string;
  port: number;
  context: BackendContext;
  close(): Promise<void>;
}

export async function startBackend(opts: CreateBackendOptions): Promise<RunningBackend> {
  const listenHostname = opts.listen?.hostname ?? '127.0.0.1';
  const listenPort = opts.listen?.port ?? 0;
  const logger = opts.logger ?? consoleLogger;
  const silverhandCliLauncher =
    opts.silverhandCliLauncher ?? DISABLED_SILVERHAND_CLI_LAUNCHER;
  const loggers: BackendLoggers = {
    system: opts.loggers?.system ?? logger,
    agent: opts.loggers?.agent ?? logger,
    cli: opts.loggers?.cli ?? logger,
  };
  const logControl = resolveLogControl(loggers.system);
  const authConfig = opts.authConfig ?? resolveAuthRuntimeConfig();
  logger.info(
    {
      mode: opts.mode,
      listenHostname,
      listenPort,
      signupEnabled: authConfig.signupEnabled,
    },
    `Backend boot: mode=${opts.mode}; signup=${authConfig.signupEnabled ? 'enabled' : 'disabled'}`,
  );
  let migrationsApplied = false;
  const migrationResult: { current: MigrationRunResult | null } = { current: null };
  const migrationStartedAt = performance.now();
  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(opts.dbPath, {
      allowSchemaUpgrade: opts.schemaUpgrade?.allow ?? false,
      onMigrationResult: result => {
        migrationResult.current = result;
      },
      onMigrationsApplied: () => {
        migrationsApplied = true;
      },
    });
  } catch (err) {
    logger.error(
      {
        code: migrationErrorCode(err),
        error: errorMessage(err),
        elapsedMs: elapsedSince(migrationStartedAt),
      },
      'Migration aborted',
    );
    throw err;
  }
  if (
    migrationResult.current
    && migrationResult.current.appliedVersions.length > 0
  ) {
    logger.info(
      {
        fromVersion: migrationResult.current.beforeVersion,
        toVersion: migrationResult.current.afterVersion,
        appliedVersions: migrationResult.current.appliedVersions,
        backupPath: migrationResult.current.backupPath,
        elapsedMs: elapsedSince(migrationStartedAt),
      },
      `Migration applied: v${migrationResult.current.beforeVersion} -> v${migrationResult.current.afterVersion}, backup at ${migrationResult.current.backupPath ?? 'none'}`,
    );
  }
  const workspacesRoot = join(opts.silverhandDir, 'workspaces');
  const blobStorage = createLocalBlobFileStorage({ silverhandDir: opts.silverhandDir });
  await ensureWorkspacesRoot(workspacesRoot);
  await blobStorage.ensureReady();

  if (opts.mode === 'embedded') {
    assertLauncherResolvable(silverhandCliLauncher.command, 'silverhand CLI');
  }

  // Bootstrap: embedded desktop owns the local daemon-host identity.
  // Standalone server must not synthesize a local host that implies
  // access to the user's machine.
  const hostRepo = new HostRepo(db);
  if (opts.mode === 'embedded') {
    hostRepo.ensureLocal();
  } else {
    hostRepo.ensureStandaloneServer();
  }

  const attachmentService = new AttachmentService({
    storage: blobStorage,
    attachments: new AttachmentRepo(db),
    conversations: new ConversationRepo(db),
  });

  const userService = new UserService({
    db,
    users: new UserRepo(db),
    blobStorage,
  });

  const agentService = new AgentService({
    agents: new AgentRepo(db),
    blobStorage,
  });
  const placement = new RuntimeHostPlacementResolver({
    hosts: new HostRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
  });
  let outboundFanout: OutboundRuntimeEventFanout | null = null;
  let hostWs: HostWsServerController | null = null;

  const ctx: BackendContext = {
    db,
    deploymentMode: opts.mode,
    readiness: {
      migrationsApplied,
      listenReady: false,
      outboundEventFanoutInstalled: false,
    },
    serverConfig: opts.serverConfig,
    authConfig,
    embeddedBootstrap: createDisabledEmbeddedBootstrapState(opts.silverhandDir),
    logger,
    loggers,
    logControl,
    silverhandDir: opts.silverhandDir,
    workspacesRoot,
    logDir: opts.logDir,
    blobStorage,
    attachmentService,
    agentService,
    userService,
    channelService: undefined as unknown as ChannelService,
    conversationMessageService: undefined as unknown as ConversationMessageService,
    threadService: undefined as unknown as ThreadService,
    taskService: undefined as unknown as TaskService,
    scheduleService: undefined as unknown as ScheduleService,
    lastSpawnAtByAgent: new Map(),
    events: new ScopeEventBus(),
    silverhandCliLauncher,
    agentTokens: new AgentTokenStore(),
    passwordCredentials: new PasswordCredentialService(db),
    authSessions: new AuthSessionService(db, {
      sessionTtlMs: authConfig.sessionTtlMs,
    }),
    placement:
      opts.mode === 'embedded'
        ? placement
        : new DisabledRuntimeHostPlacement(),
    hostWsController: () => hostWs,
    // Filled immediately below when the daemon runtime host is constructed.
    runtimeHost: undefined as unknown as AgentRuntimeHost,
  };
  // ── Runtime host wiring ─────────────────────────────────────────
  if (opts.mode === 'embedded') {
    const { createDaemonRuntimeHost } = await import('./runtime/daemon-runtime-wiring.js');
    ctx.runtimeHost = createDaemonRuntimeHost({
      ctx,
      db,
      hostClient: opts.hostClient,
      logger,
      silverhandDir: opts.silverhandDir,
      workspacesRoot,
      silverhandCliLauncher,
    });
    logger.info(
      { runtime: 'daemon' },
      'agent runtime: silverhand-daemon',
    );
  } else {
    ctx.runtimeHost = new ControlPlaneRuntimeHost(logger, () => outboundFanout);
    logger.warn(
      { runtime: 'control-plane-only' },
      'agent runtime: disabled in standalone server mode',
    );
  }

  ctx.channelService = new ChannelService({
    db,
    conversations: new ConversationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    agents: new AgentRepo(db),
    messages: new MessageRepo(db),
    events: ctx.events,
    runtimeHost: ctx.runtimeHost,
    logger,
  });
  ctx.conversationMessageService = new ConversationMessageService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    users: new UserRepo(db),
    notifications: new NotificationRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    attachmentService,
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
  });
  ctx.threadService = new ThreadService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
    serverConfig: () => ctx.serverConfig,
    lastSpawnAtByAgent: ctx.lastSpawnAtByAgent,
    // Late-bound: TaskService is constructed below.
    taskService: () => ctx.taskService,
  });
  ctx.taskService = new TaskService({
    db,
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
  });
  ctx.scheduleService = new ScheduleService({
    schedules: new ScheduleRepo(db),
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    agents: new AgentRepo(db),
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
  });
  // Boot recovery (daemon hydrate from `runtime_status` then diff
  // stale DB rows). Scheduling waits until reconcile lands so any
  // handles brought back are visible to the first wake delivery.
  await ctx.runtimeHost.reconcileOnBoot();
  ctx.scheduleService.start();
  const stopEventLoopLagProbe = startEventLoopLagProbe(logger);

  if (opts.mode === 'embedded') {
    // Daemon liveness ping. The daemon shim's first real call will
    // surface a disconnect more concretely than the ping; this is a
    // best-effort smoke confirming the IPC channel is alive at boot.
    try {
      const ping = await opts.hostClient.ping();
      logger.info(
        {
          daemon_pid: ping.daemon_pid,
          daemon_version: ping.daemon_version,
          started_at: ping.started_at,
        },
        'silverhand-daemon ping ok',
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'silverhand-daemon ping failed at boot',
      );
    }
  }

  ctx.embeddedBootstrap = await prepareEmbeddedBootstrap({
    silverhandDir: opts.silverhandDir,
    serverConfig: ctx.serverConfig,
    listenHostname,
    logger,
  });
  logger.info(
    {
      enabled: ctx.embeddedBootstrap.enabled,
      reason: ctx.embeddedBootstrap.reason,
      listenHostname,
    },
    ctx.embeddedBootstrap.enabled
      ? 'Embedded bootstrap: enabled (loopback)'
      : 'Embedded bootstrap: disabled',
  );

  const app = new Hono<AppEnv>();
  app.use('*', silverhandCors());
  app.route('/', createApiRouter(ctx));
  app.route('/', createInternalRouter(ctx));

  return new Promise<RunningBackend>((resolve, reject) => {
    let eventWs: EventWsServerController | null = null;
    const server = serve(
      { fetch: app.fetch, hostname: listenHostname, port: listenPort },
      info => {
        const address = info as AddressInfo;
        const port = address.port;
        const url = urlForListenAddress(listenHostname, port);
        ctx.serverConfig = { ...opts.serverConfig, url };
        ctx.readiness.listenReady = true;
        logger.info({ url, listenHostname, port }, 'backend listening');
        resolve({
          url,
          port,
          context: ctx,
          close: async () => {
            stopEventLoopLagProbe();
            // Stop the scheduler before any agent shutdown so we don't
            // race a fire mid-teardown (would write to a dying CM).
            ctx.scheduleService.stop();
            // Phase 1: stop all agents (must finish before activity-log flush
            // so terminal events are written before the stream closes).
            await ctx.runtimeHost.stopAll().catch(() => undefined);

            // Phase 2: close WS lifecycle before the HTTP drain removes sockets.
            await Promise.all([
              eventWs?.close(),
              hostWs?.close(),
            ]);
            await outboundFanout?.close();
            await cleanupEmbeddedBootstrap(ctx.embeddedBootstrap, logger);

            // Phase 3: flush activity log AND drain the HTTP server
            // concurrently — they are independent of each other.
            //
            // Order matters for the server drain:
            //   1. `server.close()` first — stops accepting new connections
            //      immediately, so no new HTTP work can sneak in.
            //   2. `closeAllConnections()` second — terminates all existing
            //      sockets so `server.close()` resolves right away.
            // The `in` guard handles the Http2Server union member which lacks
            // this method (we always use HTTP/1.1, but the type is a union).
            const serverDrained = new Promise<void>(res => server.close(() => res()));
            if ('closeAllConnections' in server) server.closeAllConnections();
            await Promise.allSettled([
              ctx.runtimeHost.closeActivityLog(),
              serverDrained,
            ]);

            // Phase 4: close the DB. At this point all connections —
            // including in-flight HTTP requests — have been forcibly
            // terminated by closeAllConnections(). Strict in-flight write
            // safety is sacrificed for a clean quit; if that becomes a
            // concern, use route-specific request tracking before this point.
            db.close();
          },
        });
      },
    );
    eventWs = installEventWebSocketServer(server as HttpServer, ctx);
    if (opts.mode === 'standalone') {
      const settings = new SettingsRepo(db);
      // Order is intentional: construct the fanout, then — only after
      // the constructor returns without throwing — flip the readiness
      // bit, then install the WS server with the fanout as `eventSink`.
      // A throw inside the constructor must leave
      // `outboundEventFanoutInstalled === false` so `/readyz` keeps
      // returning 503 and orchestrators do not promote a half-wired
      // backend to "ready". This flag is a backend-side wiring
      // indicator only; the daemon-side WS attachment lifecycle is
      // reported separately through `HostWsServerController.getAttachment`.
      outboundFanout = new OutboundRuntimeEventFanout({
        db,
        events: ctx.events,
        transport: () => hostWs,
        logger,
        silverhandDir: ctx.silverhandDir,
        workspacesRoot,
        silverhandCli: ctx.silverhandCliLauncher,
        agentTokens: ctx.agentTokens,
        serverUrl: () => ctx.serverConfig.url,
        proxyPolicy: () => ({
          url: settings.get(SETTINGS_KEYS.PROXY_URL),
          allowlist: settings.getProxyRuntimes(),
        }),
        logDir: ctx.logDir,
      });
      ctx.readiness.outboundEventFanoutInstalled = true;
    }
    hostWs = installHostWebSocketServer(server as HttpServer, ctx, {
      eventSink: outboundFanout ?? undefined,
    });
    server.on('error', reject);
  });
}

export type {
  BackendContext,
  BackendDeploymentMode,
  BackendLogger,
  BackendLoggers,
} from './context.js';
export type {
  HostWsAttachment,
  HostWsServerController,
} from './ws/host-ws-server.js';
export type { AuthRuntimeConfig } from './auth/config.js';
export { resolveAuthRuntimeConfig } from './auth/config.js';
export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
} from '@silverhand/shared';
export {
  DatabaseMigrationError,
  currentSchemaVersion,
  type DatabaseMigrationErrorCode,
  type MigrationBackupInfo,
  type MigrationRunResult,
  type OpenDatabaseOptions,
  type RunMigrationsOptions,
} from './db.js';
export {
  AdminResetPasswordError,
  resetAdminPassword,
  type AdminResetPasswordErrorCode,
  type AdminResetPasswordOptions,
} from './admin.js';

export {
  createCategorizedLoggers,
  createFileLogger,
  createLogLevelControl,
  type CategorizedLoggers,
  type FileLogger,
  type FileLoggerOptions,
  type LogLevelControl,
} from './logger.js';

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function migrationErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code?: unknown }).code);
  }
  return 'migration_failed';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const DISABLED_SILVERHAND_CLI_LAUNCHER: SilverhandCliLauncher = {
  command: 'silverhand',
  args: [],
};

function resolveLogControl(logger: BackendLogger): LogLevelControl {
  const candidate = logger as BackendLogger & { logControl?: LogLevelControl };
  return candidate.logControl ?? createLogLevelControl();
}

function urlForListenAddress(hostname: string, port: number): string {
  const host = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return `http://${host}:${port}`;
}

function assertLauncherResolvable(command: string, label = 'launcher'): void {
  if (isAbsolute(command)) {
    if (!existsSync(command)) {
      throw new Error(
        `${label} not found: ${command}. ` +
          `Without it agents may be unable to use Silverhand runtime actions.`,
      );
    }
    return;
  }
  // Bare name — probe PATH. `command -v` is POSIX shell syntax, so use
  // `which` on Unix and `where` on Windows. We avoid spawning a shell
  // (no PATH-injection vector); execFileSync throws on non-zero exit.
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [command], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `${label} \`${command}\` is not on PATH. ` +
        `Without it agents may be unable to use Silverhand runtime actions.`,
    );
  }
}

const EVENT_LOOP_LAG_INTERVAL_MS = 500;
const EVENT_LOOP_LAG_WARN_MS = 250;

function startEventLoopLagProbe(logger: BackendLogger): () => void {
  let expectedAt = performance.now() + EVENT_LOOP_LAG_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = now - expectedAt;
    expectedAt = now + EVENT_LOOP_LAG_INTERVAL_MS;
    if (lagMs >= EVENT_LOOP_LAG_WARN_MS) {
      logger.warn(
        {
          lagMs: roundMs(lagMs),
          intervalMs: EVENT_LOOP_LAG_INTERVAL_MS,
          thresholdMs: EVENT_LOOP_LAG_WARN_MS,
        },
        'backend: event loop lag detected',
      );
    }
  }, EVENT_LOOP_LAG_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function roundMs(ms: number): number {
  return Math.round(ms * 10) / 10;
}
