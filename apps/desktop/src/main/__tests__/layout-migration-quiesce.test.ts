/**
 * #task:1603 phase A — §5.1 quiesce falsifiers (Cindy final-gate P0): the
 * migration precondition is "every legacy runtime child is PROVEN gone".
 * An unconfirmed live/error pidfile must BLOCK, not be logged and ignored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDesktopAppPaths } from '@silverhand/shared/app-data-layout';
import { quiesceLegacyLocalRuntime } from '../layout-migration/quiesce.js';

let root: string;
let logDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sh-quiesce-'));
  logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedRuntimePidfile(pid: number): string {
  const legacy = resolveDesktopAppPaths(root, 'legacy-v1');
  const dir = join(legacy.run.runtimePids, 'old-daemon-1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'conv1-agent1.json');
  writeFileSync(
    file,
    JSON.stringify({
      pid,
      started_at: 1,
      conv: 'conv1',
      agent: 'agent1',
      runtime: 'claude',
      cmd: 'claude',
    }),
  );
  return file;
}

describe('quiesceLegacyLocalRuntime — §5.1 fail-closed precondition', () => {
  it('a live-but-unsignalable runtime child BLOCKS the migration and the pidfile survives (P0)', async () => {
    const file = seedRuntimePidfile(process.pid);
    const eperm = () => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    };
    await expect(
      quiesceLegacyLocalRuntime(root, logDir, { kill: eperm }),
    ).rejects.toThrow(/refusing to move the pre-migration roots/);
    expect(existsSync(file)).toBe(true);
  });

  it('a dead runtime child is reaped and quiesce passes', async () => {
    const esrch = () => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };
    const file = seedRuntimePidfile(999999);
    await expect(
      quiesceLegacyLocalRuntime(root, logDir, { kill: esrch }),
    ).resolves.toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });
});
