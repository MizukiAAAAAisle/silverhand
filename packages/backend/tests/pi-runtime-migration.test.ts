import Sqlite from 'better-sqlite3';
import { expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import { runMigrations } from '../src/db.js';

it('preserves an in-flight runtime lock and foreign keys while admitting Pi targets', () => {
  const db = new Sqlite(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    runMigrations(db, { migrations: migrations.filter(m => m.version <= 92), expectedStep: 92 });
    db.exec(`INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES('u','user','User',1,1);
      INSERT INTO hosts(id,name,kind,created_at) VALUES('h','host','local',1);
      INSERT INTO agents(id,name,runtime,host_id,created_by_user_id,created_at,updated_at,runtime_transition_started_at,runtime_transition_target)
      VALUES('a','agent','claude','h','u',1,1,2,'codex');
      CREATE TABLE fixture_agent_child(agent_id TEXT REFERENCES agents(id));
      INSERT INTO fixture_agent_child VALUES('a');`);
    const before = db.prepare('SELECT * FROM agents').get();
    expect(() => db.exec("UPDATE agents SET runtime_transition_target='pi'")).toThrow();
    const result = runMigrations(db); expect(result.appliedSteps).toEqual([93]);
    expect(db.prepare('SELECT * FROM agents').get()).toEqual(before);
    expect(db.prepare('SELECT * FROM fixture_agent_child').all()).toEqual([{ agent_id: 'a' }]);
    db.exec("UPDATE agents SET runtime_transition_target='pi'");
    expect(db.prepare('SELECT runtime_transition_target FROM agents').get()).toEqual({ runtime_transition_target: 'pi' });
    expect(() => db.exec("UPDATE agents SET runtime_transition_target='unknown'")).toThrow();
    expect(() => db.exec('UPDATE agents SET runtime_transition_started_at=NULL')).toThrow();
    expect(() => db.exec('UPDATE agents SET runtime_transition_target=NULL')).toThrow();
    db.exec('UPDATE agents SET runtime_transition_target=NULL,runtime_transition_started_at=NULL');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(runMigrations(db).appliedSteps).toEqual([]);
  } finally { db.close(); }
});
