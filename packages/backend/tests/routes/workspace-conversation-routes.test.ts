import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('workspace/conversation routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lists regular workspaces and their channel conversations without exposing the DM workspace', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t.app).post('/api/workspaces', {
        name: 'eng',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const workspaces = await (
      await http(t.app).get('/api/workspaces')
    ).json() as any;
    expect(workspaces.workspaces.map((w: any) => w.id)).toEqual([
      workspaceBody.workspace.id,
    ]);

    const channels = await (
      await http(t.app).get(`/api/workspaces/${workspaceBody.workspace.id}/channels`)
    ).json() as any;
    expect(channels.channels).toHaveLength(1);
    expect(channels.channels[0]).toMatchObject({
      id: workspaceBody.onboarding_channel_id,
      workspace_id: workspaceBody.workspace.id,
      kind: 'channel',
      workspace_path: workspaceBody.workspace.workspace_path,
    });

    const dms = await (
      await http(t.app).get('/api/workspaces/system/dm-channels')
    ).json() as any;
    expect(dms.dm_channels).toHaveLength(1);
    expect(dms.dm_channels[0]).toMatchObject({
      kind: 'dm_channel',
      workspace_path: join(t.ctx.silverhandDir, 'agents', agentBody.agent.id),
    });
  });

  it('enforces channel/thread kind guards on message routes', async () => {
    t = buildTestApp();
    const agentBody = await (
      await http(t.app).post('/api/agents', { name: 'bob', runtime: 'claude' })
    ).json() as any;
    const workspaceBody = await (
      await http(t.app).post('/api/workspaces', {
        name: 'guards',
        member_agent_ids: [agentBody.agent.id],
      })
    ).json() as any;

    const channelId = workspaceBody.onboarding_channel_id;
    expect((await http(t.app).get(`/api/channels/${channelId}/messages`)).status)
      .toBe(200);
    expect((await http(t.app).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);

    const msgBody = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'start a thread here',
      })
    ).json() as any;
    const threadBody = await (
      await http(t.app).post(`/api/messages/${msgBody.message.id}/thread`)
    ).json() as any;
    const threadId = threadBody.thread_id;

    expect((await http(t.app).get(`/api/channels/${threadId}/messages`)).status)
      .toBe(404);
    expect((await http(t.app).get(`/api/threads/${threadId}/messages`)).status)
      .toBe(200);
  });
});
