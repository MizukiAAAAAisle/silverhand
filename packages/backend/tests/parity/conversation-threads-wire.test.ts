import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/conversation-threads-wire.json' with { type: 'json' };

function seed(t: TestApp): void {
  const host = t.ctx.db.prepare('SELECT id FROM hosts ORDER BY id LIMIT 1')
    .pluck().get() as string;
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at) VALUES
      ('root-user','root-user','Root User',1,1),
      ('reply-a','reply-a','Reply A',1,1),
      ('reply-b','reply-b','Reply B',1,1),
      ('reply-c','reply-c','Reply C',1,1),
      ('reply-d','reply-d','Reply D',1,1);
  `);
  t.ctx.db.prepare(`
    INSERT INTO agents(
      id,name,runtime,host_id,created_at,updated_at,created_by_user_id,display_name
    ) VALUES('root-agent','root-agent','codex',?,1,1,'local','Root Agent')
  `).run(host);
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('threads-w','Threads Workspace','threads-workspace',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at,role)
      VALUES('threads-w','local',1,'member');
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      created_at,updated_at
    ) VALUES('c','threads-w','workspace','open','Threads','threads','idle','private',1,1);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);

    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES('root-1','c','user','root-user','root one',1,10,
      'root-user','root-user','Root User');
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id,
      author_id,author_name,author_display_name
    ) VALUES('r1-a','c','user','reply-a','reply',2,20,'root-1',
      'reply-a','reply-a','Reply A');
    INSERT INTO messages(id,conversation_id,from_kind,content,seq,created_at)
      VALUES('root-2','c','system','system root',3,11);
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id,
      author_id,author_name,author_display_name
    ) VALUES('r2-b','c','user','reply-b','reply',4,20,'root-2',
      'reply-b','reply-b','Reply B');
    INSERT INTO messages(
      id,conversation_id,from_kind,from_agent_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES('root-3','c','agent','root-agent','root three',5,12,
      'root-agent','root-agent','Root Agent');
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id,
      author_id,author_name,author_display_name
    ) VALUES
      ('r3-c','c','user','reply-c','reply',6,21,'root-3','reply-c','reply-c','Reply C'),
      ('r3-d','c','user','reply-d','reply',7,22,'root-3','reply-d','reply-d','Reply D'),
      ('r3-a','c','user','reply-a','reply',8,23,'root-3','reply-a','reply-a','Reply A'),
      ('r3-b','c','user','reply-b','reply',9,30,'root-3','reply-b','reply-b','Reply B');
    INSERT INTO thread_followers(
      thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source
    ) VALUES
      ('root-1','c','human','local',1,'manual'),
      ('root-3','c','human','local',1,'manual');
    INSERT INTO conversation_reads(
      user_id,conversation_id,thread_root_id,last_read_seq,read_at
    ) VALUES('local','c','root-1',2,1);
  `);
}

describe('conversation threads fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the minimal author, replier, filter, tie and cursor combinations', async () => {
    t = buildTestApp();
    seed(t);
    for (const entry of fixture) {
      const response = await http(t).get(`/api/conversations/c/threads${entry.query}`);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
    }
    expect(fixture).toHaveLength(3);
  });
});
