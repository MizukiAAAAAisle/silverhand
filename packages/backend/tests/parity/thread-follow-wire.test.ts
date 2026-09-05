import { afterEach, describe, expect, it } from 'vitest';
import fixture from '../fixtures/thread-follow-wire.json' with { type: 'json' };
import { buildTestApp, http, type TestApp } from '../utils/app.js';

type Setup = (typeof fixture)[number]['setup'];

function seed(t: TestApp, setup: Setup): void {
  if (setup === 'missing_conversation') return;
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at)
      VALUES('other','other-thread-follow-fixture','Other',1,1);
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','thread-follow-fixture',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      created_at,updated_at
    ) VALUES('c','w','workspace','open','General','thread-follow-fixture','idle',
      'private',1,1);
  `);
  if (setup === 'forbidden') {
    t.ctx.db.prepare(
      'DELETE FROM conversation_users WHERE conversation_id=? AND user_id=?',
    ).run('c', 'local');
    return;
  }
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);
    INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id)
      VALUES('root','c','user','local','root',1,1,NULL),
            ('reply','c','user','other','reply',2,2,'root');
  `);
  if (setup === 'state_member') {
    const host = t.ctx.db.prepare('SELECT id FROM hosts ORDER BY id LIMIT 1').pluck().get() as string;
    const insert = t.ctx.db.prepare(`
      INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id)
      VALUES(?,?,'claude',?,1,1,'local')
    `);
    insert.run('agent-a', 'agent-a-thread-follow-fixture', host);
    insert.run('agent-b', 'agent-b-thread-follow-fixture', host);
    insert.run('agent-x', 'agent-x-thread-follow-fixture', host);
    t.ctx.db.exec(`
      INSERT INTO conversation_agents(conversation_id,agent_id,joined_at)
        VALUES('c','agent-a',1),('c','agent-b',1);
      INSERT INTO thread_followers(
        thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source
      ) VALUES('root','c','human','local',1,'manual'),
              ('root','c','agent','agent-a',2,'mention'),
              ('root','c','agent','agent-b',3,'reply'),
              ('root','c','agent','agent-x',4,'manual');
    `);
  } else if (setup === 'following') {
    t.ctx.db.exec(`
      INSERT INTO thread_followers(
        thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source
      ) VALUES('root','c','human','local',1,'manual');
    `);
  }
}

describe('thread-follow fixture uses the production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs all three operations, refusal order and idempotent mutation wire', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const client = http(t);
      const response = entry.method === 'GET'
        ? await client.get(entry.path)
        : entry.method === 'POST'
          ? await client.post(entry.path)
          : await client.del(entry.path);
      expect(response.status, `${entry.name}:${JSON.stringify(await response.clone().json())}`).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(8);
    expect(new Set(fixture.map(entry => entry.method))).toEqual(new Set(['GET', 'POST', 'DELETE']));
  });
});
