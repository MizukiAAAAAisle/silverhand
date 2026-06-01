/**
 * Main-process persistence for the desktop user session bearer.
 *
 * V1 intentionally uses a 0600 plaintext local file for all desktop
 * long-lived local credentials. The security boundary is server-side
 * token lifecycle + renderer isolation; local encryption would not
 * defend against user-level desktop code execution and would diverge
 * from `daemon-config.json` host_token storage.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DesktopSessionStorageLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export function desktopSessionPath(silverhandRoot: string): string {
  return join(silverhandRoot, 'desktop', 'session.bin');
}

export function clearPersistedDesktopSession(opts: {
  silverhandRoot: string;
  logger?: DesktopSessionStorageLogger | null;
}): void {
  try {
    unlinkSync(desktopSessionPath(opts.silverhandRoot));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      opts.logger?.warn({ err }, 'failed to remove desktop auth session file');
    }
  }
}

export function loadPersistedDesktopSessionToken(opts: {
  silverhandRoot: string;
  logger?: DesktopSessionStorageLogger | null;
}): string | null {
  const path = desktopSessionPath(opts.silverhandRoot);
  if (!existsSync(path)) return null;
  try {
    const token = readFileSync(path, 'utf8').trim();
    return token.length > 0 ? token : null;
  } catch (err) {
    opts.logger?.warn({ err }, 'failed to read desktop auth session file; clearing');
    clearPersistedDesktopSession(opts);
    return null;
  }
}

export function persistDesktopSessionToken(opts: {
  silverhandRoot: string;
  token: string;
  logger?: DesktopSessionStorageLogger | null;
}): void {
  const path = desktopSessionPath(opts.silverhandRoot);
  mkdirSync(join(opts.silverhandRoot, 'desktop'), { recursive: true });
  writeFileSync(path, opts.token, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    opts.logger?.warn({ err }, 'failed to chmod desktop auth session file');
  }
}
