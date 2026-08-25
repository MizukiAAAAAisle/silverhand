import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/attention-preference-wire.json' with { type: 'json' };

function seed(t: TestApp): void {
  t.ctx.db.prepare(
    `INSERT INTO workspaces(id,name,name_key,created_at,updated_at,owner_user_id)
     VALUES('w','W','w-attention-fixture',1,1,'local')`,
  ).run();
  t.ctx.db.prepare(
    `INSERT OR IGNORE INTO workspace_users(workspace_id,user_id,joined_at)
     VALUES('w','local',1)`,
  ).run();
  t.ctx.db.prepare(
    `INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,created_at,updated_at)
     VALUES('c','w','workspace','open','C','c-attention-fixture','open',1,1)`,
  ).run();
  t.ctx.db.prepare(
    `INSERT OR IGNORE INTO conversation_users(conversation_id,user_id,joined_at)
     VALUES('c','local',1)`,
  ).run();
}

describe('attention preference wire is signed by the production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('consumes the closed set of the three preference routes', async () => {
    const surfaces = new Set<string>();
    for (const entry of fixture as any[]) {
      t = buildTestApp();
      seed(t);
      const response = entry.method === 'GET'
        ? await http(t).get(entry.path)
        : await http(t).put(entry.path, entry.request);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(entry.body);
      surfaces.add(entry.surface);
      t.cleanup(); t = null;
    }
    expect([...surfaces].sort()).toEqual(['channel_put','workspace_get','workspace_put']);
  });
});
