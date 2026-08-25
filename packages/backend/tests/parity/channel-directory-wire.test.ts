import { afterEach, describe, expect, it } from 'vitest';
import { ArchivedChannelsQueryInputSchema } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/channel-directory-wire.json' with { type: 'json' };

function expectedBody(entry: any): unknown {
  if (!entry.body_case) return entry.body;
  const source = fixture.find(candidate => candidate.name === entry.body_case);
  if (!source) throw new Error(`missing channel-directory body case ${entry.body_case}`);
  return expectedBody(source);
}

function seed(t: TestApp): void {
  t.ctx.db.exec(`
    INSERT INTO workspaces(id,name,name_key,created_at,updated_at) VALUES
      ('workspace-1','Workspace','channel-directory-wire',1,1),
      ('workspace-2','Forbidden','channel-directory-forbidden',1,1);
    INSERT INTO workspace_users(workspace_id,user_id,joined_at) VALUES
      ('workspace-1','local',1);
    INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      visibility,archived_at,created_at,updated_at) VALUES
      ('conversation-public','workspace-1','workspace','open','Public','directory-public','active','public',NULL,1,1),
      ('conversation-member','workspace-1','workspace','open','Member','directory-member','idle','private',NULL,2,2),
      ('conversation-hidden','workspace-1','workspace','open','Hidden','directory-hidden','idle','private',NULL,4,4),
      ('conversation-archived','workspace-1','workspace','open','Archived','directory-archived','archived','private',10,3,10);
    INSERT INTO conversation_users(conversation_id,user_id,joined_at) VALUES
      ('conversation-member','local',1),('conversation-archived','local',1);
    INSERT INTO user_list_sort_mode(user_id,list_key,scope,mode,updated_at) VALUES
      ('local','channels:workspace-1','','manual',1);
    INSERT INTO user_sort_entry(user_id,list_key,entity_id,rank,last_accessed_at,starred_at) VALUES
      ('local','channels:workspace-1','conversation-member',1,4,5),
      ('local','channels:workspace-1','conversation-public',2,3,NULL),
      ('local','channels:workspace-1','conversation-hidden',0,9,NULL);
  `);
}

describe('channel-directory wire is signed by the production TypeScript routes and schema', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('locks the three read surfaces and gives query admission its real authority', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    seed(t);

    let schemaAccepted = 0;
    let schemaRejected = 0;
    for (const entry of fixture) {
      if (entry.surface === 'global_archived') {
        const url = new URL(entry.path, 'http://silverhand.test');
        const parsed = ArchivedChannelsQueryInputSchema.safeParse({
          workspace_id: url.searchParams.get('workspace_id') ?? undefined,
          since: url.searchParams.get('since') ?? undefined,
        });
        expect(parsed.success, `${entry.name}: schema admission`).toBe(entry.schema_accepted);
        if (parsed.success) schemaAccepted += 1;
        else schemaRejected += 1;
        if (!entry.schema_accepted) continue;
      }

      const response = await http(t).get(entry.path);
      expect(response.status, entry.name).toBe(entry.status);
      expect(await response.json(), entry.name).toEqual(expectedBody(entry));
    }

    expect([schemaAccepted, schemaRejected]).toEqual([11, 3]);
    expect([...new Set(fixture.map(entry => entry.surface))].sort()).toEqual([
      'active', 'global_archived', 'workspace_archived',
    ]);
    expect(fixture).toHaveLength(20);
  });
});
