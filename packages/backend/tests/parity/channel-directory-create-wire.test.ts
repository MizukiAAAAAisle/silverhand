import { afterEach, describe, expect, it } from 'vitest';
import { CreateConversationChannelInputSchema } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/channel-directory-create-wire.json' with { type: 'json' };

function requestInput(entry: any): unknown {
  switch (entry.request_case) {
    case 'title_129': return { title: 'x'.repeat(129) };
    case 'malformed_json': return {};
    case undefined: return entry.request;
    default: throw new Error(`unknown create request case ${entry.request_case}`);
  }
}

function expectedBody(entry: any): unknown {
  if (!entry.body_case) return entry.body;
  const source = fixture.find(candidate => candidate.name === entry.body_case);
  if (!source) throw new Error(`missing create body case ${entry.body_case}`);
  return expectedBody(source);
}

function normalize(value: unknown, homeId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!root.channel || typeof root.channel !== 'object' || Array.isArray(root.channel)) {
    return value;
  }
  const channel = { ...(root.channel as Record<string, unknown>) };
  channel.id = 'created';
  channel.created_at = 77;
  channel.updated_at = 77;
  if (channel.workspace_id === homeId) channel.workspace_id = 'workspace-home';
  return { ...root, channel };
}

async function seed(t: TestApp): Promise<string> {
  t.ctx.db.exec(`
    INSERT INTO users(id,name,display_name,created_at,updated_at) VALUES
      ('user-member','wire-user-member','Member',1,1),
      ('user-outsider','wire-user-outsider','Outsider',1,1);
    INSERT INTO hosts(id,name,kind,created_at) VALUES
      ('wire-create-host','Wire Create Host','local',1);
    INSERT INTO agents(id,name,runtime,host_id,created_at,updated_at,created_by_user_id) VALUES
      ('agent-member','agent-member','claude','wire-create-host',1,1,'local'),
      ('agent-outsider','agent-outsider','claude','wire-create-host',1,1,'local');
    INSERT INTO workspaces(id,name,name_key,owner_agent_id,created_at,updated_at) VALUES
      ('workspace-1','Workspace','channel-create-wire',NULL,1,1),
      ('workspace-2','Forbidden','channel-create-forbidden',NULL,1,1),
      ('workspace-home','agent-member',NULL,'agent-member',1,1);
    INSERT INTO workspace_users(workspace_id,user_id,joined_at,role) VALUES
      ('workspace-1','local',1,'admin'),
      ('workspace-1','user-member',1,'member'),
      ('workspace-home','local',1,'admin');
    INSERT INTO workspace_members(workspace_id,agent_id,joined_at) VALUES
      ('workspace-1','agent-member',1);
    INSERT INTO conversations(id,workspace_id,placement_kind,roster_policy,title,title_key,status,
      visibility,created_at,updated_at) VALUES
      ('taken','workspace-1','workspace','open','Taken','taken','idle','private',1,1);
  `);
  return 'workspace-home';
}

describe('channel-directory create wire is signed by the production TypeScript route/schema', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('locks admission, refusal and both regular/agent-home success arms', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const homeId = await seed(t);
    let accepted = 0;
    let rejected = 0;
    for (const entry of fixture as any[]) {
      const parsed = CreateConversationChannelInputSchema.safeParse(requestInput(entry));
      expect(parsed.success, `${entry.name}: schema admission`).toBe(entry.schema_accepted);
      if (parsed.success) accepted += 1;
      else rejected += 1;

      const path = entry.path.replaceAll('workspace-home', homeId);
      const response = entry.request_case === 'malformed_json'
        ? await http(t).post(path, undefined, {
            body: '{',
            headers: { 'content-type': 'application/json' },
          })
        : await http(t).post(path, requestInput(entry));
      expect(response.status, entry.name).toBe(entry.status);
      expect(normalize(await response.json(), homeId), entry.name).toEqual(expectedBody(entry));
    }
    expect([accepted, rejected]).toEqual([12, 12]);
    expect(fixture).toHaveLength(24);
  });
});
