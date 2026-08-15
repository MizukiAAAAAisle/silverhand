import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TABLE _migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
  )`);
  for (const migration of migrations) {
    if (migration.version > maxVersion) break;
    const apply = () => {
      migration.precondition?.(db as never);
      db.exec(migration.up);
      db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
        .run(migration.version, migration.name);
    };
    if (migration.foreignKeyEscape) {
      db.pragma('legacy_alter_table = ON');
      try { db.transaction(apply)(); } finally { db.pragma('legacy_alter_table = OFF'); }
    } else db.transaction(apply)();
  }
  return db;
}

function applyV78(db: Database.Database): void {
  const migration = migrations.find(candidate => candidate.version === 78)!;
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      migration.precondition?.(db as never);
      db.exec(migration.up);
      db.prepare('INSERT INTO _migrations VALUES (?, ?, 0)')
        .run(migration.version, migration.name);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
}

function seedPrincipal(db: Database.Database): void {
  db.exec(`
    INSERT INTO users (id, name, display_name, created_at, updated_at)
    VALUES ('user-1', 'owner-fixture', 'Owner', 0, 0);
    INSERT INTO hosts (id, kind, name, created_at)
    VALUES ('host-1', 'local', 'host', 0);
    INSERT INTO agents
      (id, name, runtime, host_id, created_at, updated_at, created_by_user_id)
    VALUES ('agent-1', 'agent-fixture', 'claude', 'host-1', 0, 0, 'user-1');
  `);
}

const workspaceRows = (db: Database.Database): unknown[] => db.prepare(
  `SELECT id, name, description, workspace_kind, owner_agent_id, archived_at,
          created_at, updated_at, pinned_at, owner_user_id
     FROM workspaces ORDER BY id`,
).all();

describe('v78 workspace display-name address', () => {
  it('fails before DDL on a folded legacy collision and preserves every row', () => {
    const db = openDbThrough(77);
    db.exec(`
      INSERT INTO workspaces
        (id, name, description, workspace_kind, owner_agent_id, archived_at,
         created_at, updated_at)
      VALUES
        ('w-a', 'General', NULL, 'regular', NULL, NULL, 0, 0),
        ('w-b', 'general', NULL, 'regular', NULL, NULL, 0, 0);
    `);
    const ddl = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'`,
    ).pluck().get();
    const rows = workspaceRows(db);
    expect(() => applyV78(db)).toThrow(/folded_collision.*w-a.*w-b/s);
    expect(db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'`,
    ).pluck().get()).toBe(ddl);
    expect(workspaceRows(db)).toEqual(rows);
    expect(db.prepare('SELECT 1 FROM _migrations WHERE version = 78').get()).toBeUndefined();
    db.close();
  });

  it('canonicalizes regular display bytes, keys them, and leaves agent_home outside', () => {
    const db = openDbThrough(77);
    seedPrincipal(db);
    db.exec(`
      INSERT INTO workspaces
        (id, name, description, workspace_kind, owner_agent_id, archived_at,
         created_at, updated_at)
      VALUES
        ('w-regular', '　Café　', NULL, 'regular', NULL, NULL, 0, 0),
        ('w-home', 'café', NULL, 'agent_home', 'agent-1', NULL, 0, 0);
    `);
    applyV78(db);
    expect(db.prepare(
      `SELECT id, name, name_key FROM workspaces ORDER BY id`,
    ).all()).toEqual([
      { id: 'w-home', name: 'café', name_key: null },
      { id: 'w-regular', name: 'Café', name_key: 'café' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('enforces current regular uniqueness while agent_home may share the display name', () => {
    const db = openDbThrough(77);
    seedPrincipal(db);
    db.exec(`
      INSERT INTO workspaces
        (id, name, description, workspace_kind, owner_agent_id, archived_at,
         created_at, updated_at)
      VALUES ('w-a', 'General', NULL, 'regular', NULL, NULL, 0, 0);
    `);
    applyV78(db);
    expect(() => db.prepare(
      `INSERT INTO workspaces
        (id, name, name_key, description, workspace_kind, owner_agent_id,
         archived_at, created_at, updated_at)
       VALUES ('w-b', 'general', 'general', NULL, 'regular', NULL, NULL, 0, 0)`,
    ).run()).toThrow(/UNIQUE/);
    db.prepare(`UPDATE workspaces SET archived_at = 1 WHERE id = 'w-a'`).run();
    expect(() => db.prepare(
      `INSERT INTO workspaces
        (id, name, name_key, description, workspace_kind, owner_agent_id,
         archived_at, created_at, updated_at)
       VALUES ('w-archived-conflict', 'GENERAL', 'general', NULL,
               'regular', NULL, NULL, 0, 0)`,
    ).run()).toThrow(/UNIQUE/);
    expect(() => db.prepare(
      `INSERT INTO workspaces
        (id, name, name_key, description, workspace_kind, owner_agent_id,
         archived_at, created_at, updated_at)
       VALUES ('w-home', 'General', NULL, NULL, 'agent_home', 'agent-1', NULL, 0, 0)`,
    ).run()).not.toThrow();
    expect(() => db.prepare(
      `UPDATE workspaces SET name_key = 'general' WHERE id = 'w-home'`,
    ).run()).toThrow(/CHECK/);
    db.close();
  });
});
