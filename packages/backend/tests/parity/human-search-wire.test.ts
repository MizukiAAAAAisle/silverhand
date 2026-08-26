import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/human-search-wire.json' with { type: 'json' };

function seed(t: TestApp): void {
  const host = t.ctx.db.prepare('SELECT id FROM hosts ORDER BY id LIMIT 1').pluck().get() as string;
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at)
      VALUES('gone','gone','Gone',1,1);
    INSERT INTO agents(id,name,runtime,host_id,created_by_user_id,created_at,updated_at,display_name)
      VALUES('pair-agent','pair-agent','codex','${host}','local',1,1,'Pair Agent');
    INSERT INTO workspaces(id,name,name_key,description,created_at,updated_at)
      VALUES('w','cap-needle workspace','cap-needle-workspace','cap discovery',1,2);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at,role)
      VALUES('w','local',1,'member');
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      created_at,updated_at
    ) VALUES('c','w','workspace','open','Cap-Needle Channel','cap-needle-channel','idle','private',1,2);
    INSERT INTO conversations(
      id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,endpoint_b_kind,
      endpoint_b_id,title,status,visibility,created_at,updated_at
    ) VALUES('pair','direct_pair','fixed','agent','pair-agent','human','local','','idle','private',1,1);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1);
    INSERT INTO messages(id,conversation_id,from_kind,content,seq,created_at) VALUES
      ('cap-1','c','system','cap-needle one',1,10),
      ('cap-2','c','system','cap-needle two',2,11),
      ('cap-3','c','system','cap-needle three',3,12),
      ('thread-root','c','system','thread root',4,20),
      ('pair-message','pair','system','dm-needle',1,30);
    INSERT INTO messages(id,conversation_id,from_kind,content,seq,created_at,thread_root_id)
      VALUES('thread-reply','c','system','thread-needle',5,21,'thread-root');
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES('deleted-message','c','user','gone','deleted-needle',6,22,'gone','gone','Gone');
    DELETE FROM users WHERE id='gone';
  `);
}

describe('human search fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs only named-cap/count, direct-pair, root normalization and deleted-sender combinations', async () => {
    t = buildTestApp();
    seed(t);
    for (const entry of fixture) {
      const response = await http(t).get(`/api/search${entry.query}`);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
    }
    expect(fixture).toHaveLength(4);
  });
});
