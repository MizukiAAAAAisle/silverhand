import { isAbsolute, resolve } from 'node:path';
import {
  SILVERHAND_LOG_LEVELS,
  classifyBindAddressScope,
  type SilverhandLogLevel,
} from '@silverhand/shared';

export const SILVERHAND_LISTEN_ENV = 'SILVERHAND_LISTEN';
export const SILVERHAND_DATA_DIR_ENV = 'SILVERHAND_DATA_DIR';
export const SILVERHAND_DISABLE_SIGNUP_ENV = 'SILVERHAND_DISABLE_SIGNUP';
export const SILVERHAND_SERVER_LOG_LEVEL_ENV = 'SILVERHAND_LOG_LEVEL';
export const SILVERHAND_MIGRATE_ENV = 'SILVERHAND_MIGRATE';
export const SILVERHAND_METRICS_LISTEN_ENV = 'SILVERHAND_METRICS_LISTEN';
export const SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV =
  'SILVERHAND_EVENT_WS_ALLOWED_ORIGINS';

export const DEFAULT_SILVERHAND_LISTEN = '127.0.0.1:8080';
export const DEFAULT_SILVERHAND_DATA_DIR = '/var/lib/silverhand';
export const DEFAULT_SILVERHAND_DISABLE_SIGNUP = false;
export const DEFAULT_SILVERHAND_SERVER_LOG_LEVEL: SilverhandLogLevel = 'info';
/** Standalone server default: operator opt-in before upgrading an existing DB. */
export const DEFAULT_SILVERHAND_MIGRATE = false;
/** Embedded desktop default: user-friendly auto-upgrade with pre-migration backup. */
export const DEFAULT_EMBEDDED_SILVERHAND_MIGRATE = true;

export interface ListenConfig {
  hostname: string;
  port: number;
}

export interface ResolvedValue<T> {
  value: T;
  source: 'default' | 'env';
}

export interface StandaloneServerEnvConfig {
  listen: ResolvedValue<ListenConfig>;
  dataDir: ResolvedValue<string>;
  disableSignup: ResolvedValue<boolean>;
  logLevel: ResolvedValue<SilverhandLogLevel>;
  migrate: ResolvedValue<boolean>;
  /** Private Prometheus listener. Disabled unless explicitly configured. */
  metricsListen: ResolvedValue<ListenConfig | null>;
  /**
   * Browser/Electron `Origin` values allowed to open the authenticated event
   * WebSocket (`SILVERHAND_EVENT_WS_ALLOWED_ORIGINS`, comma-separated). A
   * first-class SECURITY allowlist — NOT a topology hint. Empty by default; a
   * standalone deploy behind a reverse proxy declares its public origin here so
   * the desktop's pinned `Origin` is accepted. The server never derives this
   * from its own bind URL. See `docs/server-env-config.md`.
   */
  eventWsAllowedOrigins: ResolvedValue<string[]>;
}

export class ServerEnvConfigError extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(`${variable}: ${message}`);
    this.name = 'ServerEnvConfigError';
  }
}

export function resolveStandaloneServerEnv(
  env: NodeJS.ProcessEnv = process.env,
): StandaloneServerEnvConfig {
  return {
    listen: resolveValue(
      env[SILVERHAND_LISTEN_ENV],
      parseListen,
      SILVERHAND_LISTEN_ENV,
      parseListen(DEFAULT_SILVERHAND_LISTEN),
    ),
    dataDir: resolveValue(
      env[SILVERHAND_DATA_DIR_ENV],
      parseDataDir,
      SILVERHAND_DATA_DIR_ENV,
      DEFAULT_SILVERHAND_DATA_DIR,
    ),
    disableSignup: resolveValue(
      env[SILVERHAND_DISABLE_SIGNUP_ENV],
      parseDisableSignup,
      SILVERHAND_DISABLE_SIGNUP_ENV,
      DEFAULT_SILVERHAND_DISABLE_SIGNUP,
    ),
    logLevel: resolveValue(
      env[SILVERHAND_SERVER_LOG_LEVEL_ENV],
      parseLogLevel,
      SILVERHAND_SERVER_LOG_LEVEL_ENV,
      DEFAULT_SILVERHAND_SERVER_LOG_LEVEL,
    ),
    migrate: resolveMigrationEnv(env),
    metricsListen: resolveOptionalMetricsListen(env),
    eventWsAllowedOrigins: resolveValue<string[]>(
      env[SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV],
      parseEventWsAllowedOrigins,
      SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV,
      [],
    ),
  };
}

export function resolveOptionalMetricsListen(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedValue<ListenConfig | null> {
  const raw = env[SILVERHAND_METRICS_LISTEN_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { value: null, source: 'default' };
  }
  const listen = parseListen(raw, SILVERHAND_METRICS_LISTEN_ENV);
  if (classifyBindAddressScope(listen.hostname) !== 'loopback') {
    throw new ServerEnvConfigError(
      SILVERHAND_METRICS_LISTEN_ENV,
      'must bind to a loopback address',
    );
  }
  return { value: listen, source: 'env' };
}

export function resolveMigrationEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaultValue = DEFAULT_SILVERHAND_MIGRATE,
): ResolvedValue<boolean> {
  return resolveValue(
    env[SILVERHAND_MIGRATE_ENV],
    parseMigrate,
    SILVERHAND_MIGRATE_ENV,
    defaultValue,
  );
}

export function resolveEmbeddedMigrationEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedValue<boolean> {
  return resolveMigrationEnv(env, DEFAULT_EMBEDDED_SILVERHAND_MIGRATE);
}

function resolveValue<T>(
  raw: string | undefined,
  parse: (value: string, variable: string) => T,
  variable: string,
  defaultValue: T,
): ResolvedValue<T> {
  if (raw === undefined || raw === '') {
    return { value: defaultValue, source: 'default' };
  }
  return { value: parse(raw, variable), source: 'env' };
}

export function parseListen(
  raw: string,
  variable = SILVERHAND_LISTEN_ENV,
): ListenConfig {
  const value = raw.trim();
  if (!value) throw new ServerEnvConfigError(variable, 'must not be empty');

  let hostname: string;
  let portText: string;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0 || value[close + 1] !== ':') {
      throw new ServerEnvConfigError(
        variable,
        'must be host:port or [ipv6]:port',
      );
    }
    hostname = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    const colon = value.lastIndexOf(':');
    if (colon <= 0 || colon === value.length - 1) {
      throw new ServerEnvConfigError(variable, 'must be host:port');
    }
    hostname = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }

  hostname = hostname.trim();
  if (!hostname)
    throw new ServerEnvConfigError(variable, 'host must not be empty');
  if (!/^\d+$/.test(portText)) {
    throw new ServerEnvConfigError(variable, 'port must be an integer');
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ServerEnvConfigError(
      variable,
      'port must be between 0 and 65535',
    );
  }
  return { hostname, port };
}

export function parseDataDir(
  raw: string,
  variable = SILVERHAND_DATA_DIR_ENV,
): string {
  const value = raw.trim();
  if (!value) throw new ServerEnvConfigError(variable, 'must not be empty');
  if (!isAbsolute(value)) {
    throw new ServerEnvConfigError(variable, 'must be an absolute path');
  }
  return resolve(value);
}

export function parseDisableSignup(
  raw: string,
  variable = SILVERHAND_DISABLE_SIGNUP_ENV,
): boolean {
  return parseBoolean01(raw, variable);
}

export function parseMigrate(
  raw: string,
  variable = SILVERHAND_MIGRATE_ENV,
): boolean {
  return parseBoolean01(raw, variable);
}

export function parseLogLevel(
  raw: string,
  variable = SILVERHAND_SERVER_LOG_LEVEL_ENV,
): SilverhandLogLevel {
  const value = raw.trim();
  if ((SILVERHAND_LOG_LEVELS as readonly string[]).includes(value)) {
    return value as SilverhandLogLevel;
  }
  throw new ServerEnvConfigError(
    variable,
    `must be one of ${SILVERHAND_LOG_LEVELS.join(', ')}`,
  );
}

/**
 * Validate a single browser `Origin` value: an http(s) origin URL with no
 * userinfo, path, query, or fragment. Returns the canonical `URL.origin`.
 * Shared by {@link parseEventWsAllowedOrigins}.
 */
export function parseOrigin(
  raw: string,
  variable = SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV,
): string {
  const value = raw.trim();
  if (!value) throw new ServerEnvConfigError(variable, 'must not be empty');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ServerEnvConfigError(variable, `must be a valid URL: ${message}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ServerEnvConfigError(variable, 'must use http:// or https://');
  }
  if (parsed.username || parsed.password) {
    throw new ServerEnvConfigError(variable, 'must not include userinfo');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ServerEnvConfigError(
      variable,
      'must be an origin URL without path, query, or fragment',
    );
  }
  return parsed.origin;
}

/**
 * Parse the comma-separated event-WS `Origin` allowlist. Each item is validated
 * as an origin (see {@link parseOrigin}); wildcards are NOT supported. Blank
 * items are skipped; a non-empty env that yields zero origins is an error
 * (a set-but-meaningless allowlist is almost certainly a misconfiguration).
 * Duplicate origins are de-duplicated.
 */
export function parseEventWsAllowedOrigins(
  raw: string,
  variable = SILVERHAND_EVENT_WS_ALLOWED_ORIGINS_ENV,
): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    if (!part.trim()) continue;
    const origin = parseOrigin(part, variable);
    if (!seen.has(origin)) {
      seen.add(origin);
      origins.push(origin);
    }
  }
  if (origins.length === 0) {
    throw new ServerEnvConfigError(
      variable,
      'must list at least one origin (comma-separated)',
    );
  }
  return origins;
}

function parseBoolean01(raw: string, variable: string): boolean {
  const value = raw.trim();
  if (value === '0') return false;
  if (value === '1') return true;
  throw new ServerEnvConfigError(variable, 'must be 0 or 1');
}
