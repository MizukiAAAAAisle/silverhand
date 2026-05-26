import { isAbsolute, resolve } from 'node:path';
import {
  SILVERHAND_LOG_LEVELS,
  type SilverhandLogLevel,
} from '@silverhand/shared';

export const SILVERHAND_LISTEN_ENV = 'SILVERHAND_LISTEN';
export const SILVERHAND_DATA_DIR_ENV = 'SILVERHAND_DATA_DIR';
export const SILVERHAND_DISABLE_SIGNUP_ENV = 'SILVERHAND_DISABLE_SIGNUP';
export const SILVERHAND_SERVER_LOG_LEVEL_ENV = 'SILVERHAND_LOG_LEVEL';
export const SILVERHAND_MIGRATE_ENV = 'SILVERHAND_MIGRATE';

export const DEFAULT_SILVERHAND_LISTEN = '127.0.0.1:8080';
export const DEFAULT_SILVERHAND_DATA_DIR = '/var/lib/silverhand';
export const DEFAULT_SILVERHAND_DISABLE_SIGNUP = false;
export const DEFAULT_SILVERHAND_SERVER_LOG_LEVEL: SilverhandLogLevel = 'info';
export const DEFAULT_SILVERHAND_MIGRATE = false;

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
  };
}

export function resolveMigrationEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedValue<boolean> {
  return resolveValue(
    env[SILVERHAND_MIGRATE_ENV],
    parseMigrate,
    SILVERHAND_MIGRATE_ENV,
    DEFAULT_SILVERHAND_MIGRATE,
  );
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

export function parseListen(raw: string, variable = SILVERHAND_LISTEN_ENV): ListenConfig {
  const value = raw.trim();
  if (!value) throw new ServerEnvConfigError(variable, 'must not be empty');

  let hostname: string;
  let portText: string;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0 || value[close + 1] !== ':') {
      throw new ServerEnvConfigError(variable, 'must be host:port or [ipv6]:port');
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
  if (!hostname) throw new ServerEnvConfigError(variable, 'host must not be empty');
  if (!/^\d+$/.test(portText)) {
    throw new ServerEnvConfigError(variable, 'port must be an integer');
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ServerEnvConfigError(variable, 'port must be between 0 and 65535');
  }
  return { hostname, port };
}

export function parseDataDir(raw: string, variable = SILVERHAND_DATA_DIR_ENV): string {
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

function parseBoolean01(raw: string, variable: string): boolean {
  const value = raw.trim();
  if (value === '0') return false;
  if (value === '1') return true;
  throw new ServerEnvConfigError(variable, 'must be 0 or 1');
}
