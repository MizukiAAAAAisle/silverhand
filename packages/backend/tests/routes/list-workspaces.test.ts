import { join } from 'node:path';
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
  // Fetch the newly created agent_home so tests don't have to derive
  // the workspace id from the agent id directly.
  const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
  const home = workspaces.workspaces.find(
    (w: any) =>
      w.workspace_kind === 'agent_home' && w.owner_agent_id === created.agent.id,
  );
  // Reset fan-out side-effects from provision so subsequent assertions
  // about ConversationManager are clean.
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

function listWorkspacesPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/list-workspaces`;
}

function listChannelsPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/list-channels`;
}

describe('agent list_workspaces / list_channels(workspace_id?) routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns regular workspaces the agent is a member of plus its own agent_home, sorted regular-first', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const regSolo = await createRegularWorkspace(t, 'solo', [alice.agentId]);
    // Workspace alice is NOT a member of:
    await createRegularWorkspace(t, 'others-only', [bob.agentId]);

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.workspaces.map((w: any) => w.id);
    expect(ids).toContain(reg.workspaceId);
    expect(ids).toContain(regSolo.workspaceId);
    expect(ids).toContain(alice.agentHomeWorkspaceId);
    // bob's home / regular workspaces alice isn't in must NOT appear.
    expect(ids).not.toContain(bob.agentHomeWorkspaceId);
    const otherWorkspaces = await (await http(t).get('/api/workspaces')).json() as any;
    const othersOnly = otherWorkspaces.workspaces.find(
      (w: any) => w.name === 'others-only',
    );
    expect(ids).not.toContain(othersOnly.id);
    // sort: regular first (sort_group=0), then agent_home (sort_group=1).
    const homePos = ids.indexOf(alice.agentHomeWorkspaceId);
    expect(homePos).toBe(ids.length - 1);
  });

  it('emits kind-branched agent_dir: regular = nested L2 profile dir, agent_home = workspace root itself', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);

    expect(regular.kind).toBe('regular');
    expect(home.kind).toBe('agent_home');

    // For regular workspaces, agent_dir is the L2 profile dir nested
    // under the workspace_path.
    const regWorkspace = (await (await http(t).get('/api/workspaces')).json() as any)
      .workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular.agent_dir).toBe(
      join(regWorkspace.workspace_path, '.silverhand', 'agents', alice.agentId),
    );

    // For agent_home, agent_dir IS the workspace root (no nesting).
    const homeWorkspace = (await (await http(t).get('/api/workspaces')).json() as any)
      .workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);
    expect(home.agent_dir).toBe(homeWorkspace.workspace_path);
    expect(home.agent_dir.endsWith(alice.agentId)).toBe(true);
  });

  it('exposes archived flag and immutable identity fields on each entry', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    await http(t).patch(`/api/workspaces/${reg.workspaceId}/archive`, {
      archived: true,
    });

    const res = await http(t).get(listWorkspacesPath(alice.dmChannelId, alice.agentId));
    const body = await res.json() as any;
    const regular = body.workspaces.find((w: any) => w.id === reg.workspaceId);
    expect(regular).toMatchObject({
      id: reg.workspaceId,
      name: 'team-x',
      kind: 'regular',
      archived: true,
    });
    expect(typeof regular.updated_at).toBe('number');
    expect(typeof regular.agent_dir).toBe('string');

    const home = body.workspaces.find((w: any) => w.id === alice.agentHomeWorkspaceId);
    expect(home.archived).toBe(false);
  });

  it('list_channels defaults to source workspace, returns workspace_id in payload', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const extra = await createChannel(t, reg.workspaceId, 'extra', [alice.agentId]);

    // Source conversation = alice's own DM (agent_home), so default
    // list_channels should return the agent_home channels (the DM),
    // NOT the regular workspace channels.
    const fromHome = await http(t).get(
      listChannelsPath(alice.dmChannelId, alice.agentId),
    );
    expect(fromHome.status).toBe(200);
    const homeBody = await fromHome.json() as any;
    expect(homeBody.workspace_id).toBe(alice.agentHomeWorkspaceId);
    expect(homeBody.channels.map((c: any) => c.id)).toContain(alice.dmChannelId);
    expect(homeBody.channels.map((c: any) => c.id)).not.toContain(extra);
  });

  it('list_channels(workspace_id) lets agent_home source reach a regular workspace it is a member of', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const extra = await createChannel(t, reg.workspaceId, 'extra', [alice.agentId]);

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${reg.workspaceId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace_id).toBe(reg.workspaceId);
    const ids = body.channels.map((c: any) => c.id);
    expect(ids).toContain(reg.onboardingChannelId);
    expect(ids).toContain(extra);
    // Should NOT include alice's DM (different workspace).
    expect(ids).not.toContain(alice.dmChannelId);
  });

  it('list_channels(workspace_id) rejects workspaces the agent is not a member of with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const bobOnly = await createRegularWorkspace(t, 'bob-only', [bob.agentId]);

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${bobOnly.workspaceId}`,
    );
    expect(res.status).toBe(403);
  });

  it('list_channels(workspace_id) rejects another agent\'s agent_home with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');

    const res = await http(t).get(
      `${listChannelsPath(alice.dmChannelId, alice.agentId)}?workspace_id=${bob.agentHomeWorkspaceId}`,
    );
    expect(res.status).toBe(403);
  });

  it('list_channels(workspace_id) accepts the source workspace explicitly (no membership check needed)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const onboardingDmConv = reg.onboardingChannelId;

    // Source = the regular workspace's onboarding channel; explicit
    // workspace_id matching the source must succeed even though the
    // canAgentAccessWorkspace fast-path is skipped.
    const res = await http(t).get(
      `${listChannelsPath(onboardingDmConv, alice.agentId)}?workspace_id=${reg.workspaceId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace_id).toBe(reg.workspaceId);
    expect(body.channels.map((c: any) => c.id)).toContain(onboardingDmConv);
  });
});
