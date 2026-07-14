import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v58 (conversation_visibility) falsifiers.
//
// Proves the two properties this migration must hold:
//   1. v57→v58 UPGRADE backfills every pre-existing conversation to an
//      EXPLICIT `visibility='private'` (no "missing = private" compat branch).
//   2. The illegal `kind × visibility` combination (public on a non-channel)
//      fails closed on BOTH write paths — INSERT and UPDATE — via the single
//      cross-column CHECK.
//
// These tests are falsifiers: delete the v58 CHECK and every `toThrow()` here
// stops throwing (the test goes red), proving it is not a false-positive pass.
// The CHECK alone is sufficient — SQLite re-validates every row CHECK on any
// INSERT or UPDATE, including an UPDATE that touches only the sibling `kind`
// column — so no BEFORE trigger is involved.

/** Apply every migration up to and including `maxVersion` onto a fresh
 *  in-memory DB. FK enforcement is OFF so we can seed minimal conversation
 *  rows without standing up the full workspaces/agents graph. */
function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)',
  );
  for (const m of migrations) {
    if (m.version > maxVersion) break;
    const apply = () => {
      db.exec(m.up);
      insertMigration.run(m.version, m.name);
    };
    if (m.foreignKeyEscape) {
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
      }
    } else {
      db.transaction(apply)();
    }
  }
  return db;
}

/** Minimal conversation insert (pre-v58: no visibility column). */
function seedConversationAtV57(
  db: Database.Database,
  id: string,
  kind: 'channel' | 'dm_channel',
): void {
  db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at)
     VALUES (?, 'w1', '/tmp/w1', ?, ?, 'active', 0, 0)`,
  ).run(id, kind, `title-${id}`);
}

describe('migration v58 conversation_visibility', () => {
  it('backfills pre-existing conversations to explicit private on v57→v58 upgrade', () => {
    const db = openDbThrough(57);
    try {
      seedConversationAtV57(db, 'chan-1', 'channel');
      seedConversationAtV57(db, 'dm-1', 'dm_channel');

      // Upgrade the SAME db to v58.
      const v58 = migrations.find(m => m.version === 58);
      expect(v58).toBeDefined();
      db.transaction(() => {
        db.exec(v58!.up);
        db.prepare(
          'INSERT INTO _migrations (version, name, applied_at) VALUES (58, ?, 0)',
        ).run(v58!.name);
      })();

      const rows = db
        .prepare<[], { id: string; visibility: string }>(
          'SELECT id, visibility FROM conversations ORDER BY id',
        )
        .all();
      // Every existing row is now EXPLICITLY private — not null, not absent.
      expect(rows).toEqual([
        { id: 'chan-1', visibility: 'private' },
        { id: 'dm-1', visibility: 'private' },
      ]);
      const nulls = db
        .prepare<[], { n: number }>(
          'SELECT COUNT(*) AS n FROM conversations WHERE visibility IS NULL',
        )
        .get();
      expect(nulls?.n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('allows public only on a channel (INSERT path)', () => {
    const db = openDbThrough(58);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at, visibility)
             VALUES ('c-pub', 'w1', '/tmp/w1', 'channel', 't', 'active', 0, 0, 'public')`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects public on a dm_channel (INSERT fail-closed)', () => {
    const db = openDbThrough(58);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at, visibility)
             VALUES ('dm-pub', 'w1', '/tmp/w1', 'dm_channel', 't', 'active', 0, 0, 'public')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects an unknown visibility value (enum CHECK)', () => {
    const db = openDbThrough(58);
    try {
      expect(() =>
        db
          .prepare(
            `INSERT INTO conversations
               (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at, visibility)
             VALUES ('c-bad', 'w1', '/tmp/w1', 'channel', 't', 'active', 0, 0, 'unlisted')`,
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects flipping a public channel to a non-channel kind (UPDATE fail-closed)', () => {
    const db = openDbThrough(58);
    try {
      db.prepare(
        `INSERT INTO conversations
           (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at, visibility)
         VALUES ('c-flip', 'w1', '/tmp/w1', 'channel', 't', 'active', 0, 0, 'public')`,
      ).run();
      // Demoting kind to dm_channel while visibility stays public must abort.
      // SQLite re-validates the full-row cross-column CHECK even though only the
      // sibling `kind` column is updated — no trigger required.
      expect(() =>
        db
          .prepare(`UPDATE conversations SET kind = 'dm_channel' WHERE id = 'c-flip'`)
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects promoting a dm_channel to public (UPDATE fail-closed)', () => {
    const db = openDbThrough(58);
    try {
      db.prepare(
        `INSERT INTO conversations
           (id, workspace_id, workspace_path, kind, title, status, created_at, updated_at, visibility)
         VALUES ('dm-x', 'w1', '/tmp/w1', 'dm_channel', 't', 'active', 0, 0, 'private')`,
      ).run();
      expect(() =>
        db
          .prepare(`UPDATE conversations SET visibility = 'public' WHERE id = 'dm-x'`)
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});
