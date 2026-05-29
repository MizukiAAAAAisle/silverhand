import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { EMBEDDED_BOOTSTRAP_FILENAME, type ServerConfig } from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import { hashSessionToken } from './session.js';

export interface EmbeddedBootstrapState {
  readonly filePath: string;
  readonly enabled: boolean;
  readonly reason: 'enabled' | 'mode_not_embedded' | 'non_loopback_listen';
  consumed: boolean;
  tokenHash: string | null;
}

export interface PrepareEmbeddedBootstrapOptions {
  silverhandDir: string;
  serverConfig: ServerConfig;
  listenHostname: string;
  logger: BackendLogger;
}

export async function prepareEmbeddedBootstrap(
  opts: PrepareEmbeddedBootstrapOptions,
): Promise<EmbeddedBootstrapState> {
  const filePath = embeddedBootstrapPath(opts.silverhandDir);
  if (opts.serverConfig.mode !== 'embedded') {
    await removeBootstrapFile(filePath, opts.logger);
    return disabledState(filePath, 'mode_not_embedded');
  }
  if (!isLoopbackAddress(opts.listenHostname)) {
    await removeBootstrapFile(filePath, opts.logger);
    return disabledState(filePath, 'non_loopback_listen');
  }

  const token = randomBytes(32).toString('base64url');
  await writeBootstrapFileAtomic(filePath, token);
  return {
    filePath,
    enabled: true,
    reason: 'enabled',
    consumed: false,
    tokenHash: hashSessionToken(token),
  };
}

export async function cleanupEmbeddedBootstrap(
  state: EmbeddedBootstrapState,
  logger: BackendLogger,
): Promise<void> {
  await removeBootstrapFile(state.filePath, logger);
  state.consumed = true;
  state.tokenHash = null;
}

export function createDisabledEmbeddedBootstrapState(
  silverhandDir: string,
  reason: EmbeddedBootstrapState['reason'] = 'mode_not_embedded',
): EmbeddedBootstrapState {
  return disabledState(embeddedBootstrapPath(silverhandDir), reason);
}

export function embeddedBootstrapPath(silverhandDir: string): string {
  return join(silverhandDir, EMBEDDED_BOOTSTRAP_FILENAME);
}

export async function consumeEmbeddedBootstrapToken(
  state: EmbeddedBootstrapState,
  token: string,
  logger: BackendLogger,
): Promise<boolean> {
  if (!state.enabled || state.consumed || !state.tokenHash) return false;
  if (!timingSafeStringEqual(hashSessionToken(token), state.tokenHash)) return false;
  state.consumed = true;
  state.tokenHash = null;
  await removeBootstrapFile(state.filePath, logger);
  return true;
}

export function isLoopbackAddress(value: string | null | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackAddress(normalized.slice('::ffff:'.length));
  }
  const match = /^127(?:\.(?:\d{1,3})){3}$/.exec(normalized);
  if (!match) return false;
  return normalized
    .split('.')
    .every(part => Number.parseInt(part, 10) >= 0 && Number.parseInt(part, 10) <= 255);
}

function disabledState(
  filePath: string,
  reason: EmbeddedBootstrapState['reason'],
): EmbeddedBootstrapState {
  return {
    filePath,
    enabled: false,
    reason,
    consumed: true,
    tokenHash: null,
  };
}

async function writeBootstrapFileAtomic(filePath: string, token: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmpPath, `${token}\n`, { mode: 0o600, flag: 'wx' });
  await fs.chmod(tmpPath, 0o600);
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600);
}

async function removeBootstrapFile(
  filePath: string,
  logger: BackendLogger,
): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err }, 'embedded bootstrap: failed to remove token file');
    }
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  return timingSafeEqual(aBuf, bBuf);
}
