import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/message-unread-wire.json' with { type: 'json' };

type Setup = (typeof fixture)[number]['setup'];

function seedMessages(t: TestApp, conversation: string): void {
  t.ctx.db.exec(`
    INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id)
      VALUES('main-1','${conversation}','user','other','main first',1,1,NULL),
            ('own-main','${conversation}','user','local','own',2,2,NULL),
            ('system-main','${conversation}','system',NULL,'system',3,3,NULL),
            ('root','${conversation}','user','other','root',4,4,NULL),
            ('reply-1','${conversation}','user','other','reply one',5,5,'root'),
            ('own-reply','${conversation}','user','local','own reply',6,6,'root'),
            ('reply-2','${conversation}','user','other','reply two',7,7,'root');
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
      VALUES('${conversation}',NULL,4),('${conversation}','root',7);
    INSERT INTO conversation_reads(user_id,conversation_id,thread_root_id,last_read_seq,read_at)
      VALUES('local','${conversation}',NULL,1,8),('local','${conversation}','root',5,8);
    INSERT INTO thread_followers(
      thread_root_id,conversation_id,principal_kind,principal_id,followed_at,source
    ) VALUES('root','${conversation}','human','local',8,'manual');
  `);
}

function seed(t: TestApp, setup: Setup): void {
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at)
      VALUES('other','other-message-unread','Other',1,1);
  `);
  if (setup === 'summary_empty' || setup === 'missing_workspace'
      || setup === 'missing_conversation') return;
  if (setup === 'direct_pair_endpoint') {
    t.ctx.db.exec(`
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,
        endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,created_at,updated_at
      ) VALUES('c',NULL,'direct_pair','fixed','human','local','human','other','',NULL,
        'idle','private',1,1);
    `);
    seedMessages(t, 'c');
    return;
  }

  const archived = setup === 'archived_workspace_member' ? '9' : 'NULL';
  const visibility = setup === 'public_workspace_nonmember' ? 'public' : 'private';
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','message-unread',1,1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      archived_at,created_at,updated_at
    ) VALUES('c','w','workspace','open','General','general-message-unread','idle',
      '${visibility}',${archived},1,1);
  `);
  if (setup !== 'workspace_forbidden') {
    t.ctx.db.exec(`
      INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at) VALUES('w','local',1);
    `);
  } else {
    t.ctx.db.prepare(
      'DELETE FROM workspace_users WHERE workspace_id=? AND user_id=?',
    ).run('w', 'local');
  }
  if (setup !== 'workspace_forbidden' && setup !== 'public_workspace_nonmember') {
    t.ctx.db.exec(`
      INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1);
    `);
    seedMessages(t, 'c');
  } else if (setup === 'public_workspace_nonmember') {
    t.ctx.db.prepare(
      'DELETE FROM conversation_users WHERE conversation_id=? AND user_id=?',
    ).run('c', 'local');
  }
  if (setup === 'workspace_member') {
    t.ctx.db.exec(`
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
        created_at,updated_at
      ) VALUES('c2','w','workspace','open','Second','second-message-unread','idle','private',2,2);
      INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c2','local',2);
      INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at)
        VALUES('c2-message','c2','user','other','other conversation',1,9);
      INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
        VALUES('c2',NULL,1);
    `);
  }
}

describe('message unread fixture uses the three production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the closed route set, ACL order and roll-up envelopes', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get(entry.path);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(new Set(fixture.map(entry => entry.surface))).toEqual(
      new Set(['workspace', 'summary', 'conversation']),
    );
    expect(fixture).toHaveLength(10);
  });
});
