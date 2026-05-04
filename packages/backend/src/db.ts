import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { migrations } from '@silverhand/shared';

export function openDatabase(filepath: string): Db {
  const db = new Database(filepath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Retry for up to 5 s when another connection holds a write lock.
  // Unlikely in the single-process WAL setup but prevents SQLITE_BUSY
  // errors if the user opens the DB with an external tool concurrently.
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM _migrations').all().map((r: any) => r.version),
  );

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      insertMigration.run(m.version, m.name, Date.now());
    })();
  }
}
