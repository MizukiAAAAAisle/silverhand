import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';

describe('sidebar ordering retirement', () => {
  it('clears only old top-level modes and entries and is idempotent', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE user_list_sort_mode (list_key TEXT, mode TEXT);
        CREATE TABLE user_sort_entry (list_key TEXT, rank INTEGER, starred_at INTEGER);
        CREATE TABLE other_preference (value TEXT);
        INSERT INTO user_list_sort_mode VALUES ('workspaces','recent'),('channels:w','manual'),('favorites','recent'),('sidebar','manual');
        INSERT INTO user_sort_entry VALUES ('workspaces',1,NULL),('channels:w',2,42),('favorites',3,NULL),('sidebar',4,NULL);
        INSERT INTO other_preference VALUES ('keep');
      `);
      const step = migrations.find((m) => m.version === 98)!;
      db.exec(step.up);
      const entries = db.prepare('SELECT * FROM user_sort_entry ORDER BY list_key').all();
      const modes = db.prepare('SELECT * FROM user_list_sort_mode ORDER BY list_key').all();
      expect(entries).toEqual([
        { list_key: 'channels:w', rank: 2, starred_at: 42 },
        { list_key: 'favorites', rank: 3, starred_at: null },
        { list_key: 'sidebar', rank: 4, starred_at: null },
      ]);
      expect(modes).toHaveLength(3);
      expect(db.prepare('SELECT * FROM other_preference').all()).toEqual([{ value: 'keep' }]);
      db.exec(step.up);
      expect(db.prepare('SELECT * FROM user_sort_entry ORDER BY list_key').all()).toEqual(entries);
      expect(db.prepare('SELECT * FROM user_list_sort_mode ORDER BY list_key').all()).toEqual(
        modes,
      );
    } finally {
      db.close();
    }
  });
});
