import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  encodeUserPrincipalHeader,
  readRenameMetadata,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';

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
    const msgs = await (
      await http(t).get(`/api/channels/${body.onboarding_channel_id}/messages`)
    ).json() as any;
    const onboardingMessages = msgs.messages.filter(
      (m: any) => m.metadata?.subtype === 'onboarding',
    );
    expect(onboardingMessages).toHaveLength(2);
    // Workspace onboarding: tell the agent role is auto-loaded from L1 and
    // workspace-scoped collaboration goes into THIS workspace's MEMORY/notes.
    expect(onboardingMessages[0].content).toContain(
      'just joined workspace',
    );
    expect(onboardingMessages[0].content).toContain('auto-loaded above');
    expect(onboardingMessages[0].content).toContain('Active Workspace Memory');
    // Scope rule: global → L1 system_prompt.md, workspace-scoped → L2.
    // Drift guard for R1: must NOT contain "DM-only / redirect-to-DM"
    // wording — that restriction was retracted.
    expect(onboardingMessages[0].content).toContain('write by scope');
    expect(onboardingMessages[0].content).toContain('L1 system_prompt.md');
    expect(onboardingMessages[0].content).toContain('L2 MEMORY.md');
    expect(onboardingMessages[0].content).not.toMatch(/redirect them to your DM/i);
    expect(onboardingMessages[0].content).not.toMatch(/do NOT modify your global system_prompt\.md/i);

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
    // PR-6 producer round-trip: rename metadata must satisfy
    // RenameMetadataSchema so the renderer can draw a structured
    // audit row without re-parsing message.content.
    const renameParsed = readRenameMetadata(renameMsg.metadata);
    expect(renameParsed).not.toBeNull();
    expect(renameParsed!.old_name).toBe('old');
    expect(renameParsed!.new_name).toBe('newname');
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

  it('pins and unpins regular workspaces', async () => {
    t = buildTestApp();
    const first = await (
      await http(t).post('/api/workspaces', { name: 'pin-first' })
    ).json() as any;
    const second = await (
      await http(t).post('/api/workspaces', { name: 'pin-second' })
    ).json() as any;

    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
    try {
      const pin = await http(t).post(
        `/api/workspaces/${first.workspace.id}/pin`,
      );
      expect(pin.status).toBe(200);
      const pinned = await pin.json() as any;
      expect(pinned.workspace.pinned_at).toBe(1_000);
      const secondPin = await http(t).post(
        `/api/workspaces/${second.workspace.id}/pin`,
      );
      expect(secondPin.status).toBe(200);
    } finally {
      now.mockRestore();
    }

    const listed = await (await http(t).get('/api/workspaces')).json() as any;
    expect(listed.workspaces.map((w: any) => w.id).slice(0, 2)).toEqual([
      second.workspace.id,
      first.workspace.id,
    ]);

    const unpin = await http(t).del(
      `/api/workspaces/${first.workspace.id}/pin`,
    );
    expect(unpin.status).toBe(200);
    const unpinned = await unpin.json() as any;
    expect(unpinned.workspace.pinned_at).toBeNull();
  });

  it('rejects pinning archived workspaces', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/workspaces', { name: 'archived-pin' })
    ).json() as any;
    const archive = await http(t).patch(
      `/api/workspaces/${created.workspace.id}/archive`,
      { archived: true },
    );
    expect(archive.status).toBe(200);

    expect(
      (await http(t).post(`/api/workspaces/${created.workspace.id}/pin`)).status,
    ).toBe(404);
    expect(
      (await http(t).del(`/api/workspaces/${created.workspace.id}/pin`)).status,
    ).toBe(404);
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
      await http(t).post(
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

describe('PATCH /api/channels/:id/archive', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('archives and unarchives a regular channel without touching status, closed_at, or agent lifecycle', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'archtest',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const channelId: string = created.channel.id;
    t.fake.starts = [];
    t.fake.delivered = [];
    const events: Array<{ kind: string }> = [];
    const unsub = t.ctx.events.subscribeScope(
      `workspace:${workspace.workspace.id}`,
      e => events.push({ kind: e.kind }),
    );

    const archived = await http(t).patch(
      `/api/channels/${channelId}/archive`,
      { archived: true },
    );
    expect(archived.status).toBe(200);
    const archivedBody = await archived.json() as any;
    expect(archivedBody.channel.archived_at).not.toBeNull();
    expect(archivedBody.channel.status).toBe(created.channel.status);
    expect(archivedBody.channel.closed_at).toBeNull();
    expect(archivedBody.channel.close_summary).toBeNull();

    const unarchived = await http(t).patch(
      `/api/channels/${channelId}/archive`,
      { archived: false },
    );
    expect(unarchived.status).toBe(200);
    const unarchivedBody = await unarchived.json() as any;
    expect(unarchivedBody.channel.archived_at).toBeNull();

    unsub();
    expect(events.map(e => e.kind)).toEqual([
      'workspace_channels_changed',
      'workspace_channels_changed',
    ]);
    // Archive must not nudge agent runtime — no fresh start/deliver calls.
    expect(t.fake.starts).toEqual([]);
    expect(t.fake.delivered).toEqual([]);
  });

  it('rejects threads and dm_channels with 400 not_archivable', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'reject',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId: created.channel.id,
      title: 'thread',
    });
    const threadRes = await http(t).patch(
      `/api/channels/${thread.id}/archive`,
      { archived: true },
    );
    expect(threadRes.status).toBe(400);
    expect(((await threadRes.json()) as any).code).toBe('not_archivable');

    const dmChannel = conversations.listDmChannels()[0];
    expect(dmChannel).toBeTruthy();
    const dmRes = await http(t).patch(
      `/api/channels/${dmChannel!.id}/archive`,
      { archived: true },
    );
    expect(dmRes.status).toBe(400);
    expect(((await dmRes.json()) as any).code).toBe('not_archivable');
  });

  it('returns 404 for unknown ids and 400 for invalid bodies', async () => {
    t = buildTestApp();
    const missing = await http(t).patch('/api/channels/missing/archive', {
      archived: true,
    });
    expect(missing.status).toBe(404);

    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'badbody',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const created = await (
      await http(t).post(
        `/api/workspaces/${workspace.workspace.id}/channels`,
        { title: 'planning', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const bad = await http(t).patch(
      `/api/channels/${created.channel.id}/archive`,
      { archived: 'yes' },
    );
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/workspaces/:id/channels (active vs archived split)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('active list excludes archived channels and threads under archived parents; archived list includes them', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const workspace = await (
      await http(t).post('/api/workspaces', {
        name: 'split',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const wsId: string = workspace.workspace.id;

    const live = await (
      await http(t).post(
        `/api/workspaces/${wsId}/channels`,
        { title: 'live', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const cold = await (
      await http(t).post(
        `/api/workspaces/${wsId}/channels`,
        { title: 'cold', member_agent_ids: [aliceId] },
      )
    ).json() as any;
    const conversations = new ConversationRepo(t.ctx.db);
    const liveThread = conversations.insertThread({
      channelId: live.channel.id,
      title: 'live-thread',
    });
    const coldThread = conversations.insertThread({
      channelId: cold.channel.id,
      title: 'cold-thread',
    });

    const archived = await http(t).patch(
      `/api/channels/${cold.channel.id}/archive`,
      { archived: true },
    );
    expect(archived.status).toBe(200);

    const active = await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json() as any;
    const activeChannelIds = active.channels.map((c: any) => c.id);
    const activeThreadIds = active.threads.map((c: any) => c.id);
    expect(activeChannelIds).toContain(live.channel.id);
    expect(activeChannelIds).not.toContain(cold.channel.id);
    expect(activeThreadIds).toContain(liveThread.id);
    expect(activeThreadIds).not.toContain(coldThread.id);

    const archivedRes = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`)
    ).json() as any;
    const archivedChannelIds = archivedRes.channels.map((c: any) => c.id);
    const archivedThreadIds = archivedRes.threads.map((c: any) => c.id);
    expect(archivedChannelIds).toEqual([cold.channel.id]);
    expect(archivedThreadIds).toEqual([coldThread.id]);

    // Round-trip: unarchive moves the channel back into the active list.
    const unarchived = await http(t).patch(
      `/api/channels/${cold.channel.id}/archive`,
      { archived: false },
    );
    expect(unarchived.status).toBe(200);
    const active2 = await (await http(t).get(`/api/workspaces/${wsId}/channels`)).json() as any;
    expect(active2.channels.map((c: any) => c.id)).toContain(cold.channel.id);
    expect(active2.threads.map((c: any) => c.id)).toContain(coldThread.id);
    const archived2 = await (
      await http(t).get(`/api/workspaces/${wsId}/channels/archived`)
    ).json() as any;
    expect(archived2.channels).toEqual([]);
    expect(archived2.threads).toEqual([]);
  });

  it('agent_home workspaces return empty archived tree without erroring', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    // Onboarding provisioning auto-creates an agent_home workspace per agent.
    const wsList = await (await http(t).get('/api/workspaces')).json() as any;
    const home = wsList.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === aliceId,
    );
    expect(home).toBeTruthy();
    const res = await http(t).get(`/api/workspaces/${home.id}/channels/archived`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({ channels: [], threads: [] });
  });
});

describe('GET /api/archived-channels (cross-workspace aggregate)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns channels across workspaces with workspace name + thread_count, sorted by archived_at DESC', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const ws1 = await (
      await http(t).post('/api/workspaces', {
        name: 'one',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const ws2 = await (
      await http(t).post('/api/workspaces', {
        name: 'two',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    const c1 = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'a',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const c2 = await (
      await http(t).post(`/api/workspaces/${ws2.workspace.id}/channels`, {
        title: 'b',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const conversations = new ConversationRepo(t.ctx.db);
    conversations.insertThread({ channelId: c1.channel.id, title: 't1' });
    conversations.insertThread({ channelId: c1.channel.id, title: 't2' });

    // Active channels must not appear.
    const active = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'still-active',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    expect(active.channel.archived_at).toBeNull();

    expect((await http(t).patch(`/api/channels/${c1.channel.id}/archive`, { archived: true })).status).toBe(200);
    // Force a measurable gap so DESC ordering is unambiguous.
    await new Promise(r => setTimeout(r, 5));
    expect((await http(t).patch(`/api/channels/${c2.channel.id}/archive`, { archived: true })).status).toBe(200);

    const list = await (await http(t).get('/api/archived-channels')).json() as any;
    expect(list.channels).toHaveLength(2);
    // c2 archived later -> first.
    expect(list.channels[0].channel.id).toBe(c2.channel.id);
    expect(list.channels[0].workspace).toMatchObject({
      id: ws2.workspace.id,
      name: 'two',
      archived_at: null,
    });
    expect(list.channels[0].thread_count).toBe(0);
    expect(list.channels[1].channel.id).toBe(c1.channel.id);
    expect(list.channels[1].workspace.name).toBe('one');
    expect(list.channels[1].thread_count).toBe(2);
  });

  it('filters by workspace_id and since (epoch ms)', async () => {
    t = buildTestApp();
    const aliceId = await makeAgent(t, 'alice');
    const ws1 = await (
      await http(t).post('/api/workspaces', {
        name: 'alpha',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const ws2 = await (
      await http(t).post('/api/workspaces', {
        name: 'beta',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    const c1 = await (
      await http(t).post(`/api/workspaces/${ws1.workspace.id}/channels`, {
        title: 'old',
        member_agent_ids: [aliceId],
      })
    ).json() as any;
    const c2 = await (
      await http(t).post(`/api/workspaces/${ws2.workspace.id}/channels`, {
        title: 'new',
        member_agent_ids: [aliceId],
      })
    ).json() as any;

    expect((await http(t).patch(`/api/channels/${c1.channel.id}/archive`, { archived: true })).status).toBe(200);
    await new Promise(r => setTimeout(r, 10));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 10));
    expect((await http(t).patch(`/api/channels/${c2.channel.id}/archive`, { archived: true })).status).toBe(200);

    // workspace_id filter narrows to one row.
    const ws1Only = await (
      await http(t).get(`/api/archived-channels?workspace_id=${ws1.workspace.id}`)
    ).json() as any;
    expect(ws1Only.channels.map((r: any) => r.channel.id)).toEqual([c1.channel.id]);

    // since filter excludes anything archived before the cutoff.
    const recent = await (
      await http(t).get(`/api/archived-channels?since=${cutoff}`)
    ).json() as any;
    expect(recent.channels.map((r: any) => r.channel.id)).toEqual([c2.channel.id]);

    // Both filters together can narrow to empty.
    const both = await (
      await http(t).get(
        `/api/archived-channels?workspace_id=${ws1.workspace.id}&since=${cutoff}`,
      )
    ).json() as any;
    expect(both.channels).toEqual([]);
  });

  it('rejects unknown workspace_id with 404, invalid since with 400', async () => {
    t = buildTestApp();
    expect(
      (await http(t).get('/api/archived-channels?workspace_id=missing')).status,
    ).toBe(404);
    expect(
      (await http(t).get('/api/archived-channels?since=not-a-number')).status,
    ).toBe(400);
  });
});

describe('list routes filter by conversation_users (v25 PR-A blocker fix)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /**
   * Regression for PR-A blocker #1: workspace channel/thread list
   * routes used to return every conversation in the workspace
   * regardless of `conversation_users` membership. After v25 we
   * filter by membership for human principals so a workspace member
   * who is not a member of a private channel/thread does not see it
   * in the sidebar / archived list.
   *
   * Scenario:
   *   - `local` (the fixture viewer) is the workspace member.
   *   - `teammate` (another fixture user) is also a workspace member
   *      via the test autoseed triggers.
   *   - We strip both users out of `conversation_users` for one
   *      private channel and assert each list endpoint excludes it
   *      when called as `teammate` but still includes it for `local`.
   */
  it('hides channels/threads/archived from human principals who are not conversation_users', async () => {
    t = buildTestApp();

    // Create a workspace + 2 channels via the routes (so route-level
    // membership writes apply naturally). One channel will be the
    // "private" one we strip teammate from.
    const aliceId = await makeAgent(t, 'alice');
    const wsRes = await http(t).post('/api/workspaces', {
      name: 'shared',
      member_agent_ids: [aliceId],
    });
    expect(wsRes.status).toBe(201);
    const ws = await wsRes.json() as any;
    const workspaceId: string = ws.workspace.id;

    const publicCh = await http(t).post(
      `/api/workspaces/${workspaceId}/channels`,
      { title: 'Public', member_agent_ids: [aliceId] },
    );
    expect(publicCh.status).toBe(201);
    const pub = await publicCh.json() as any;

    const privateCh = await http(t).post(
      `/api/workspaces/${workspaceId}/channels`,
      { title: 'Private', member_agent_ids: [aliceId] },
    );
    expect(privateCh.status).toBe(201);
    const priv = await privateCh.json() as any;

    // Insert a thread under the private channel, then strip
    // `teammate` from BOTH the channel and the thread so the
    // membership filter has something to hide.
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId: priv.channel.id,
      title: 'priv-thread',
    });
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'teammate'`)
      .run(priv.channel.id);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'teammate'`)
      .run(thread.id);

    // Archive the private channel so we can also assert the archived
    // route + aggregate route filter the same way.
    const archive = await http(t).patch(
      `/api/channels/${priv.channel.id}/archive`,
      { archived: true },
    );
    expect(archive.status).toBe(200);

    // Active list — local sees Onboarding+Public, teammate sees the
    // same minus the (now archived) Private. priv is archived, so the
    // active list does not include it for either principal; the
    // membership filter still hides the archived parent's threads.
    const activeLocal = await (
      await http(t).get(`/api/workspaces/${workspaceId}/channels`)
    ).json() as any;
    expect(activeLocal.channels.map((c: any) => c.title).sort()).toEqual(
      ['Onboarding', 'Public'],
    );

    const activeTeammate = await (
      await http(t).get(`/api/workspaces/${workspaceId}/channels`, {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      })
    ).json() as any;
    expect(activeTeammate.channels.map((c: any) => c.title).sort()).toEqual(
      ['Onboarding', 'Public'],
    );
    expect(activeTeammate.threads.map((t: any) => t.id)).not.toContain(thread.id);
    expect(activeTeammate.channels.map((c: any) => c.title).sort()).toEqual(
      ['Onboarding', 'Public'],
    );
    // The private thread under the (now-archived) private channel
    // should not surface to teammate via the active list either.
    expect(activeTeammate.threads.map((t: any) => t.id)).not.toContain(thread.id);

    // Archived list (workspace-scoped) — local sees the archived
    // private channel; teammate sees nothing.
    const archivedLocalResp = await http(t).get(`/api/workspaces/${workspaceId}/channels/archived`);
    const archivedLocal = await archivedLocalResp.json() as any;
    expect(archivedLocal.channels.map((c: any) => c.title)).toEqual(['Private']);

    const archivedTeammateResp = await http(t).get(
      `/api/workspaces/${workspaceId}/channels/archived`,
      {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      },
    );
    const archivedTeammate = await archivedTeammateResp.json() as any;
    expect(archivedTeammate.channels).toEqual([]);
    expect(archivedTeammate.threads.map((t: any) => t.id)).not.toContain(thread.id);

    // Cross-workspace aggregate — same gate.
    const aggLocal = await (
      await http(t).get(`/api/archived-channels?workspace_id=${workspaceId}`)
    ).json() as any;
    expect(aggLocal.channels.map((r: any) => r.channel.title)).toEqual(['Private']);

    const aggTeammate = await (
      await http(t).get(`/api/archived-channels?workspace_id=${workspaceId}`, {
        headers: { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') },
      })
    ).json() as any;
    expect(aggTeammate.channels).toEqual([]);
  });
});
