import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<{
  agentId: string;
  dmChannelId: string;
  agentHomeWorkspaceId: string;
}> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
  const home = workspaces.workspaces.find(
    (w: any) =>
      w.workspace_kind === 'agent_home' && w.owner_agent_id === created.agent.id,
  );
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    agentId: created.agent.id,
    dmChannelId: created.dm_channel_id,
    agentHomeWorkspaceId: home.id,
  };
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; onboardingChannelId: string }> {
  const created = await (
    await http(t).post('/api/workspaces', {
      name,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id,
    onboardingChannelId: created.onboarding_channel_id,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  return created.channel.id;
}

function membersPath(id: string): string {
  return `/api/conversations/${id}/members`;
}

describe('GET /api/conversations/:id/members', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns agents + humans for a regular channel, agents-first order', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'planning', [
      alice.agentId,
      bob.agentId,
    ]);

    const res = await http(t).get(membersPath(channelId));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    // Agents first (joined order), then humans.
    const kinds = members.map((m: any) => m.kind);
    const firstHumanIdx = kinds.indexOf('human');
    const lastAgentIdx = kinds.lastIndexOf('agent');
    expect(lastAgentIdx).toBeGreaterThan(-1);
    expect(firstHumanIdx).toBeGreaterThan(lastAgentIdx);
    // Both agents are present.
    const agentIds = members
      .filter((m: any) => m.kind === 'agent')
      .map((m: any) => m.agent_id);
    expect(agentIds).toContain(alice.agentId);
    expect(agentIds).toContain(bob.agentId);
    // Agent fields are populated for the chip strip.
    const aliceMember = members.find(
      (m: any) => m.kind === 'agent' && m.agent_id === alice.agentId,
    );
    expect(aliceMember).toMatchObject({
      kind: 'agent',
      agent_id: alice.agentId,
      name: 'alice',
      runtime: 'claude',
    });
    expect(typeof aliceMember.display_name).toBe('string');
    // The fixture's `local` user is auto-seeded into every conversation
    // by the test fixture's seed triggers (see tests/utils/db.ts).
    const humanIds = members
      .filter((m: any) => m.kind === 'human')
      .map((m: any) => m.user_id);
    expect(humanIds).toContain('local');
  });

  it('returns the same shape for a thread (members snapshotted from parent at create)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-y', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'investigations', [
      alice.agentId,
    ]);
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId,
      title: 'perf-dive',
    });
    // Snapshot the parent's agents into the thread (the production path
    // goes via ThreadService; here the unit test uses ConversationRepo
    // directly, then opts into the same per-thread membership rows).
    for (const ca of conversations.listAgents(channelId)) {
      conversations.addAgent(thread.id, ca.agent_id);
    }

    const res = await http(t).get(membersPath(thread.id));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    const agents = members.filter((m: any) => m.kind === 'agent');
    expect(agents.map((m: any) => m.agent_id)).toEqual([alice.agentId]);
  });

  it("returns dm channel members (agent + viewer)", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');

    const res = await http(t).get(membersPath(alice.dmChannelId));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    expect(members.find((m: any) => m.kind === 'agent')?.agent_id).toBe(
      alice.agentId,
    );
    const humanIds = members
      .filter((m: any) => m.kind === 'human')
      .map((m: any) => m.user_id);
    expect(humanIds).toContain('local');
  });

  it('returns 404 for a missing conversation id', async () => {
    t = buildTestApp();
    const res = await http(t).get(membersPath('nonexistent-id'));
    expect(res.status).toBe(404);
  });

  it('rejects unauthorized callers with 401 (token guard upstream)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const res = await t.app.fetch(
      new Request(`http://localhost${membersPath(alice.dmChannelId)}`, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-member user (non-system) with 403', async () => {
    // canViewConversation is strict membership-only for human principals
    // (v25 PR-A tightening). Drop the auto-seed triggers + the viewer's
    // membership rows for the target channel; the route should 403.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-secret', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    // Strip both viewer-seeded edges so the principal is not a member of
    // the workspace nor the conversation.
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);

    const res = await http(t).get(membersPath(channelId));
    expect(res.status).toBe(403);
  });
});
