import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/attention-projection-wire.json' with { type: 'json' };

function seedWorkspace(t: TestApp, member: boolean): void {
  t.ctx.db.prepare(
    `INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
     VALUES('w','W','w-attention-projection',1,1)`,
  ).run();
  if (member) {
    t.ctx.db.prepare(
      `INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
       VALUES('w','local',1)`,
    ).run();
  } else {
    t.ctx.db.prepare(
      `DELETE FROM workspace_users WHERE workspace_id='w' AND user_id='local'`,
    ).run();
  }
}

function seed(t: TestApp, setup: string): void {
  if (setup === 'empty') return;
  const tiered = setup === 'tiered' || setup === 'tiered_unmuted';
  seedWorkspace(t, tiered);
  if (!tiered) return;
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at)
      VALUES('attention-other','other-attention-projection','Other',1,1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      created_at,updated_at,latest_message_seq
    ) VALUES
      ('c-b','w','workspace','open','B','b-attention-projection','open',2,2,1),
      ('c-c','w','workspace','open','C','c-attention-projection','open',1,1,0),
      ('c-a','w','workspace','open','A','a-attention-projection','open',1,1,1);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c-a','local',1),('c-b','local',1),('c-c','local',1);
    INSERT INTO channel_attention_preferences(user_id,conversation_id,mode,updated_at)
      VALUES('local','c-a','mentions',1),('local','c-c','mute',1);
    INSERT INTO workspace_attention_preferences(user_id,workspace_id,muted,updated_at)
      VALUES('local','w',${setup === 'tiered' ? 1 : 0},1);
    INSERT INTO messages(
      id,conversation_id,from_kind,from_user_id,content,seq,created_at,
      author_id,author_name,author_display_name
    ) VALUES
      ('m-a','c-a','user','attention-other','mention',1,1,'attention-other','other-attention-projection','Other'),
      ('m-b','c-b','user','attention-other','plain',1,1,'attention-other','other-attention-projection','Other');
    INSERT INTO notifications(
      id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at
    ) VALUES
      ('n-1','mention_self','local','w','c-a','m-a','{}',1),
      ('n-2','mention_self','local','w','c-a','m-a','{}',2);
  `);
}

describe('attention projection wire is signed by the production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs both cold surfaces and every checked-in case', async () => {
    const surfaces = new Set<string>();
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get(entry.path);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      surfaces.add(entry.surface);
      t.cleanup(); t = null;
    }
    expect([...surfaces].sort()).toEqual(['badges', 'modes']);
    expect(fixture).toHaveLength(11);
  });
});
