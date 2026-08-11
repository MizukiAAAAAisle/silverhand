import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resetAdminPassword } from '../src/admin.js';
import { openDatabase } from '../src/db.js';
import { SqliteAuthCredentialsRepo } from '../src/repos/auth-credentials-repo.js';

const tmpDirs: string[] = [];
let previousTargetMs: string | undefined;

afterEach(async () => {
  if (previousTargetMs === undefined) delete process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS;
  else process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS = previousTargetMs;
  previousTargetMs = undefined;
  await Promise.all(
    tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

describe('resetAdminPassword', () => {
  let db: Db | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('fails fast when another writer holds the SQLite lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-admin-test-'));
    tmpDirs.push(dir);
    const dbPath = join(dir, 'silverhand.db');
    db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO users (id, name, display_name, email, created_at, updated_at)
       VALUES ('user', 'user-test', 'User', 'user@example.com', ?, ?)`,
    ).run(Date.now(), Date.now());
    previousTargetMs = process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS;
    process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS = '1';
    db.exec('BEGIN IMMEDIATE');
    try {
      await expect(
        resetAdminPassword({
          dbPath,
          email: 'user@example.com',
          password: 'new-password',
        }),
      ).rejects.toMatchObject({
        code: 'db_locked',
      });
    } finally {
      db.exec('ROLLBACK');
    }
    // the failure left ZERO work behind: no credential row was written and no
    // session was touched — the lock conflict surfaced before the callback ran
    expect(new SqliteAuthCredentialsRepo(db).getCredential('user')).toBeNull();
  });
});
