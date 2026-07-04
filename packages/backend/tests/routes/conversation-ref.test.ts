import { afterEach, describe, expect, it } from 'vitest';
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

function refPath(id: string): string {
  return `/api/conversations/${id}/ref`;
}

describe('GET /api/conversations/:id/ref', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns a regular channel ref with workspace metadata', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'planning', [
      alice.agentId,
    ]);

    const res = await http(t).get(refPath(channelId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref).toMatchObject({
      id: channelId,
      kind: 'channel',
      title: 'planning',
      workspace_id: reg.workspaceId,
      workspace_kind: 'regular',
      parent_channel_id: null,
      parent_title: null,
      closed_at: null,
      archived_at: null,
    });
    expect(typeof ref.workspace_path).toBe('string');
    expect(ref.workspace_path.length).toBeGreaterThan(0);
  });

  it("projects an agent's dm_channel ref with workspace_kind='dm' (not agent_home)", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');

    const res = await http(t).get(refPath(alice.dmChannelId));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref).toMatchObject({
      id: alice.dmChannelId,
      kind: 'dm_channel',
      workspace_id: alice.agentHomeWorkspaceId,
      // The hard contract: external callers never see 'agent_home'.
      workspace_kind: 'dm',
      parent_channel_id: null,
      parent_title: null,
    });
  });

  it('returns 404 for a missing conversation id', async () => {
    t = buildTestApp();
    const res = await http(t).get(refPath('nonexistent-id'));
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error).toContain('not found');
  });

  it('exposes refs across workspaces (no per-workspace narrowing)', async () => {
    // The ref endpoint is not narrowed to the currently-open
    // workspace. A user can resolve any conversation they are a member
    // of, even if the main pane is on a different workspace.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const wsA = await createRegularWorkspace(t, 'ws-a', [alice.agentId]);
    const wsB = await createRegularWorkspace(t, 'ws-b', [alice.agentId]);
    const channelInB = await createChannel(t, wsB.workspaceId, 'b-channel', [
      alice.agentId,
    ]);

    // Sanity: this is a real cross-workspace lookup.
    expect(wsA.workspaceId).not.toBe(wsB.workspaceId);

    const res = await http(t).get(refPath(channelInB));
    expect(res.status).toBe(200);
    const { ref } = await res.json() as any;
    expect(ref.workspace_id).toBe(wsB.workspaceId);
  });

  it('rejects a workspace member who is not a conversation member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-secret-ref', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);

    const res = await http(t).get(refPath(channelId));
    expect(res.status).toBe(403);
  });

  it('rejects unauthorized callers with 401 (token guard upstream)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    // Use the raw app with no Bearer header to exercise the public
    // bearer middleware. This is the same shape as a UI session that
    // failed to attach a token; we just verify the route doesn't leak
    // ref data without an auth header.
    const res = await t.app.fetch(
      new Request(`http://localhost${refPath(alice.dmChannelId)}`, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(401);
  });
});
