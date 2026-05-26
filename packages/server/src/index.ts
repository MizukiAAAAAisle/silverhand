import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createCategorizedLoggers,
  createLogLevelControl,
  resolveAuthRuntimeConfig,
  startBackend,
  type BackendListenOptions,
  type CategorizedLoggers,
  type CreateBackendOptions,
  type FileLogger,
  type RunningBackend,
} from '@silverhand/backend';
import type { ServerConfig } from '@silverhand/shared';
import {
  resolveStandaloneServerEnv,
  type StandaloneServerEnvConfig,
} from './config.js';

export {
  DEFAULT_SILVERHAND_DATA_DIR,
  DEFAULT_SILVERHAND_DISABLE_SIGNUP,
  DEFAULT_SILVERHAND_LISTEN,
  DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
  SILVERHAND_DATA_DIR_ENV,
  SILVERHAND_DISABLE_SIGNUP_ENV,
  SILVERHAND_LISTEN_ENV,
  SILVERHAND_SERVER_LOG_LEVEL_ENV,
  ServerEnvConfigError,
  parseDataDir,
  parseDisableSignup,
  parseListen,
  parseLogLevel,
  resolveStandaloneServerEnv,
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

export interface StartEmbeddedSilverhandServerOptions {
  dataDir: string;
  serverConfig: ServerConfig;
  hostClient: Extract<CreateBackendOptions, { mode: 'embedded' }>['hostClient'];
  silverhandCliLauncher: Extract<
    CreateBackendOptions,
    { mode: 'embedded' }
  >['silverhandCliLauncher'];
  logger?: CreateBackendOptions['logger'];
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
  return startBackend({
    mode: 'embedded',
    dbPath: join(opts.dataDir, 'silverhand.db'),
    silverhandDir: opts.dataDir,
    serverConfig: opts.serverConfig,
    silverhandCliLauncher: opts.silverhandCliLauncher,
    logger: opts.logger,
    loggers: opts.loggers,
    logDir: opts.logDir,
    hostClient: opts.hostClient,
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
