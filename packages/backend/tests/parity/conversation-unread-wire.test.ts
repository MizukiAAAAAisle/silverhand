import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/conversation-unread-wire.json' with { type: 'json' };

type Setup = (typeof fixture)[number]['setup'];

function seed(t: TestApp, setup: Setup): void {
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at)
      VALUES('other','other-unread-wire','Other',1,1),
            ('teammate','teammate-unread-wire','Teammate',1,1);
  `);
  if (setup === 'missing_conversation') return;
  if (setup.startsWith('direct_pair')) {
    const endpoints = setup === 'direct_pair_endpoint'
      ? "'human','local','human','other'"
      : "'human','other','human','teammate'";
    t.ctx.db.exec(`
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,
        endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,created_at,updated_at
      ) VALUES('c',NULL,'direct_pair','fixed',${endpoints},'',NULL,'idle','private',1,1);
    `);
  } else {
    const visibility = setup === 'public_workspace_nonmember' ? 'public' : 'private';
    const archived = setup === 'archived_workspace_member' ? '9' : 'NULL';
    t.ctx.db.exec(`
      INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
        VALUES('w','Workspace','conversation-unread-wire',1,1);
      INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
        VALUES('w','local',1);
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
        archived_at,created_at,updated_at
      ) VALUES('c','w','workspace','open','General','general-unread-wire','idle',
        '${visibility}',${archived},1,1);
    `);
    if (setup === 'workspace_member' || setup === 'archived_workspace_member') {
      t.ctx.db.exec(`
        INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
          VALUES('c','local',1);
      `);
    } else {
      t.ctx.db.prepare(
        'DELETE FROM conversation_users WHERE conversation_id=? AND user_id=?',
      ).run('c', 'local');
    }
  }
  if (setup === 'public_workspace_nonmember'
      || setup === 'private_workspace_nonmember'
      || setup === 'direct_pair_nonendpoint') return;

  t.ctx.db.exec(`
    INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id)
      VALUES('main-1','c','user','other','main first',1,1,NULL),
            ('own-main','c','user','local','own',2,2,NULL),
            ('system-main','c','system',NULL,'system',3,3,NULL),
            ('root','c','user','other','root',4,4,NULL),
            ('reply-1','c','user','other','reply one',5,5,'root'),
            ('own-reply','c','user','local','own reply',6,6,'root'),
            ('reply-2','c','user','other','reply two',7,7,'root');
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
      VALUES('c',NULL,4),('c','root',7);
    INSERT INTO conversation_reads(user_id,conversation_id,thread_root_id,last_read_seq,read_at)
      VALUES('local','c',NULL,1,8),('local','c','root',5,8);
    INSERT INTO thread_followers(
      thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source
    ) VALUES('root','c','human','local',8,'manual');
  `);
}

describe('conversation unread cutover fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs strict participation and the two distinct unread faces', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get('/api/conversations/c/unread');
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(7);
    expect(fixture.filter(entry => entry.status === 200)).toHaveLength(3);
    expect(fixture.filter(entry => entry.status === 403)).toHaveLength(3);
    expect(fixture.filter(entry => entry.status === 404)).toHaveLength(1);
  });
});
