import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/activity-wire.json' with { type: 'json' };

function seed(t: TestApp, setup: string): void {
  if (setup === 'empty') return;
  if (setup === 'pair') {
    t.ctx.db.exec(`
      INSERT INTO users(id,name,display_name,created_at,updated_at)
        VALUES('activity-other','other-activity','Other',1,2);
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,title,title_key,status,
        created_at,updated_at,latest_message_seq,
        endpoint_a_kind,endpoint_a_id,endpoint_b_kind,endpoint_b_id
      ) VALUES(
        'pair',NULL,'direct_pair','fixed','',NULL,'open',2,2,1,
        'human','activity-other','human','local'
      );
      INSERT INTO messages(
        id,conversation_id,from_kind,from_user_id,content,seq,created_at,
        author_id,author_name,author_display_name
      ) VALUES(
        'm-pair','pair','user','activity-other','pair unread',1,2,
        'activity-other','other-activity','Other'
      );
      INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
        VALUES('pair',NULL,1);
    `);
    return;
  }
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at)
      VALUES('activity-other','other-activity','Other',1,2);
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','workspace-activity',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      created_at,updated_at,latest_message_seq
    ) VALUES('c','w','workspace','open','General','general-activity','open',1,1,2);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES
      ('m-mention','c','user','activity-other','  directed   text  ',1,1,'activity-other','other-activity','Other'),
      ('m-plain','c','user','activity-other','plain unread',2,2,'activity-other','other-activity','Other');
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
      VALUES('c',NULL,2);
    INSERT INTO notifications(
      id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at
    ) VALUES
      ('n-old','mention_self','local','w','c','m-mention','{}',2),
      ('n-new','mention_self','local','w','c','m-mention','{}',3),
      ('n-fail','agent_start_failed','local','w','c',NULL,
       '{"agent_name":"Alice","error":"runtime down"}',4);
  `);
}

function seedAstralBoundary(t: TestApp): void {
  const content = `${'😀'.repeat(70)}x`;
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at)
      VALUES('activity-other','other-activity','Other',1,2);
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','workspace-activity-astral',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      created_at,updated_at,latest_message_seq
    ) VALUES('c','w','workspace','open','General','general-activity-astral','open',1,1,1);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);
  `);
  t.ctx.db.prepare(`
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES(
      'm-astral','c','user','activity-other',?,1,1,
      'activity-other','other-activity','Other'
    )
  `).run(content);
  t.ctx.db.prepare(`
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
      VALUES('c',NULL,1)
  `).run();
}

describe('Activity wire is signed by the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the complete route surface and every checked-in case', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get(entry.path);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(4);
  });

  it('records the retired TS isolated-surrogate edge as negative cutover evidence', async () => {
    t = buildTestApp();
    seedAstralBoundary(t);
    const response = await http(t).get('/api/activity');
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ preview: string }> };
    const preview = body.items[0]?.preview;
    expect(preview.length).toBe(140);
    // 69 complete emoji occupy units 0..137. The retired `slice(0, 139)`
    // leaves only the high surrogate of emoji 70 before the ellipsis.
    expect(preview.charCodeAt(138)).toBe(0xD83D);
    expect(preview.charCodeAt(139)).toBe(0x2026);
  });
});
