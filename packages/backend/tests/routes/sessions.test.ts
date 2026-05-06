import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function createWorkspaceChannel(
  t: TestApp,
  members: string[] = ['alice', 'bob'],
) {
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const body = await (
      await http(t.app).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = body.agent.id;
  }
  const workspaceBody = await (
    await http(t.app).post('/api/workspaces', {
      name: `ws-${crypto.randomUUID().slice(0, 8)}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    workspace: workspaceBody.workspace,
    channelId: workspaceBody.onboarding_channel_id as string,
    agentIds,
  };
}

describe('canonical channel/thread routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects legacy conversation routes after the hard cutover', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const legacyBase = ['/api', 'sessions', channelId, 'messages'].join('/');
    expect((await http(t.app).get(legacyBase)).ok).toBe(false);
    expect((await http(t.app).post(legacyBase, {
      content: 'legacy',
    })).ok).toBe(false);

    const msg = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'thread anchor',
      })
    ).json() as any;
    const created = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;

    for (const path of [
      `/api/channels/${channelId}/stream`,
      `/api/channels/${channelId}/events`,
      `/api/threads/${created.thread_id}/stream`,
      `/api/threads/${created.thread_id}/events`,
    ]) {
      expect((await http(t.app).get(path)).ok).toBe(false);
    }
  });

  it('lists and pages channel messages by conversation_id', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    for (let i = 0; i < 5; i++) {
      const res = await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: `m${i}`,
      });
      expect(res.status).toBe(201);
    }

    const latest = await (
      await http(t.app).get(`/api/channels/${channelId}/messages?limit=2`)
    ).json() as any;
    expect(latest.messages.map((m: any) => m.content)).toEqual(['m3', 'm4']);
    expect(latest.has_more_before).toBe(true);

    const earlier = await (
      await http(t.app).get(
        `/api/channels/${channelId}/messages?limit=2&before_seq=${latest.messages[0].seq}`,
      )
    ).json() as any;
    expect(earlier.messages.map((m: any) => m.content)).toEqual(['m1', 'm2']);
    expect(earlier.has_more_before).toBe(true);
  });

  it('creates a thread from a channel message and enforces kind guards', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'start a thread here',
      })
    ).json() as any;
    t.fake.starts = [];
    t.fake.delivered = [];

    const created = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;
    expect(typeof created.thread_id).toBe('string');
    expect(created.thread.id).toBe(created.thread_id);
    expect(created.thread.channel_id).toBe(channelId);
    expect(created.thread.parent_conversation_id).toBe(channelId);

    expect((await http(t.app).get(`/api/channels/${created.thread_id}/messages`)).status)
      .toBe(404);
    expect((await http(t.app).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);
    expect((await http(t.app).get(`/api/threads/${created.thread_id}/messages`)).status)
      .toBe(200);
    const threadMessages = await (
      await http(t.app).get(`/api/threads/${created.thread_id}/messages`)
    ).json() as any;
    const onboarding = threadMessages.messages.find(
      (m: any) => m.metadata?.subtype === 'onboarding',
    );
    expect(onboarding).toBeDefined();
    expect(t.fake.delivered).toEqual([
      {
        conversationId: created.thread_id,
        agentId: agentIds.alice,
        messageId: onboarding.id,
      },
    ]);
    expect(t.fake.starts).toEqual([
      { conversationId: created.thread_id, agentId: agentIds.alice },
    ]);
  });

  it('posts human messages to threads and refreshes the parent thread summary', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;

    const post = await http(t.app).post(`/api/threads/${created.thread_id}/messages`, {
      content: 'thread reply',
    });
    expect(post.status).toBe(201);
    const threads = await (
      await http(t.app).get(`/api/channels/${channelId}/threads`)
    ).json() as any;
    expect(threads.threads).toMatchObject([
      {
        thread_id: created.thread_id,
        anchor_message_id: msg.message.id,
        reply_count: 1,
      },
    ]);

    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ?, status = 'archived' WHERE id = ?`)
      .run(Date.now(), created.thread_id);
    const closedThreads = await (
      await http(t.app).get(`/api/channels/${channelId}/threads`)
    ).json() as any;
    expect(closedThreads.threads.map((thread: any) => thread.thread_id))
      .toContain(created.thread_id);
  });

  it('serves the global message unread summary keyed by workspace/sidebar ids', async () => {
    t = buildTestApp();
    const { workspace, channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice,
      content: 'unread from agent',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'mine',
    });

    const res = await http(t.app, { 'x-silverhand-user-id': 'local' })
      .get('/api/message-unread-summary');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.by_workspace).toEqual({ [workspace.id]: 1 });
  });

  it('lists, saves, and unsaves messages through canonical saved routes', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'save me',
      })
    ).json() as any;

    expect((await (await http(t.app).get('/api/saved')).json() as any).saved)
      .toEqual([]);

    const saved = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/save`)
    ).json() as any;
    expect(saved.saved.message.id).toBe(msg.message.id);

    const listed = await (await http(t.app).get('/api/saved')).json() as any;
    expect(listed.saved).toHaveLength(1);
    expect(listed.saved[0].message.id).toBe(msg.message.id);

    const deleted = await http(t.app).del(`/api/messages/${msg.message.id}/save`);
    expect(deleted.status).toBe(204);
    const afterDelete = await (await http(t.app).get('/api/saved')).json() as any;
    expect(afterDelete.saved).toEqual([]);
  });

  it('starts and stops channel/thread agents through canonical routes', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const start = await http(t.app).post(
      `/api/channels/${channelId}/agents/${agentIds.alice}/start`,
    );
    expect(start.status).toBe(200);
    expect(t.fake.starts).toEqual([{ conversationId: channelId, agentId: agentIds.alice }]);

    const msg = await (
      await http(t.app).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;
    const stop = await http(t.app).post(
      `/api/threads/${created.thread_id}/agents/${agentIds.alice}/stop`,
      { mode: 'soft', directive: 'pause' },
    );
    expect(stop.status).toBe(200);
    expect(t.fake.stops).toContainEqual({
      conversationId: created.thread_id,
      agentId: agentIds.alice,
      mode: 'soft',
      directive: 'pause',
    });
  });

  it('marks channel and thread read cursors through canonical routes', async () => {
    t = buildTestApp();
    const viewer = http(t.app, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    await viewer.post(`/api/channels/${channelId}/messages`, {
      content: 'from user',
    });
    const markChannel = await viewer.post(`/api/channels/${channelId}/mark-read`);
    expect(markChannel.status).toBe(200);
    expect(await markChannel.json()).toEqual({ last_read_seq: 2 });

    const msg = await (
      await viewer.post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await viewer.post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;
    await viewer.post(`/api/threads/${created.thread_id}/messages`, {
      content: 'thread msg',
    });
    const markThread = await viewer.post(`/api/threads/${created.thread_id}/mark-read`);
    expect(markThread.status).toBe(200);
    expect(await markThread.json()).toEqual({ last_read_seq: 3 });
  });

  it('publishes message unread updates only when unread counts change', async () => {
    t = buildTestApp();
    const viewer = http(t.app, { 'X-Silverhand-User-Id': 'local' });
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice,
      content: 'needs reading',
    });

    const events: Array<{ kind: string; payload: unknown }> = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      events.push({ kind: e.kind, payload: e.payload });
    });
    const first = await viewer.post(`/api/channels/${channelId}/mark-read`);
    expect(first.status).toBe(200);
    expect(events).toEqual([
      { kind: 'unread_updated', payload: { conversation_id: channelId } },
    ]);

    events.length = 0;
    const second = await viewer.post(`/api/channels/${channelId}/mark-read`);
    unsub();
    expect(second.status).toBe(200);
    expect(events).toEqual([]);
  });

  it('publishes notification unread updates only when rows are marked', async () => {
    t = buildTestApp();
    const { workspace, channelId } = await createWorkspaceChannel(t, ['alice']);
    const notifications = new NotificationRepo(t.ctx.db);
    notifications.insert({
      kind: 'mention_external',
      workspaceId: workspace.id,
      conversationId: channelId,
    });

    const events: Array<{ kind: string; payload: unknown }> = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      events.push({ kind: e.kind, payload: e.payload });
    });
    const first = await http(t.app).post('/api/notifications/read', {
      conversation_id: channelId,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ marked: 1 });
    expect(events).toEqual([{ kind: 'unread_updated', payload: { marked: 1 } }]);

    events.length = 0;
    const second = await http(t.app).post('/api/notifications/read', {
      conversation_id: channelId,
    });
    unsub();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ marked: 0 });
    expect(events).toEqual([]);
  });
});
