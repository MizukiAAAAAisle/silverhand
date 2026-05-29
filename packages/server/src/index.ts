import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCategorizedLoggers,
  createLogLevelControl,
  resolveAuthRuntimeConfig,
  startBackend,
  type BackendListenOptions,
  type CategorizedLoggers,
  type EmbeddedBackendOptions,
  type FileLogger,
  type RunningBackend,
} from '@silverhand/backend';
import type { ServerConfig } from '@silverhand/shared';
import {
  resolveMigrationEnv,
  resolveStandaloneServerEnv,
  type StandaloneServerEnvConfig,
} from './config.js';

export {
  DEFAULT_SILVERHAND_DATA_DIR,
  DEFAULT_SILVERHAND_DISABLE_SIGNUP,
  DEFAULT_SILVERHAND_LISTEN,
  DEFAULT_SILVERHAND_MIGRATE,
  DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
  SILVERHAND_DATA_DIR_ENV,
  SILVERHAND_DISABLE_SIGNUP_ENV,
  SILVERHAND_LISTEN_ENV,
  SILVERHAND_MIGRATE_ENV,
  SILVERHAND_SERVER_LOG_LEVEL_ENV,
  ServerEnvConfigError,
  parseDataDir,
  parseDisableSignup,
  parseListen,
  parseLogLevel,
  parseMigrate,
  resolveStandaloneServerEnv,
  resolveMigrationEnv,
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
  const migrate = resolveMigrationEnv(opts.env ?? process.env);
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
    },
    'silverhand-server config resolved',
  );
  return startBackend({
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
    listen: config.listen.value,
  });
}

function standaloneServerConfig(config: StandaloneServerEnvConfig): ServerConfig {
  return {
    mode: 'remote',
    url: urlForListen(config.listen.value),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
}

function urlForListen(listen: BackendListenOptions): string {
  const host = listen.hostname.includes(':') && !listen.hostname.startsWith('[')
    ? `[${listen.hostname}]`
    : listen.hostname;
  return `http://${host}:${listen.port}`;
}
