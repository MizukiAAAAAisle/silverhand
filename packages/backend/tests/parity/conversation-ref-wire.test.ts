import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/conversation-ref-wire.json' with { type: 'json' };

type Setup = (typeof fixture)[number]['setup'];

function seed(t: TestApp, setup: Setup): void {
  if (setup === 'missing_conversation') return;
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','conversation-ref-wire',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
      VALUES('w','local',1);
  `);
  if (setup === 'direct_pair_endpoint' || setup === 'direct_pair_nonendpoint') {
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
  const roster = setup === 'fixed_workspace_nonmember' ? 'fixed' : 'open';
  const visibility = setup === 'public_workspace_nonmember'
      || setup === 'archived_public_nonmember'
    ? 'public'
    : 'private';
  const archived = setup === 'archived_public_nonmember' || setup === 'archived_member'
    ? '9'
    : 'NULL';
  t.ctx.db.exec(`
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      archived_at,created_at,updated_at
    ) VALUES('c','w','workspace','${roster}','General','general-ref-wire','idle',
      '${visibility}',${archived},1,1);
  `);
  if (setup !== 'member_active_open' && setup !== 'archived_member') {
    // The production test app seeds a new channel from current workspace users.
    // Remove that inherited seat so these cells prove the public/nonmember arm.
    t.ctx.db.prepare(
      'DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?',
    ).run('c', 'local');
  }
}

describe('conversation ref cutover fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the public-aware gate and workspace-face narrowing', async () => {
    for (const entry of fixture) {
      t = buildTestApp();
      seed(t, entry.setup);
      const response = await http(t).get('/api/conversations/c/ref');
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(9);
    expect(fixture.filter((entry) => entry.status === 200)).toHaveLength(3);
    expect(fixture.filter((entry) => entry.status === 403)).toHaveLength(4);
    expect(fixture.filter((entry) => entry.status === 404)).toHaveLength(2);
  });
});
