import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCategorizedLoggers,
  createLogLevelControl,
  resolveAuthRuntimeConfig,
  startBackend,
  BackendMetrics,
  startMetricsServer,
  type BackendListenOptions,
  type CategorizedLoggers,
  type EmbeddedBackendOptions,
  type FileLogger,
  type RunningBackend,
} from '@silverhand/backend';
import type { ServerConfig } from '@silverhand/shared';
import {
  DEFAULT_EMBEDDED_SILVERHAND_MIGRATE,
  resolveEmbeddedMigrationEnv,
  resolveMigrationEnv,
  resolveOptionalMetricsListen,
  resolveStandaloneServerEnv,
  SILVERHAND_METRICS_LISTEN_ENV,
  type StandaloneServerEnvConfig,
} from './config.js';

export {
  DEFAULT_EMBEDDED_SILVERHAND_MIGRATE,
  DEFAULT_SILVERHAND_DATA_DIR,
  DEFAULT_SILVERHAND_DISABLE_SIGNUP,
  DEFAULT_SILVERHAND_LISTEN,
  DEFAULT_SILVERHAND_MIGRATE,
  DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
  SILVERHAND_DATA_DIR_ENV,
  SILVERHAND_DISABLE_SIGNUP_ENV,
  SILVERHAND_LISTEN_ENV,
  SILVERHAND_MIGRATE_ENV,
  SILVERHAND_METRICS_LISTEN_ENV,
  SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV,
  SILVERHAND_SERVER_LOG_LEVEL_ENV,
  ServerEnvConfigError,
  parseDataDir,
  parseDisableSignup,
  parseListen,
  parseLogLevel,
  parseMigrate,
  parseOrigin,
  parseEventWsAllowedOrigins,
  resolveEmbeddedMigrationEnv,
  resolveStandaloneServerEnv,
  resolveMigrationEnv,
  resolveOptionalMetricsListen,
  type ListenConfig,
  type ResolvedValue,
  type StandaloneServerEnvConfig,
} from './config.js';

export {
  createCategorizedLoggers,
  type CategorizedLoggers,
  type FileLogger,
  type RunningBackend,
};

export {
  runAdminCommand,
  type CommandSink,
  type ServerAdminCommandIo,
} from './admin.js';

export interface StartEmbeddedSilverhandServerOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  serverConfig: ServerConfig;
  /**
   * Path to the daemon's local outbound frame socket. The embedded
   * backend dials it and speaks the same outbound envelope as standalone
   * (D5.a). Optional — defaults to `~/.silverhand/run/daemon-outbound.sock`.
   * Replaces the former `hostClient` (the local daemon RPC was the R4
   * drift D5.a closed; host-control IPC stays in the desktop main process).
   */
  outboundSocketPath?: EmbeddedBackendOptions['outboundSocketPath'];
  silverhandCliLauncher: EmbeddedBackendOptions['silverhandCliLauncher'];
  logger?: EmbeddedBackendOptions['logger'];
  loggers?: Partial<CategorizedLoggers>;
  logDir?: string;
  listen?: BackendListenOptions;
}

export interface StartStandaloneSilverhandServerOptions {
  env?: NodeJS.ProcessEnv;
}

export async function startEmbeddedSilverhandServer(
  opts: StartEmbeddedSilverhandServerOptions,
): Promise<RunningBackend> {
  const migrate = resolveEmbeddedMigrationEnv(opts.env ?? process.env);
  return startBackend({
    mode: 'embedded',
    dbPath: join(opts.dataDir, 'silverhand.db'),
    silverhandDir: opts.dataDir,
    serverConfig: opts.serverConfig,
    silverhandCliLauncher: opts.silverhandCliLauncher,
    logger: opts.logger,
    loggers: opts.loggers,
    logDir: opts.logDir,
    schemaUpgrade: {
      allow: migrate.value,
    },
    ...(opts.outboundSocketPath
      ? { outboundSocketPath: opts.outboundSocketPath }
      : {}),
    listen: opts.listen ?? { hostname: '127.0.0.1', port: 0 },
  });
}

export async function startStandaloneSilverhandServer(
  opts: StartStandaloneSilverhandServerOptions = {},
): Promise<RunningBackend> {
  const env = opts.env ?? process.env;
  const config = resolveStandaloneServerEnv(env);
  await mkdir(config.dataDir.value, { recursive: true });
  const logControl = createLogLevelControl(config.logLevel.value);
  const loggers = createCategorizedLoggers({
    dir: join(config.dataDir.value, 'logs'),
    alsoConsole: true,
    base: { app: 'silverhand-server' },
    logControl,
  });
  const logger = loggers.system as FileLogger;
  logger.info(
    {
      mode: 'standalone',
      listen: {
        ...config.listen.value,
        source: config.listen.source,
      },
      dataDir: {
        path: config.dataDir.value,
        source: config.dataDir.source,
      },
      disableSignup: {
        value: config.disableSignup.value,
        source: config.disableSignup.source,
      },
      logLevel: {
        value: config.logLevel.value,
        source: config.logLevel.source,
      },
      migrate: {
        value: config.migrate.value,
        source: config.migrate.source,
      },
      metricsListen: {
        value: config.metricsListen.value,
        source: config.metricsListen.source,
      },
      eventWsAllowedOrigins: {
        value: config.eventWsAllowedOrigins.value,
        source: config.eventWsAllowedOrigins.source,
      },
    },
    'silverhand-server config resolved',
  );
  const metrics = config.metricsListen.value
    ? new BackendMetrics('standalone')
    : undefined;
  let backend: RunningBackend | null = null;
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | null = null;
  try {
    if (metrics && config.metricsListen.value) {
      // Bind the private listener before the public backend. A bad metrics
      // address/port must fail startup without briefly accepting real traffic
      // and then tearing down attached daemon runtimes.
      metricsServer = await startMetricsServer(
        metrics,
        config.metricsListen.value,
        logger,
      );
    }
    backend = await startBackend({
      mode: 'standalone',
      dbPath: join(config.dataDir.value, 'silverhand.db'),
      silverhandDir: config.dataDir.value,
      serverConfig: standaloneServerConfig(config),
      authConfig: {
        ...resolveAuthRuntimeConfig(env),
        signupEnabled: !config.disableSignup.value,
      },
      logger,
      loggers,
      logDir: join(config.dataDir.value, 'logs'),
      schemaUpgrade: {
        allow: config.migrate.value,
      },
      metrics,
      listen: config.listen.value,
    });
    if (!metrics || !metricsServer) return backend;
    const runningBackend = backend;
    const runningMetricsServer = metricsServer;
    return {
      ...runningBackend,
      metricsUrl: runningMetricsServer.url,
      close: async () => {
        await runningMetricsServer.close();
        metrics.close();
        await runningBackend.close();
      },
    };
  } catch (err) {
    await metricsServer?.close().catch(() => undefined);
    metrics?.close();
    await backend?.close().catch(() => undefined);
    throw err;
  }
}

function standaloneServerConfig(
  config: StandaloneServerEnvConfig,
): ServerConfig {
  const eventWsAllowedOrigins = config.eventWsAllowedOrigins.value;
  return {
    mode: 'remote',
    // The server's own identity URL is always its bind address — it does NOT
    // know its public origin (the edge owns topology; connect commands are
    // assembled desktop-side from the URL the desktop reaches). See
    // `docs/orchestration-boundary-v1.md §4.3`.
    url: urlForListen(config.listen.value),
    ...(eventWsAllowedOrigins.length > 0
      ? { event_ws_allowed_origins: eventWsAllowedOrigins }
      : {}),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
}

function urlForListen(listen: BackendListenOptions): string {
  const host =
    listen.hostname.includes(':') && !listen.hostname.startsWith('[')
      ? `[${listen.hostname}]`
      : listen.hostname;
  return `http://${host}:${listen.port}`;
}
