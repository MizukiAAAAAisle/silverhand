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
import { ensureWorkspacesRoot } from './workspaces-root.js';
import { ScopeEventBus } from './ws/scope-event-bus.js';
import {
  installEventWebSocketServer,
  type EventWsServerController,
} from './ws/ws-server.js';
import {
  installHostWebSocketServer,
  type HostWsServerController,
  type HostWsAttachment,
  type HostWsEventSink,
} from './ws/host-ws-server.js';
import type { AgentRuntimeHost } from './runtime/agent-runtime-host.js';
import { OutboundAgentRuntimeHost } from './runtime/outbound-agent-runtime-host.js';
import { OutboundRuntimeEventFanout } from './runtime/outbound-event-fanout.js';
import {
  StandaloneOutboundFrameAdapter,
  type OutboundFrameAdapter,
} from './runtime/outbound-frame-adapter.js';
import { EmbeddedUnixOutboundFrameAdapter } from './runtime/embedded-unix-outbound-frame-adapter.js';
import {
  RuntimeHostPlacementResolver,
} from './runtime/host-placement.js';
import { runBootMaterializeReconciler } from './runtime/materialize-reconciler.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
import { ConversationRepo } from './repos/conversation-repo.js';
import { MessageRepo } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { ScheduleRepo } from './repos/schedule-repo.js';
import { WorkspaceRepo } from './repos/workspace-repo.js';
import { WorkspaceRegistryBackfiller } from './runtime/workspace-registry-backfill.js';
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
import {
  classifyBindAddressScope,
  type BindAddressScope,
  type ServerConfig,
} from '@silverhand/shared';
import { deriveLocalOutboundFrameSocketPath } from '@silverhand/host';
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
  const bindAddressScope: BindAddressScope = classifyBindAddressScope(listenHostname);
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
    assertLauncherResolvable(opts.silverhandCliLauncher.command, 'silverhand CLI');
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
  // D5.a-3 — the deployment-specific outbound transport the fanout
  // dispatches through (standalone = WSS-backed adapter wrapping
  // `hostWs`; embedded = local Unix-socket adapter). Installed once the
  // HTTP server binds; the fanout reads it via `() => outboundAdapter`.
  let outboundAdapter: OutboundFrameAdapter | null = null;
  // Embedded local-Unix adapter kept here so the server-close path can
  // close the connection it owns (the standalone adapter only *views* a
  // controller owned by the bootstrap, so it has nothing to close).
  let embeddedOutboundAdapter: EmbeddedUnixOutboundFrameAdapter | null = null;
  // D5.a-3 P1-1 (Cindy `KuHXrKuCv9nPU28M`) — the embedded adapter is
  // CONSTRUCTED synchronously after `serve()` returns (so `outboundAdapter`
  // is non-null before any route handler can run), but its `connect()` is
  // deferred behind this thunk and fired from inside the listen callback,
  // AFTER `ctx.serverConfig.url` is finalized. Embedded replaces the
  // placeholder with the real bound URL; standalone preserves a configured
  // public origin when present. Otherwise the connect — and the
  // `runtime_start` it eventually carries — could race ahead of URL
  // finalization and ship a placeholder/bind-only `server_url`. Stays
  // null for standalone (daemon dials in).
  let startEmbeddedOutboundConnect: (() => void) | null = null;

  const ctx: BackendContext = {
    db,
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
    // accessor so they never branch on deployment mode; `hostWsController`
    // stays for WS-only lifecycle (revoke/disconnect) in standalone.
    outboundFrameAdapter: () => outboundAdapter,
    // Filled immediately below when the daemon runtime host is constructed.
    runtimeHost: undefined as unknown as AgentRuntimeHost,
  };
  // ── Runtime host wiring ─────────────────────────────────────────
  // D5.a-3 — embedded and standalone are ONE runtime host over the
  // outbound frame transport. The host delegates to the
  // `OutboundRuntimeEventFanout` projection; the deployment-specific
  // `OutboundFrameAdapter` (standalone = WSS-backed; embedded = local
  // Unix socket) is installed below once the HTTP server binds. The
  // `() => outboundFanout` thunk defers the projection lookup so this
  // assignment can precede the fanout construction (which needs the
  // bound server / finalized `serverConfig.url`).
  ctx.runtimeHost = new OutboundAgentRuntimeHost(logger, () => outboundFanout);
  logger.info(
    { runtime: 'outbound', mode: opts.mode },
    'agent runtime: outbound frame transport',
  );

  // D4.e-1 3b-2/3b-3 — one shared registry backfiller for the
  // `list_workspaces` read path (lazy, on-demand: memoizes per-host success,
  // collapses concurrent callers, retries after a failure). It only
  // dispatches `workspace_provision`; it never assembles a host path.
  ctx.workspaceRegistryBackfiller = new WorkspaceRegistryBackfiller({
    workspaces: new WorkspaceRepo(db, { workspacesRoot }),
    outboundFrameAdapter: () => ctx.outboundFrameAdapter?.() ?? null,
  });

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
    agents: new AgentRepo(db),
    logger,
  });
  // Boot recovery (daemon hydrate from `runtime_status` then diff
  // stale DB rows). Scheduling waits until reconcile lands so any
  // handles brought back are visible to the first wake delivery.
  await ctx.runtimeHost.reconcileOnBoot();
  ctx.scheduleService.start();
  const stopEventLoopLagProbe = startEventLoopLagProbe(logger);

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
        const inputListenUrl = urlForListenAddress(listenHostname, listenPort);
        const serverConfigUrl =
          opts.mode === 'standalone' && opts.serverConfig.url !== inputListenUrl
            ? opts.serverConfig.url
            : url;
        ctx.serverConfig = { ...opts.serverConfig, url: serverConfigUrl };
        ctx.readiness.listenReady = true;
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
            stopEventLoopLagProbe();
            // Stop the scheduler before any agent shutdown so we don't
            // race a fire mid-teardown (would write to a dying CM).
            ctx.scheduleService.stop();
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

            // Phase 2: close WS lifecycle before the HTTP drain removes sockets.
            await Promise.all([
              eventWs?.close(),
              hostWs?.close(),
            ]);
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
            const serverDrained = new Promise<void>(res => server.close(() => res()));
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
        db,
        events: ctx.events,
        transport: () => outboundAdapter,
        logger,
        workspacesRoot,
        silverhandCli: ctx.silverhandCliLauncher,
        agentTokens: ctx.agentTokens,
        serverUrl: () => ctx.serverConfig.url,
        logDir: ctx.logDir,
        workspaceRegistryBackfiller: ctx.workspaceRegistryBackfiller,
      });
      ctx.readiness.outboundEventFanoutInstalled = true;
    }
    hostWs = installHostWebSocketServer(server as HttpServer, ctx, {
      eventSink: opts.testHooks?.wrapHostWsEventSink
        ? opts.testHooks.wrapHostWsEventSink(
            opts.mode === 'standalone'
              ? outboundFanout ?? undefined
              : undefined,
          )
        : opts.mode === 'standalone'
          ? outboundFanout ?? undefined
          : undefined,
    });
    // Construct the deployment-specific outbound transport. This runs
    // synchronously before the listen callback fires, so `outboundAdapter`
    // is wired before any request can arrive. For embedded the actual
    // `connect()` is deferred to the listen callback (P1-1) so the first
    // `runtime_start` never ships a placeholder `server_url`.
    if (opts.mode === 'standalone') {
      // Standalone: the daemon dials the backend over WSS; the adapter
      // is a thin view of the `hostWs` controller (owned by this
      // bootstrap, so the adapter's `close()` is a no-op).
      outboundAdapter = new StandaloneOutboundFrameAdapter(() => hostWs);
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
      outboundAdapter = adapter;
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
