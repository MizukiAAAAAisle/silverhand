import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/conversation-agent-directory-wire.json' with {
  type: 'json',
};

type Setup = (typeof fixture)[number]['setup'];

function seedAgents(t: TestApp): void {
  const host = t.ctx.db.prepare('SELECT id FROM hosts ORDER BY id LIMIT 1')
    .pluck().get() as string;
  const insert = t.ctx.db.prepare(`
    INSERT INTO agents(
      id,name,runtime,host_id,created_at,updated_at,created_by_user_id
    ) VALUES(?,?,'claude',?,?,?,'local')
  `);
  insert.run('agent-a', 'agent-a-directory', host, 1, 1);
  insert.run('agent-b', 'agent-b-directory', host, 2, 2);
  // Insert in reverse lexical order. The shared fixture uses distinct joined_at
  // values, while Rust separately locks its cutover-only tie break by agent id.
  t.ctx.db.exec(`
    INSERT INTO conversation_agents(conversation_id,agent_id,joined_at)
      VALUES('c','agent-b',2),('c','agent-a',1);
    DELETE FROM agent_runtime_slots WHERE agent_id IN ('agent-a','agent-b');
  `);
}

function seed(t: TestApp, setup: Setup): void {
  t.ctx.db.exec(`
    INSERT OR IGNORE INTO users(id,name,display_name,created_at,updated_at)
      VALUES('other','other-agent-directory','Other',1,1),
            ('teammate','teammate-agent-directory','Teammate',1,1);
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
    return;
  }
  const visibility = setup === 'public_workspace_nonmember' ? 'public' : 'private';
  const archived = setup === 'archived_workspace_member' ? '9' : 'NULL';
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','conversation-agent-directory',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      archived_at,created_at,updated_at
    ) VALUES('c','w','workspace','open','General','general-agent-directory','idle',
      '${visibility}',${archived},1,1);
  `);
  if (setup === 'workspace_member' || setup === 'archived_workspace_member') {
    t.ctx.db.exec(`
      INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
        VALUES('c','local',1);
    `);
    seedAgents(t);
  } else {
    t.ctx.db.prepare(
      'DELETE FROM conversation_users WHERE conversation_id=? AND user_id=?',
    ).run('c', 'local');
  }
}

describe('conversation agent directory fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs strict participation and the committed roster-only face', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get('/api/channels/c/agents');
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(6);
    expect(fixture.filter(entry => entry.status === 200)).toHaveLength(3);
    expect(fixture.filter(entry => entry.status === 403)).toHaveLength(2);
    expect(fixture.filter(entry => entry.status === 404)).toHaveLength(1);
  });
});
