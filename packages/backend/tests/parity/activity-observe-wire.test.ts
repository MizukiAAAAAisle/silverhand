import { afterEach, describe, expect, it } from 'vitest';
import { ObserveInputSchema } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/activity-observe-wire.json' with { type: 'json' };

function seed(t: TestApp): void {
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at)
      VALUES('observe-other','observe-other','Other',1,1);
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Observe','observe-wire',1,1),('w2','Forbidden','forbidden-observe-wire',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      created_at,updated_at,latest_message_seq
    ) VALUES('c','w','workspace','open','General','general-observe-wire','open',1,1,2);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      created_at,updated_at,latest_message_seq
    ) VALUES('forbidden','w2','workspace','fixed','Private','private-observe-wire','open',1,1,0);
    INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
      VALUES('c','local',1);
    INSERT INTO messages(id,conversation_id,from_kind,from_user_id,content,seq,created_at,thread_root_id)
      VALUES('m1','c','user','observe-other','one',1,1,NULL),
            ('m2','c','user','observe-other','two',2,2,NULL),
            ('root','c','user','observe-other','root',3,3,NULL),
            ('reply','c','user','observe-other','reply',4,4,'root');
    INSERT INTO conversation_stream_heads(conversation_id,thread_root_id,latest_seq)
      VALUES('c',NULL,2);
    INSERT INTO notifications(id,kind,user_id,workspace_id,conversation_id,message_id,payload,created_at)
      VALUES('n1','mention_self','local','w','c','m1','{}',1);
  `);
}

describe('Activity observe cutover fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs shared wire exactly and divergent invalid input as an admission verdict', async () => {
    for (const entry of fixture as Array<
      (typeof fixture)[number] & {
        request_json?: string;
        ts_authority?: 'admission_only';
        schema_accepted: boolean;
      }
    >) {
      const input = entry.request_json === undefined
        ? entry.request
        : JSON.parse(entry.request_json);
      expect(ObserveInputSchema.safeParse(input).success, entry.name)
        .toBe(entry.schema_accepted);
      if (entry.ts_authority === 'admission_only') continue;

      t = buildTestApp();
      seed(t);
      const response = await http(t).post(
        '/api/attention/observe',
        entry.request,
        entry.request_json === undefined ? undefined : { body: entry.request_json },
      );
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture.filter((entry) => entry.schema_accepted)).toHaveLength(11);
    expect(fixture.filter((entry) => !entry.schema_accepted)).toHaveLength(8);
    expect(fixture).toHaveLength(19);
  });
});
