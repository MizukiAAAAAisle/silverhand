import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import type { Database as Db } from 'better-sqlite3';

/**
 * Open an in-memory SQLite + run migrations + bootstrap the 'local'
 * host (matches what `startBackend` does). Tests get a fresh DB per
 * call so they're independent.
 *
 * Caller can `.close()` when done; tests rarely need to since vitest
 * reaps process state between files.
 */
export function openTestDb(): { db: Db; localHostId: string } {
  const db = openDatabase(':memory:');
  const local = new HostRepo(db).ensureLocal();
  return { db, localHostId: local.id };
}

/**
 * Disposable workspace root for tests that touch the filesystem
 * (provisionChannel, spawn-prep, etc). Caller should pass `cleanup()`
 * to `afterEach` / `afterAll`.
 */
export function makeTempSilverhandDir(): {
  silverhandDir: string;
  workspacesRoot: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-test-'));
  const workspacesRoot = join(dir, 'workspaces');
  return {
    silverhandDir: dir,
    workspacesRoot,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
