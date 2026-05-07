import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = await r.json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

describe('POST /api/workspaces', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates workspace + directory + onboarding channel + auto-spawns members', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const bobId = await makeAgent(t, 'bob');

    const res = await http(t).post('/api/workspaces', {
      name: 'eng',
      description: 'engineering',
      member_agent_ids: [aliceId, bobId],
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.workspace.name).toBe('eng');
    expect(body.workspace.workspace_kind).toBe('regular');
    expect(typeof body.onboarding_channel_id).toBe('string');
    expect(body.channel.kind).toBe('channel');

    const consensus = join(body.workspace.workspace_path, '.silverhand', 'CONSENSUS.md');
    expect((await fs.stat(consensus)).isFile()).toBe(true);

    expect(t.fake.starts.map(s => s.agentId).sort()).toEqual([aliceId, bobId].sort());
    expect(t.fake.delivered).toHaveLength(2);
    expect(t.fake.delivered.every(d => d.conversationId === body.onboarding_channel_id))
      .toBe(true);

    const members = await (
      await http(t).get(`/api/workspaces/${body.workspace.id}/members`)
    ).json() as any;
    expect(members.members.map((m: any) => m.id).sort()).toEqual(
      [aliceId, bobId].sort(),
    );
  });

  it('rejects invalid and duplicate workspace names', async () => {
    t = buildTestApp();
    expect((await http(t).post('/api/workspaces', { name: 'has spaces' })).status)
      .toBe(400);
    expect((await http(t).post('/api/workspaces', { name: 'eng' })).status)
      .toBe(201);
    expect((await http(t).post('/api/workspaces', { name: 'eng' })).status)
      .toBe(409);
  });
});

describe('workspace metadata and membership routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('renames a workspace and broadcasts into open channels', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const created = await (
      await http(t).post('/api/workspaces', {
        name: 'old',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    t.fake.delivered = [];

    const res = await http(t).patch(`/api/workspaces/${created.workspace.id}`, {
      name: 'newname',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace.name).toBe('newname');

    const msgs = await (
      await http(t).get(`/api/channels/${created.onboarding_channel_id}/messages`)
    ).json() as any;
    const renameMsg = msgs.messages.find((m: any) => m.metadata?.subtype === 'rename');
    expect(renameMsg).toBeTruthy();
    expect(renameMsg.metadata.old_name).toBe('old');
    expect(renameMsg.metadata.new_name).toBe('newname');
    expect(t.fake.delivered.some(d => d.messageId === renameMsg.id)).toBe(true);
  });

  it('does not allow workspace_path mutation after creation', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'immutable-path' })
    ).json() as any;
    const res = await http(t).patch(`/api/workspaces/${created.workspace.id}`, {
      workspace_path: '/tmp/other',
    });
    expect(res.status).toBe(400);
  });

  it('adds and removes workspace members', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'ops' })
    ).json() as any;
    const agentId = await makeAgent(t, 'carol');

    const add = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/members`,
      { agent_id: agentId },
    );
    expect(add.status).toBe(201);
    const list1 = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(list1.members.map((m: any) => m.id)).toContain(agentId);

    const rm = await http(t).del(
      `/api/workspaces/${workspace.workspace.id}/members/${agentId}`,
    );
    expect(rm.status).toBe(204);
    const list2 = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/members`)
    ).json() as any;
    expect(list2.members.map((m: any) => m.id)).not.toContain(agentId);
  });
});

describe('workspace channel routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates and lists channel conversations under a workspace', async () => {
    t = buildTestApp();
    const agentId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'product',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const created = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'planning',
        member_agent_ids: [agentId],
      })
    ).json() as any;
    unsubscribe();
    expect(created.channel).toMatchObject({
      kind: 'channel',
      workspace_id: workspace.workspace.id,
      title: 'planning',
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: workspace.workspace.id,
        channel_id: created.channel.id,
      },
    });

    const list = await (
      await http(t).get(`/api/workspaces/${workspace.workspace.id}/channels`)
    ).json() as any;
    expect(list.channels.map((c: any) => c.id)).toContain(created.channel.id);
  });

  it('publishes workspace_channels_changed for human and internal channel creation', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const bobId = await makeAgent(t, 'bob');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'events',
        member_agent_ids: [aliceId, bobId],
      })
    ).json() as any;

    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const human = await (
      await http(t).post(`/api/workspaces/${workspace.workspace.id}/channels`, {
        title: 'human-created',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const internal = await (
      await http(t.app, { authorization: `Bearer ${t.authToken}` }).post(
        `/internal/conversations/${workspace.onboarding_channel_id}/agents/${aliceId}/create-channel`,
        {
          title: 'agent-created',
          context_summary: 'split out',
          initial_prompt: 'continue here',
        },
      )
    ).json() as any;
    unsubscribe();

    expect(workspaceEvents).toEqual([
      {
        kind: 'workspace_channels_changed',
        payload: {
          workspace_id: workspace.workspace.id,
          channel_id: human.channel.id,
        },
      },
      {
        kind: 'workspace_channels_changed',
        payload: {
          workspace_id: workspace.workspace.id,
          channel_id: internal.channel_id,
        },
      },
    ]);
  });

  it('rejects adding a non-workspace member to a channel', async () => {
    t = buildTestApp();
    const workspace = await (
      await http(t).post('/api/workspaces', { name: 'scope' })
    ).json() as any;
    const outsider = await makeAgent(t, 'outsider');
    const res = await http(t).post(
      `/api/workspaces/${workspace.workspace.id}/channels`,
      {
        title: 'bad',
        member_agent_ids: [outsider],
      },
    );
    expect(res.status).toBe(400);
  });
});
