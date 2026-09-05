import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/channel-lifecycle-detail-wire.json' with { type: 'json' };

type Setup = (typeof fixture)[number]['setup'];

function seed(t: TestApp, setup: Setup): void {
  if (setup === 'missing') return;
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at)
      VALUES('w','Workspace','lifecycle-wire',1,1);
    INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at,role)
      VALUES('w','local',1,'${setup === 'public_nonmember_admin' || setup === 'archived_member' ? 'admin' : 'member'}');
    UPDATE workspace_users
      SET role='${setup === 'public_nonmember_admin' || setup === 'archived_member' ? 'admin' : 'member'}'
      WHERE workspace_id='w' AND user_id='local';
  `);
  if (setup === 'direct_pair_endpoint' || setup === 'direct_pair_foreign') {
    const endpoints = setup === 'direct_pair_endpoint'
      ? "'human','local','human','other'"
      : "'human','other','human','teammate'";
    t.ctx.db.exec(`
      INSERT INTO conversations(
        id,workspace_id,placement_kind,roster_policy,endpoint_a_kind,endpoint_a_id,
        endpoint_b_kind,endpoint_b_id,title,title_key,status,visibility,created_at,updated_at
      ) VALUES('c',NULL,'direct_pair','fixed',${endpoints},'',NULL,'idle','private',1,2);
    `);
    return;
  }
  const roster = setup === 'fixed_member' ? 'fixed' : 'open';
  const visibility = setup === 'public_nonmember_admin'
    || setup === 'public_member_owner'
    || setup === 'archived_member'
    ? 'public'
    : 'private';
  const archived = setup === 'archived_member' ? '9' : 'NULL';
  t.ctx.db.exec(`
    INSERT INTO conversations(
      id,workspace_id,placement_kind,roster_policy,title,title_key,status,visibility,
      archived_at,created_at,updated_at
    ) VALUES('c','w','workspace','${roster}','General','general','idle',
      '${visibility}',${archived},1,2);
  `);
  if (setup === 'public_nonmember_admin' || setup === 'private_nonmember') {
    // The production fixture app seeds new conversations from workspace users.
    // Remove the inherited seat so these cells exercise public/private admission.
    t.ctx.db.prepare(
      'DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?',
    ).run('c', 'local');
  }
  if (setup !== 'public_nonmember_admin' && setup !== 'private_nonmember') {
    t.ctx.db.exec(
      "INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','local',1);",
    );
  }
  if (setup === 'private_owner' || setup === 'public_member_owner') {
    t.ctx.db.exec(
      "UPDATE workspace_users SET role='owner' WHERE workspace_id='w' AND user_id='local';",
    );
  }
  if (setup === 'private_owner') {
    t.ctx.db.exec(
      "INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES('c','other',1);",
    );
  }
}

describe('channel lifecycle detail fixture uses the production TypeScript route', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('signs the placement, public-read and capability-carrier closed set', async () => {
    for (const entry of fixture) {
      t = buildTestApp({ seedAllFixtureMemberships: false });
      seed(t, entry.setup);
      const response = await http(t).get('/api/channels/c');
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      t.cleanup(); t = null;
    }
    expect(fixture).toHaveLength(10);
    expect(fixture.filter(entry => entry.status === 200)).toHaveLength(7);
    expect(fixture.filter(entry => entry.status === 403)).toHaveLength(2);
    expect(fixture.filter(entry => entry.status === 404)).toHaveLength(1);
  });
});
