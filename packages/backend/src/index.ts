import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { Database as Db } from 'better-sqlite3';
import { silverhandCors } from './cors.js';
import { openDatabase } from './db.js';
import type { MigrationRunResult } from './db.js';
import { createApiRouter } from './routes.js';
import {
  ConversationTitleAddressDefectError,
  scanConversationTitleAddresses,
} from './read-model/conversation-title-audit.js';
import {
  WorkspaceNameAddressDefectError,
  scanWorkspaceNameAddresses,
} from './read-model/workspace-name-audit.js';
import { createInternalRouter } from './routes/internal-agent.js';
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
import { canAgentUseCapability, canPostToConversation } from './permissions.js';
import { resolveAuthRuntimeConfig } from './auth/config.js';
import {
  cleanupEmbeddedBootstrap,
  createDisabledEmbeddedBootstrapState,
  prepareEmbeddedBootstrap,
} from './auth/embedded-bootstrap.js';
import { PasswordCredentialService } from './auth/password.js';
import { AuthSessionService } from './auth/session.js';
import { createBackendPersistence } from './persistence/root.js';
import { HostTokenService } from './auth/host-token.js';
import { ScopeEventBus } from './ws/scope-event-bus.js';
import { PresenceRegistry } from './presence/presence-registry.js';
import {
  installEventWebSocketServer,
  type EventWsServerController,
} from './ws/ws-server.js';
import {
  installHostWebSocketServer,
  type HostWsServerController,
  type HostWsEventSink,
} from './ws/host-ws-server.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import { OutboundAgentRuntimeHost } from './runtime/outbound-agent-runtime-host.js';
import { OutboundRuntimeEventFanout } from './runtime/outbound-event-fanout.js';
import { HostStatusReadModel } from './runtime/host-status-read-model.js';
import {
  CompositeOutboundFrameAdapter,
  StandaloneOutboundFrameAdapter,
  type OutboundFrameAdapter,
} from './runtime/outbound-frame-adapter.js';
import { EmbeddedUnixOutboundFrameAdapter } from './runtime/embedded-unix-outbound-frame-adapter.js';
import { DeletionAwareOutboundFrameAdapter } from './runtime/deletion-aware-outbound-frame-adapter.js';
import { AgentDeletionResumer } from './application/agent-deletion-resumer.js';
import {
  type AgentAvailabilityChangedDeps,
  publishAgentAvailabilityChangedForHost,
} from './application/agent-availability-changed.js';
import { sweepStoredBlobs } from './application/delete-agent.js';
import { RuntimeHostPlacementResolver } from './runtime/host-placement.js';
import { runBootMaterializeReconciler } from './runtime/materialize-reconciler.js';
import { AgentL2SeedEnsurer } from './runtime/agent-l2-seed-ensurer.js';
import { AttachmentService } from './services/attachment-service.js';
import { AgentService } from './services/agent-service.js';
import { ChannelService } from './services/channel-service.js';
import { ConversationMessageService } from './services/conversation-message-service.js';
import { ScheduleService } from './services/schedule-service.js';
import { IdleReaperService } from './services/idle-reaper-service.js';
import { TaskService } from './services/task-service.js';
import { UserService } from './services/user-service.js';
import { createLocalBlobFileStorage } from './storage/blob-file-storage.js';
import {
  classifyBindAddressScope,
  describeConversationTitleAudit,
  HOST_CONNECTION_CHANGED_EVENT,
  type BindAddressScope,
  type ServerConfig,
} from '@silverhand/shared';
import { deriveLocalOutboundFrameSocketPath } from '@silverhand/host';
import type { Server as HttpServer } from 'node:http';
import { createLogLevelControl, type LogLevelControl } from './logger.js';
import type { AuthRuntimeConfig } from './auth/config.js';
import {
  BackendMetrics,
  startEventLoopHealthMonitor,
} from './observability/metrics.js';
import { configureDatabaseObservation } from './observability/observed-statement.js';
import { createSqliteDbWriteProbe } from './observability/db-write-probe.js';

export interface BackendListenOptions {
  hostname: string;
  port: number;
}

interface BaseBackendOptions {
  mode: BackendDeploymentMode;
  dbPath: string;
  /** #task:1598 — explicit app-data paths from the shared resolver; the
   *  overloaded `silverhandDir` root is retired (docs/app-data-layout-v2.md
   *  §3). */
  blobsRootDir: string;
  embeddedBootstrapPath: string;
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
  /** Pre-created registry shared by HTTP, DB, and transport instrumentation.
   * The caller owns the private metrics listener and registry lifecycle. */
  metrics?: BackendMetrics;
  /**
   * D4.b-1 — TEST ONLY. Wrap the `HostWsEventSink` installed on the
   * outbound WS server. The wrapper receives the real fanout (or
   * `undefined` in embedded mode where no fanout is installed) and
   * returns a sink that will be installed in its place. Production
   * callers MUST NOT pass this; the default behaviour is identity
   * (the real fanout flows through unchanged).
   *
   * Used by `packages/backend/tests/e2e/g2-harness.ts` to attach a
   * recording observer for parity / delivery assertions WITHOUT
   * bypassing the real `OutboundRuntimeEventFanout` — the wrapper
   * always delegates onEvent/onDisconnect to the real sink, so the
   * production projection path runs exactly as in shipped code.
   * The fanout instance is still the one constructed by this
   * `startBackend` call; the wrap does not change which class
   * processes the event, only adds a non-mutating observer.
   */
  testHooks?: {
    wrapHostWsEventSink?: (
      real: HostWsEventSink | undefined,
    ) => HostWsEventSink | undefined;
    /**
     * #task:1983 W5 — hands the just-opened, just-migrated driver handle to a
     * TEST harness. Production callers MUST NOT pass this, and now cannot get a
     * handle any other way: `BackendContext` no longer carries one and
     * `RunningBackend` never did, so this hook is the single labelled seam
     * instead of a field every consumer of the boot result would inherit.
     *
     * It exists because an end-to-end test boots the REAL server and then has to
     * assert on rows no repository exposes (or seed one no production writer
     * creates). The alternative — a second connection to the same file — would
     * add a live reader/writer that the scenarios under test (restart, crash
     * recovery, hard stop) do not have in production.
     *
     * The handle stays owned by boot: `close()` closes it, and a harness must
     * not close it itself.
     */
    onDatabaseOpened?: (db: Db) => void;
  };
}

export interface EmbeddedBackendOptions extends BaseBackendOptions {
  mode: 'embedded';
  silverhandCliLauncher: SilverhandCliLauncher;
  /**
   * Path to the daemon's local outbound frame socket
   * (`daemon-outbound.sock`). The backend dials this socket and speaks
   * the SAME outbound frame envelope the standalone WSS path uses (D5.a).
   * Optional — defaults to {@link deriveLocalOutboundFrameSocketPath}
   * (`~/.silverhand/run/daemon-outbound.sock`). The desktop main process
   * spawns the daemon with the matching `localOutboundSocketPath`.
   *
   * The embedded backend no longer holds a `HostClient`: the local
   * daemon RPC was a second expression of the same server↔daemon
   * semantics (the R4 drift D5.a closed). Host-control IPC (spawn the
   * daemon, revoke, etc.) stays in the desktop main process, not here.
   */
  outboundSocketPath?: string;
}

export interface StandaloneBackendOptions extends BaseBackendOptions {
  mode: 'standalone';
  outboundSocketPath?: never;
}

export type CreateBackendOptions =
  | EmbeddedBackendOptions
  | StandaloneBackendOptions;

export interface RunningBackend {
  url: string;
  port: number;
  /** Present only when the standalone private Prometheus listener is enabled. */
  metricsUrl?: string;
  context: BackendContext;
  close(): Promise<void>;
}

export async function startBackend(
  opts: CreateBackendOptions,
): Promise<RunningBackend> {
  const listenHostname = opts.listen?.hostname ?? '127.0.0.1';
  const listenPort = opts.listen?.port ?? 0;
  const logger = opts.logger ?? consoleLogger;
  const silverhandCliLauncher =
    opts.mode === 'embedded' ? opts.silverhandCliLauncher : null;
  const loggers: BackendLoggers = {
    system: opts.loggers?.system ?? logger,
    agent: opts.loggers?.agent ?? logger,
    cli: opts.loggers?.cli ?? logger,
  };
  const logControl = resolveLogControl(loggers.system);
  const authConfig = opts.authConfig ?? resolveAuthRuntimeConfig();
  // D4.a Commit 4 — classify the bind address once at boot. Pinning
  // the value on `ctx.bindAddressScope` keeps the boot-time WARN
  // line (below) and the `/api/server/info` response surface
  // consistent for the life of the process.
  const bindAddressScope: BindAddressScope =
    classifyBindAddressScope(listenHostname);
  logger.info(
    {
      mode: opts.mode,
      listenHostname,
      listenPort,
      signupEnabled: authConfig.signupEnabled,
      bindAddressScope,
    },
    `Backend boot: mode=${opts.mode}; signup=${authConfig.signupEnabled ? 'enabled' : 'disabled'}; bind=${bindAddressScope}`,
  );
  // §6.3 condition 3 — non-loopback bind + signup enabled is the
  // single combination that lets a passerby register on a backend
  // reachable beyond `127.0.0.1`. Emit a visible WARN that points
  // at the lock-down runbook so operators see it on first boot
  // and can either narrow the bind or set `SILVERHAND_DISABLE_SIGNUP=1`.
  if (bindAddressScope !== 'loopback' && authConfig.signupEnabled) {
    logger.warn(
      {
        listenHostname,
        bindAddressScope,
        signupEnabled: true,
        runbookSection: 'remote-backend-runbook §12 (lock-down)',
      },
      `Backend is bound to a ${bindAddressScope} address with signup ENABLED. ` +
        `Set SILVERHAND_DISABLE_SIGNUP=1 once your account is created. ` +
        `See remote-backend runbook §12 (lock-down).`,
    );
  }
  let migrationsApplied = false;
  const migrationResult: { current: MigrationRunResult | null } = {
    current: null,
  };
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
  // #task:1983 W5 — the one labelled seam a test harness may take the handle
  // through. After open + migrate, so a harness never sees a pre-migration
  // schema; before anything is composed on top of it.
  opts.testHooks?.onDatabaseOpened?.(db);
  if (
    migrationResult.current &&
    migrationResult.current.appliedVersions.length > 0
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
  // #task:2016 — the third of the three properties that make "no two channels
  // here show the same name" true. The unique index proves only that stored
  // `title_key`s differ; that they MEAN the titles differ is maintained by one
  // canonicalizer and one terminal writer, both of which are code, so the
  // half-state they would leave behind has to be discoverable at runtime rather
  // than only in CI. This runs after migrations (the just-migrated shape is the
  // one that gets audited) and BEFORE anything is composed on top of the handle.
  //
  // A clean database says nothing: the log's default level is `warn`, so an
  // `info` line would not reach the file it exists to be found in, and a boot
  // that reports "clean" on every start trains operators to skip the line. The
  // positive answer is the admin command's job, which prints it on demand.
  //
  // A defect FAILS CLOSED. Every class of it means the address a person reads is
  // not the address the row answers to, so a server that keeps going delivers
  // messages to a channel the sender did not name — silently, with the only
  // evidence a log line. Refusing to compose is the strictly safer failure: the
  // data is untouched, `silverhand-server admin scan-title-addresses` still runs
  // read-only against the same database, and the operator repairs the titles and
  // restarts. The handle is closed first so that the retry — and the admin
  // command — get an unlocked file.
  const titleAudit = scanConversationTitleAddresses(db);
  if (titleAudit.defects.length > 0) {
    logger.error(
      {
        scanned: titleAudit.scanned,
        defects: titleAudit.defects.length,
        kinds: [...new Set(titleAudit.defects.map(defect => defect.kind))],
        remediation: 'silverhand-server admin scan-title-addresses',
      },
      describeConversationTitleAudit(titleAudit),
    );
    db.close();
    throw new ConversationTitleAddressDefectError(titleAudit);
  }
  const workspaceAudit = scanWorkspaceNameAddresses(db);
  if (workspaceAudit.defects.length > 0) {
    logger.error(
      {
        scanned: workspaceAudit.regularScanned,
        defects: workspaceAudit.defects.length,
        kinds: [...new Set(workspaceAudit.defects.map(defect => defect.kind))],
        remediation: 'silverhand-server admin scan-workspace-addresses',
      },
      'workspace address integrity audit failed',
    );
    db.close();
    throw new WorkspaceNameAddressDefectError(workspaceAudit);
  }
  const blobStorage = createLocalBlobFileStorage({
    rootDir: opts.blobsRootDir,
  });
  await blobStorage.ensureReady();

  if (opts.mode === 'embedded') {
    assertLauncherResolvable(
      opts.silverhandCliLauncher.command,
      'silverhand CLI',
    );
  }

  // #task:1983 W1 — the ONE place the raw handle is turned into repositories,
  // unit-of-work ports, read models and persistence adapters. What boot keeps is
  // the DRIVER, not persistence: migrations above, pragma / statement
  // observation, the write probe, and `close()` on shutdown. Everything else
  // takes its dependency from this bag, and the fence that keeps it that way is
  // mechanical — `tests/db-boundary/port-contract.test.ts` refuses any
  // `repos/*` or `adapters/*` module reference from this file, so a second
  // persistence assembly cannot be written here even though boot holds a handle.
  // (It does NOT mean one repo instance per kind process-wide; see the
  // composition root's header for what is and is not single.)
  const persistence = createBackendPersistence(db);

  // Bootstrap: embedded desktop owns the local daemon-host identity.
  // Standalone server must not synthesize a local host that implies
  // access to the user's machine.
  const hostRepo = persistence.repos.hosts;
  if (opts.mode === 'embedded') {
    hostRepo.ensureLocal();
  } else {
    hostRepo.ensureStandaloneServer();
  }

  const attachmentService = new AttachmentService({
    storage: blobStorage,
    attachments: persistence.repos.attachments,
    conversations: persistence.repos.conversations,
  });

  const events = new ScopeEventBus(undefined, logger);
  const userPersistence = persistence.users;
  const userService = new UserService({
    users: userPersistence.read,
    profileWrites: userPersistence.profile,
    registration: userPersistence.registration,
    blobStorage,
    events,
  });

  const agentService = new AgentService({
    agents: persistence.repos.agents,
    blobStorage,
    events,
  });
  const placement = new RuntimeHostPlacementResolver({
    hosts: persistence.repos.hosts,
    agents: persistence.repos.agents,
    workspaces: persistence.repos.workspaces,
  });
  let outboundFanout: OutboundRuntimeEventFanout | null = null;
  let hostWs: HostWsServerController | null = null;
  // D5.a-3 — the deployment-specific outbound transport the fanout
  // dispatches through (standalone = WSS-backed adapter wrapping
  // `hostWs`; embedded = composite local Unix + WS adapter). Installed
  // once the HTTP server binds; the fanout reads it via
  // `() => outboundAdapter`.
  let outboundAdapter: OutboundFrameAdapter | null = null;
  // #task:1588 — process-wide host-status read model. Thunks late-bind
  // the transport + fanout view; the fanout's `onHostReady` eager-seeds
  // it so the first `/status` read of a generation is a memory read.
  // `onSeeded` re-publishes the availability invalidation: a renderer
  // that read the pre-seed pending arm refetches once the seed lands
  // (the HTTP read path itself never dispatches — task gate #4).
  const hostStatusReadModel = new HostStatusReadModel({
    adapter: () => outboundAdapter,
    runtimeView: hostId => outboundFanout?.hostRuntimeView(hostId) ?? null,
    logger,
    onSeeded: hostId => {
      const ownerUserId = hostRepo.get(hostId)?.user_id ?? null;
      if (ownerUserId === null) return;
      events.publishToScope(
        `viewer:${ownerUserId}`,
        HOST_CONNECTION_CHANGED_EVENT,
        { host_id: hostId },
      );
    },
  });
  // Embedded local-Unix adapter kept here so the server-close path can
  // close the connection it owns (the standalone adapter only *views* a
  // controller owned by the bootstrap, so it has nothing to close).
  let embeddedOutboundAdapter: EmbeddedUnixOutboundFrameAdapter | null = null;
  // D5.a-3 P1-1 (Cindy `KuHXrKuCv9nPU28M`) — the embedded adapter is
  // CONSTRUCTED synchronously after `serve()` returns (so `outboundAdapter`
  // is non-null before any route handler can run), but its `connect()` is
  // deferred behind this thunk and fired from inside the listen callback,
  // AFTER `ctx.serverConfig.url` is finalized. This is still load-bearing
  // for event-WS / backend metadata, but `runtime_start` no longer carries
  // server_url at all: the host daemon injects the control-plane URL locally.
  // Stays null for standalone (daemon dials in).
  let startEmbeddedOutboundConnect: (() => void) | null = null;
  const presence = new PresenceRegistry({
    events,
    users: persistence.repos.users,
    logger,
  });

  const ctx: BackendContext = {
    metrics: opts.metrics,
    dbWriteProbe: createSqliteDbWriteProbe({ db, metrics: opts.metrics }),
    authorizationReads: persistence.authorizationReads,
    deploymentMode: opts.mode,
    // D4.e-1 3b P1-2 — the exact co-located host (embedded backend's own disk).
    // In embedded that is the single `local`-named host (`ensureLocal`); in
    // standalone the backend is remote, co-located with no host.
    coLocatedHostId:
      opts.mode === 'embedded' ? hostRepo.ensureLocal().id : undefined,
    readiness: {
      migrationsApplied,
      listenReady: false,
      outboundEventFanoutInstalled: false,
    },
    serverConfig: opts.serverConfig,
    bindAddressScope,
    authConfig,
    embeddedBootstrap: createDisabledEmbeddedBootstrapState(opts.embeddedBootstrapPath),
    logger,
    loggers,
    logControl,
    logDir: opts.logDir,
    blobStorage,
    attachmentService,
    agentService,
    userService,
    channelService: undefined as unknown as ChannelService,
    conversationMessageService:
      undefined as unknown as ConversationMessageService,
    taskService: undefined as unknown as TaskService,
    scheduleService: undefined as unknown as ScheduleService,
    idleReaperService: undefined as unknown as IdleReaperService,
    events,
    presence,
    silverhandCliLauncher,
    agentTokens: new AgentTokenStore(),
    passwordCredentials: new PasswordCredentialService(
      persistence.auth.credentials,
    ),
    authSessions: new AuthSessionService(persistence.auth.sessions, {
      sessionTtlMs: authConfig.sessionTtlMs,
    }),
    placement:
      // D4.c C1 — standalone now uses the same `RuntimeHostPlacementResolver`
      // as embedded. Pre-D4.c the standalone branch wired
      // `DisabledRuntimeHostPlacement` (every method threw
      // `host_runtime_disabled`) because the original Stage B/C
      // sketch treated standalone as "no host placement at all".
      // M1 turns that around: standalone has a real hosts table
      // populated by remote desktop daemons attaching over outbound
      // WSS, so placement = authoritative DB lookup either way.
      // The D2.0 guiding principle ("server doesn't pretend to own
      // user filesystem") lives at the route / data-plane layer,
      // not here — the resolver is just identity / ACL / equality
      // checks against the DB. Note: this means routes that used
      // to early-return `host_runtime_disabled` purely because they
      // hit `ctx.placement.*` in standalone now return real
      // 404/403/409 responses driven by actual DB state. The
      // CRUD-deferral routes that explicitly `standaloneMode(ctx)`
      // fork into `hostRuntimeDisabledResponse()` are unaffected;
      // those are C2/C3 work to lift properly.
      placement,
    hostWsController: () => hostWs,
    // D5.a-3 P1-3 — the formal server↔daemon dispatch port. Routes that
    // send commands (POST /api/agents materialize, retry) go through this
    // accessor so they never branch on deployment mode. `hostWsController`
    // stays as the WS lifecycle/control port for user-managed computers.
    outboundFrameAdapter: () => outboundAdapter,
    // #task:1588 — late-bound per-host liveness view (see context.ts).
    // `outboundFanout` is constructed in the listen callback, after this
    // ctx literal; the thunk resolves live.
    hostRuntimeView: hostId => outboundFanout?.hostRuntimeView(hostId) ?? null,
    hostStatusReadModel: () => hostStatusReadModel,
    // Filled immediately below when the daemon runtime host is constructed.
    runtimeHost: undefined as unknown as AgentRuntimeHost,
  };
  configureDatabaseObservation(db, {
    metrics: opts.metrics,
    logger,
  });
  const agentDeletionResumer = new AgentDeletionResumer({
    deletion: persistence.agentTeardown.deletion,
    adapter: () => outboundAdapter,
    logger,
    onCommitted: async (completed, purge) => {
      ctx.agentService.publishDeleted(completed.facts.id);
      const swept = await sweepStoredBlobs(ctx, completed.capture.dmBlobRefs);
      if (swept.failed > 0) {
        logger.warn(
          {
            agentId: completed.facts.id,
            failed: swept.failed,
            attempted: swept.attempted,
            err: swept.firstError,
          },
          'resumed agent deletion left attachment blobs behind',
        );
      }
      logger.info(
        {
          agentId: completed.facts.id,
          hostId: completed.facts.hostId,
          purgedCount: purge.purgedCount,
          quiescedCount: purge.quiescedCount,
        },
        'agent deletion committed after daemon purge',
      );
    },
  });
  // ── Runtime host wiring ─────────────────────────────────────────
  // D5.a-3 — embedded and standalone are ONE runtime host over the
  // outbound frame transport. The host delegates to the
  // `OutboundRuntimeEventFanout` projection; the deployment-specific
  // `OutboundFrameAdapter` (standalone = WSS-backed; embedded =
  // composite local Unix + WS) is installed below once the HTTP server
  // binds. The `() => outboundFanout` thunk defers the projection lookup
  // so this assignment can precede the fanout construction (which needs the
  // bound server / finalized `serverConfig.url`).
  ctx.runtimeHost = new OutboundAgentRuntimeHost(logger, () => outboundFanout);
  logger.info(
    { runtime: 'outbound', mode: opts.mode },
    'agent runtime: outbound frame transport',
  );

  // Cross-computer slice 1 (#task:1596) — pre-spawn L2 seed ensurer for the
  // runtime start/deliver filesystem chain (idempotent daemon agent_l2_seed,
  // memoized per (host, workspace, agent), failures retried).
  ctx.agentL2SeedEnsurer = new AgentL2SeedEnsurer({
    outboundFrameAdapter: () => ctx.outboundFrameAdapter?.() ?? null,
  });

  const conversationPersistence = persistence.conversation;
  const unreadPublish = persistence.effects.unreadPublish({
    events: ctx.events,
  });
  ctx.channelService = new ChannelService({
    channels: conversationPersistence.channel.read,
    channelWrites: conversationPersistence.channel.directWrite,
    workspaces: conversationPersistence.channel.workspaces,
    agents: conversationPersistence.channel.agents,
    uow: conversationPersistence.channel.uow,
    unreadPublish,
    events: ctx.events,
    runtimeHost: ctx.runtimeHost,
    logger,
  });
  ctx.conversationMessageService = new ConversationMessageService({
    uow: conversationPersistence.message.uow,
    threadFollow: conversationPersistence.threadFollow,
    delivery: conversationPersistence.delivery,
    unreadPublish,
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
  });
  const taskPersistence = persistence.tasks;
  ctx.taskService = new TaskService({
    read: taskPersistence.read,
    board: taskPersistence.board,
    conversations: taskPersistence.conversations,
    uow: taskPersistence.uow,
    agents: persistence.repos.agents,
    workspaces: persistence.repos.workspaces,
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
    canUseCapability: (actor, workspaceId, capability) =>
      canAgentUseCapability(ctx, actor, capability, { workspaceId }),
    canPostToConversation: (actor, conversationId) =>
      canPostToConversation(ctx, actor, conversationId),
  });
  ctx.scheduleService = new ScheduleService({
    schedules: persistence.repos.schedules,
    workspaces: persistence.repos.workspaces,
    conversations: persistence.repos.conversations,
    conversationReads: persistence.repos.conversationReads,
    attentionBadges: persistence.repos.attentionBadges,
    messages: persistence.repos.messages,
    agents: persistence.repos.agents,
    runtimeHost: ctx.runtimeHost,
    events: ctx.events,
    logger,
    // `canAgentUseCapability` reads only `kind`/`agentId` from the
    // principal; the schedule checker is keyed by agentId, so synthesize a
    // minimal agent principal (conversationId is unused by the capability
    // path).
    canUseCapability: (agentId, workspaceId, capability) =>
      canAgentUseCapability(
        ctx,
        { kind: 'agent', agentId, conversationId: '' },
        capability,
        {
          workspaceId,
        },
      ),
  });
  ctx.idleReaperService = new IdleReaperService({
    runtimeHost: ctx.runtimeHost,
    logger,
  });
  // D4.d §5 — boot-time materialization reconciler. Marks stale
  // `pending_materialization` rows as `failed` with
  // `backend_crash_during_materialize`. SYNCHRONOUS by contract:
  // must complete before the HTTP listener binds so the first
  // `GET /api/agents?include_failed=1` (D5) sees a coherent state,
  // and so list/get callers never observe an orphaned pending row
  // left over from a prior crash. NOT a compensating executor — see
  // module header in `runtime/materialize-reconciler.ts` for the
  // boundary.
  runBootMaterializeReconciler({
    agents: persistence.repos.agents,
    logger,
  });
  // A runtime transition never changes `agents.runtime` until its final
  // atomic commit. After a backend crash no transition executor survives, so
  // stale locks are safe to roll back before hydrate/scheduling can spawn.
  const staleRuntimeTransitions =
    persistence.repos.agents.clearStaleRuntimeTransitions();
  if (staleRuntimeTransitions > 0) {
    logger.warn(
      { count: staleRuntimeTransitions },
      'cleared stale agent runtime-transition locks on boot',
    );
  }
  // Boot recovery (daemon hydrate from `runtime_status` then diff
  // stale DB rows). Scheduling waits until reconcile lands so any
  // handles brought back are visible to the first live delivery.
  await ctx.runtimeHost.reconcileOnBoot();
  ctx.scheduleService.start();
  ctx.idleReaperService.start();
  ctx.embeddedBootstrap = await prepareEmbeddedBootstrap({
    bootstrapPath: opts.embeddedBootstrapPath,
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
  app.route(
    '/',
    createApiRouter(ctx, persistence, {
      agentDeletionRunner: agentDeletionResumer,
    }),
  );
  app.route('/', createInternalRouter(ctx, persistence));

  return new Promise<RunningBackend>((resolve, reject) => {
    let eventWs: EventWsServerController | null = null;
    const server = serve(
      { fetch: app.fetch, hostname: listenHostname, port: listenPort },
      info => {
        const address = info as AddressInfo;
        const port = address.port;
        const url = urlForListenAddress(listenHostname, port);
        const inputListenUrl = urlForListenAddress(listenHostname, listenPort);
        const serverConfigUrl =
          opts.mode === 'standalone' && opts.serverConfig.url !== inputListenUrl
            ? opts.serverConfig.url
            : url;
        // Embedded event-WS security allowlist: the desktop main process pins
        // the WS `Origin` to the origin it actually reaches this backend at
        // (`installBackendEventWsOriginOverride`), which for embedded is this
        // finalized loopback origin. Set it to EXACTLY that origin — not a
        // merge with any prior value. Embedded runs on an ephemeral loopback
        // port, so a persisted allowlist would carry stale `127.0.0.1:<oldPort>`
        // origins that no longer reach anything; inheriting them is generated-
        // origin residue, not security config. Trust only this boot's origin.
        // (Desktop must also not persist this generated value — see
        // `PersistedServerConfigSchema`.) The ws-server trusts ONLY
        // `event_ws_allowed_origins` and never derives trust from `url`.
        // Standalone declares its allowlist via env instead. See
        // `docs/server-env-config.md`.
        const eventWsAllowedOrigins =
          opts.mode === 'standalone'
            ? opts.serverConfig.event_ws_allowed_origins
            : [new URL(serverConfigUrl).origin];
        ctx.serverConfig = {
          ...opts.serverConfig,
          url: serverConfigUrl,
          ...(eventWsAllowedOrigins
            ? { event_ws_allowed_origins: eventWsAllowedOrigins }
            : {}),
        };
        ctx.readiness.listenReady = true;
        const stopEventLoopHealthMonitor = startEventLoopHealthMonitor(logger);
        logger.info(
          { url, serverConfigUrl, listenHostname, port },
          'backend listening',
        );
        // P1-1 — now that `ctx.serverConfig.url` is finalized, it is safe
        // to dial the embedded daemon (the first `runtime_start` will read
        // this URL). No-op for standalone.
        startEmbeddedOutboundConnect?.();
        resolve({
          url,
          port,
          context: ctx,
          close: async () => {
            stopEventLoopHealthMonitor();
            // Stop the scheduler before any agent shutdown so we don't
            // race a fire mid-teardown (would write to a dying CM).
            ctx.scheduleService.stop();
            ctx.idleReaperService.stop();
            // Phase 1: runtime shutdown — stop all agents, then flush +
            // close the activity log, WHILE the outbound transport is
            // still connected. `closeActivityLog()` dispatches
            // `runtime_close_activity_log` to every connected host, so it
            // MUST run before the WS/adapter/fanout teardown below
            // (P1-2, Cindy `KuHXrKuCv9nPU28M`) — otherwise the dispatch
            // is a silent no-op. stopAll runs first so terminal events
            // are written before the activity stream closes. The activity
            // writer's own `close()` is idempotent (`closed` guard), so
            // the later `outboundFanout.close()` re-closing it is safe.
            await ctx.runtimeHost.stopAll().catch(() => undefined);
            await ctx.runtimeHost.closeActivityLog().catch(() => undefined);

            // #task:1588 — cancel pending eager-seed retries before the
            // transports go away; a timer firing mid-teardown would
            // dispatch host_status into a closing daemon.
            hostStatusReadModel.close();
            await agentDeletionResumer.close();

            // Phase 2: close WS lifecycle before the HTTP drain removes sockets.
            await Promise.all([eventWs?.close(), hostWs?.close()]);
            ctx.presence.dispose();
            // Close the embedded local-Unix adapter's socket (the
            // standalone adapter only views the bootstrap-owned hostWs,
            // so its close() is a no-op).
            await embeddedOutboundAdapter?.close().catch(() => undefined);
            await outboundFanout?.close();
            await cleanupEmbeddedBootstrap(ctx.embeddedBootstrap, logger);

            // Phase 3: drain the HTTP server. (Activity-log flush moved to
            // phase 1 so it dispatches while the transport is still up.)
            //
            // Order matters for the server drain:
            //   1. `server.close()` first — stops accepting new connections
            //      immediately, so no new HTTP work can sneak in.
            //   2. `closeAllConnections()` second — terminates all existing
            //      sockets so `server.close()` resolves right away.
            // The `in` guard handles the Http2Server union member which lacks
            // this method (we always use HTTP/1.1, but the type is a union).
            const serverDrained = new Promise<void>(res =>
              server.close(() => res()),
            );
            if ('closeAllConnections' in server) server.closeAllConnections();
            await serverDrained;

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
    {
      // D5.a-3 — the fanout is the shared projection for BOTH modes.
      // Order is intentional: construct the fanout, then — only after
      // the constructor returns without throwing — flip the readiness
      // bit, then install the transport adapter. A throw inside the
      // constructor must leave `outboundEventFanoutInstalled === false`
      // so `/readyz` keeps returning 503 and orchestrators do not
      // promote a half-wired backend to "ready". This flag is a
      // backend-side wiring indicator only; the daemon-side attachment
      // lifecycle is reported separately via `getAttachment`.
      outboundFanout = new OutboundRuntimeEventFanout({
        ...persistence.effects.runtimeFanout({ events: ctx.events, logger }),
        events: ctx.events,
        transport: () => outboundAdapter,
        logger,
        silverhandCli: ctx.silverhandCliLauncher,
        ...(ctx.coLocatedHostId
          ? { coLocatedHostId: ctx.coLocatedHostId }
          : {}),
        agentTokens: ctx.agentTokens,
        logDir: ctx.logDir,
        agentL2SeedEnsurer: ctx.agentL2SeedEnsurer,
        // #task:1588 slice 2 — semantic liveness invalidation + eager
        // seed wiring. The narrow publisher port keeps the fanout off
        // the full ScopeEventBus surface.
        publishHostScopeEvent: (ownerUserId, kind, payload) =>
          ctx.events.publishToScope(`viewer:${ownerUserId}`, kind, payload),
        onHostReady: (hostId, connectionId) => {
          hostStatusReadModel.seedEagerly(hostId);
          agentDeletionResumer.onHostReady(hostId, connectionId);
        },
      });
      ctx.readiness.outboundEventFanoutInstalled = true;
    }
    const hostWsEventSink = outboundFanout ?? undefined;
    // #task:2043 (B) — availability invalidation readers. BackendContext holds
    // no db handle, so the agent→host and workspace→member-userIds enumerations
    // the fan-out needs beyond `ctx.authorizationReads` are injected here.
    const availabilityChangedDeps: AgentAvailabilityChangedDeps = {
      listAgentIdsByHost: hostId =>
        persistence.repos.agents.listByHost(hostId).map(agent => agent.id),
      workspaceMemberUserIds: workspaceId =>
        persistence.repos.workspaces.listUserMemberIds(workspaceId),
    };
    hostWs = installHostWebSocketServer(server as HttpServer, ctx, {
      hostTokenVerifier: new HostTokenService(persistence.hostTokens),
      hosts: persistence.repos.hosts,
      eventSink: opts.testHooks?.wrapHostWsEventSink
        ? opts.testHooks.wrapHostWsEventSink(hostWsEventSink)
        : hostWsEventSink,
      onHostAttachmentChanged: hostId =>
        publishAgentAvailabilityChangedForHost(ctx, availabilityChangedDeps, hostId),
    });
    // Construct the deployment-specific outbound transport. This runs
    // synchronously before the listen callback fires, so `outboundAdapter`
    // is wired before any request can arrive. For embedded the actual
    // `connect()` is deferred to the listen callback (P1-1) so the first
    // embedded adapter never observes placeholder backend state.
    if (opts.mode === 'standalone') {
      // Standalone: the daemon dials the backend over WSS; the adapter
      // is a thin view of the `hostWs` controller (owned by this
      // bootstrap, so the adapter's `close()` is a no-op).
      outboundAdapter = new DeletionAwareOutboundFrameAdapter(
        new StandaloneOutboundFrameAdapter(() => hostWs),
        persistence.agentTeardown.read,
      );
    } else {
      // Embedded: the backend dials the daemon's local outbound socket.
      const localHostId = hostRepo.ensureLocal().id;
      const socketPath =
        opts.outboundSocketPath ?? deriveLocalOutboundFrameSocketPath();
      const adapter = new EmbeddedUnixOutboundFrameAdapter({
        socketPath,
        hostId: localHostId,
        onEvent: (hostId, event, connectionId) =>
          outboundFanout?.onEvent(hostId, event, connectionId),
        onDisconnect: (hostId, connectionId) =>
          outboundFanout?.onDisconnect(hostId, connectionId),
        logger,
      });
      embeddedOutboundAdapter = adapter;
      // Embedded desktop can now host both transport families at once:
      // the app-managed default computer uses the local Unix adapter,
      // while user-managed `silverhand-daemon connect` instances dial
      // the same embedded backend over WS. Keep one backend dispatch
      // port and route by host id at the transport layer.
      outboundAdapter = new DeletionAwareOutboundFrameAdapter(
        new CompositeOutboundFrameAdapter([
          adapter,
          new StandaloneOutboundFrameAdapter(() => hostWs),
        ]),
        persistence.agentTeardown.read,
      );
      // Defer the connect to the listen callback (P1-1): construct now so
      // `outboundAdapter` is wired, but dial only after the bound URL is
      // finalized. Fire-and-forget once triggered (mirrors the standalone
      // ready→hydrate model). On the daemon's connection-scoped `ready`
      // the fanout latches the daemon key and hydrates `runtime_status`.
      // Until the socket is up, runtime routes return 503 `host_attach_pending`.
      startEmbeddedOutboundConnect = () => {
        void connectEmbeddedOutboundAdapter(adapter, socketPath, logger);
      };
    }
    agentDeletionResumer.startConnectedHosts();
    server.on('error', reject);
  });
}

/**
 * Connect the embedded local-Unix outbound adapter to the daemon's
 * `daemon-outbound.sock`, retrying briefly to absorb the boot race where
 * the desktop main process has spawned the daemon but its socket is not
 * yet listening. Best-effort: on persistent failure we log a warning and
 * return — runtime routes surface `host_attach_pending` (503) until the
 * socket becomes reachable. (Reconnect-on-drop after a daemon bounce is a
 * follow-up; in embedded the desktop main supervises the daemon's
 * lifecycle and would re-run boot wiring on a restart.)
 */
async function connectEmbeddedOutboundAdapter(
  adapter: EmbeddedUnixOutboundFrameAdapter,
  socketPath: string,
  logger: BackendLogger,
): Promise<void> {
  const maxAttempts = 20;
  const intervalMs = 100;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await adapter.connect();
      logger.info(
        { socketPath, attempt },
        'embedded outbound adapter connected to daemon socket',
      );
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.warn(
          {
            socketPath,
            attempts: attempt,
            err: err instanceof Error ? err.message : String(err),
          },
          'embedded outbound adapter failed to connect; runtime routes return host_attach_pending until the daemon socket is reachable',
        );
        return;
      }
      await delayMs(intervalMs);
    }
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
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
  HostWsEventSink,
} from './ws/host-ws-server.js';
export type { AuthRuntimeConfig } from './auth/config.js';
export { resolveAuthRuntimeConfig } from './auth/config.js';
export {
  BackendMetrics,
  startEventLoopHealthMonitor,
} from './observability/metrics.js';
export {
  startMetricsServer,
  type RunningMetricsServer,
} from './observability/metrics-server.js';
export {
  configureDatabaseObservation,
  prepareObserved,
  type ObservedStatement,
} from './observability/observed-statement.js';
export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
} from '@silverhand/shared/db/migrations';
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
  scanTitleAddresses,
  scanWorkspaceAddresses,
  type AdminResetPasswordErrorCode,
  type AdminResetPasswordOptions,
  type AdminScanTitleAddressesOptions,
  type AdminScanTitleAddressesResult,
  type AdminScanWorkspaceAddressesResult,
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

function resolveLogControl(logger: BackendLogger): LogLevelControl {
  const candidate = logger as BackendLogger & { logControl?: LogLevelControl };
  return candidate.logControl ?? createLogLevelControl();
}

function urlForListenAddress(hostname: string, port: number): string {
  const host =
    hostname.includes(':') && !hostname.startsWith('[')
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
