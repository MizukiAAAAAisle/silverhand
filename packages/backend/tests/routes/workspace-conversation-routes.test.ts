import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('workspace/conversation routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists regular and agent_home workspaces with their channel conversations', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const workspaces = await (
      await http(t).get('/api/workspaces')
    ).json() as any;
    const regular = workspaces.workspaces.find((w: any) => w.id === workspaceBody.workspace.id);
    const home = workspaces.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentBody.agent.id,
    );
    expect(regular).toBeDefined();
    expect(home).toBeDefined();
    expect(home.dm_channel_ids).toEqual([home.dm_channel_id]);

    const channels = await (
      await http(t).get(`/api/workspaces/${workspaceBody.workspace.id}/channels`)
    ).json() as any;
    expect(channels.channels).toHaveLength(1);
    expect(channels.channels[0]).toMatchObject({
      id: workspaceBody.onboarding_channel_id,
      workspace_id: workspaceBody.workspace.id,
      kind: 'channel',
      workspace_path: workspaceBody.workspace.workspace_path,
    });

    const dms = await (
      await http(t).get(`/api/workspaces/${home.id}/channels`)
    ).json() as any;
    expect(dms.channels).toHaveLength(1);
    expect(dms.channels[0]).toMatchObject({
      kind: 'dm_channel',
      workspace_id: home.id,
      workspace_path: join(t.ctx.silverhandDir, 'agents', agentBody.agent.id),
    });

    const secondary = await (
      await http(t).post(`/api/workspaces/${home.id}/channels`, {
        title: 'Mentions',
        member_agent_ids: [],
      })
    ).json() as any;
    expect(secondary.channel).toMatchObject({
      kind: 'dm_channel',
      workspace_id: home.id,
      title: 'Mentions',
    });
    const dmsAfter = await (
      await http(t).get(`/api/workspaces/${home.id}/channels`)
    ).json() as any;
    expect(dmsAfter.channels.map((c: any) => c.id)).toEqual([
      dms.channels[0].id,
      secondary.channel.id,
    ]);
    const workspacesAfter = await (
      await http(t).get('/api/workspaces')
    ).json() as any;
    const homeAfter = workspacesAfter.workspaces.find((w: any) => w.id === home.id);
    expect(homeAfter.dm_channel_id).toBe(dms.channels[0].id);
    expect(homeAfter.dm_channel_ids).toEqual([
      dms.channels[0].id,
      secondary.channel.id,
    ]);
  });

  it('enforces channel/thread kind guards on message routes', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'bob', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t).post('/api/workspaces', {
        name: 'guards',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const channelId = workspaceBody.onboarding_channel_id;
    expect((await http(t).get(`/api/channels/${channelId}/messages`)).status)
      .toBe(200);
    expect((await http(t).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);

    const msgBody = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'start a thread here',
      })
    ).json() as any;
    const threadBody = await (
      await http(t).post(`/api/messages/${msgBody.message.id}/thread`)
    ).json() as any;
    const threadId = threadBody.thread_id;

    expect((await http(t).get(`/api/channels/${threadId}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${threadId}/messages`)).status)
      .toBe(200);
  });

  it('writes user_id into conversation_users when creating a DM under agent_home (v25 PR-A blocker fix)', async () => {
    // Regression for PR-A blocker #2: agent_home POST /channels used
    // to only conversations.addAgent(dm, owner) without writing
    // conversation_users for the human creator. After v25 permission
    // tightening, that left the user unable to GET /messages on the
    // DM they just created.
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const agentBody = await (
      await http(t).post('/api/agents', { name: 'creator', runtime: 'claude' })
    ).json() as any;
    const home = (await (
      await http(t).get('/api/workspaces')
    ).json() as any).workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentBody.agent.id,
    );
    expect(home).toBeDefined();

    // Create a secondary DM under the agent_home as the principal user.
    const created = await http(t).post(`/api/workspaces/${home.id}/channels`, {
      title: 'Mentions',
      member_agent_ids: [],
    });
    expect(created.status).toBe(201);
    const dm = (await created.json() as any).channel;

    // The creator (default 'local') must be a conversation_users
    // member of the new DM, otherwise GET /messages would 403.
    const dmMembers = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
      )
      .all(dm.id)
      .map(r => r.user_id);
    expect(dmMembers).toEqual(['local']);

    // And the route they own must be readable.
    const messagesResp = await http(t).get(`/api/channels/${dm.id}/messages`);
    expect(messagesResp.status).toBe(200);
  });
});
