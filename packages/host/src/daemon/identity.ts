import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

import { HelloResultSchema, type HelloResult } from '../protocol.js';

export type DaemonIdentity = Pick<HelloResult, 'daemon_id' | 'host_descriptor'>;

const DaemonIdentitySchema = HelloResultSchema.pick({
  daemon_id: true,
  host_descriptor: true,
}).strict();

/**
 * Current single-daemon bootstrap identity. Multi-daemon installs will
 * get a launcher-provided daemon home later; until then `local` is the
 * stable daemon_id that future registry migrations can backfill against.
 */
export const DEFAULT_DAEMON_IDENTITY: DaemonIdentity = Object.freeze({
  daemon_id: 'local',
  host_descriptor: Object.freeze({ name: 'local', kind: 'local' }),
});

export function defaultDaemonIdentityPath(runtimePidRootDir?: string | null): string {
  if (runtimePidRootDir) {
    return join(dirname(runtimePidRootDir), 'identity.json');
  }
  return join(homedir(), '.silverhand', 'daemon', 'identity.json');
}

export function readOrCreateDaemonIdentity(filePath: string): DaemonIdentity {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(DEFAULT_DAEMON_IDENTITY, null, 2)}\n`, {
      mode: 0o600,
    });
    return DEFAULT_DAEMON_IDENTITY;
  }
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
  return DaemonIdentitySchema.parse(parsed);
}

export function parseDaemonIdentityForTest(value: unknown): DaemonIdentity {
  return DaemonIdentitySchema.parse(value);
}
