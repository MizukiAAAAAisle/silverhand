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
      await http(t).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = body.agent.id;
  }
  const workspaceBody = await (
    await http(t).post('/api/workspaces', {
      name: `ws-${crypto.randomUUID().slice(0, 8)}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  t.fake.clearedSessions = [];
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
    expect((await http(t).get(legacyBase)).ok).toBe(false);
    expect((await http(t).post(legacyBase, {
      content: 'legacy',
    })).ok).toBe(false);

    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'thread anchor',
      })
    ).json() as any;
    const created = await (
      await http(t).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;

    for (const path of [
      `/api/channels/${channelId}/stream`,
      `/api/channels/${channelId}/events`,
      `/api/threads/${created.thread_id}/stream`,
      `/api/threads/${created.thread_id}/events`,
    ]) {
      expect((await http(t).get(path)).ok).toBe(false);
    }
  });

  it('lists and pages channel messages by conversation_id', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    for (let i = 0; i < 5; i++) {
      const res = await http(t).post(`/api/channels/${channelId}/messages`, {
        content: `m${i}`,
      });
      expect(res.status).toBe(201);
    }

    const latest = await (
      await http(t).get(`/api/channels/${channelId}/messages?limit=2`)
    ).json() as any;
    expect(latest.messages.map((m: any) => m.content)).toEqual(['m3', 'm4']);
    expect(latest.has_more_before).toBe(true);
    // `latest` is the tail by definition.
    expect(latest.has_more_after).toBe(false);

    const earlier = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?limit=2&before_seq=${latest.messages[0].seq}`,
      )
    ).json() as any;
    expect(earlier.messages.map((m: any) => m.content)).toEqual(['m1', 'm2']);
    expect(earlier.has_more_before).toBe(true);
    expect(earlier.has_more_after).toBe(true);
  });

  it('messages window supports after_seq and around_message_id', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const ids: string[] = [];
    const seqs: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await (
        await http(t).post(`/api/channels/${channelId}/messages`, {
          content: `m${i}`,
        })
      ).json() as any;
      ids.push(r.message.id);
      seqs.push(r.message.seq);
    }

    // Walk forward from one before m0's seq → window starts at m0
    // (the onboarding system message sits at seq=1; we anchor past it
    // by using m0's seq - 1 directly so we don't depend on whether
    // the harness inserts other rows above).
    const forward = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?limit=3&after_seq=${seqs[0]! - 1}`,
      )
    ).json() as any;
    expect(forward.messages[0].content).toBe('m0');
    expect(forward.messages.map((m: any) => m.content)).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
    // Onboarding system message lives below m0; has_more_before is
    // expected here.
    expect(forward.has_more_after).toBe(true);

    // around_message_id centers the window on the anchor row.
    const around = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?limit=5&around_message_id=${ids[4]}`,
      )
    ).json() as any;
    expect(around.messages.map((m: any) => m.content)).toEqual([
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(around.has_more_before).toBe(true);
    expect(around.has_more_after).toBe(true);
  });

  it('messages window 400s on multiple cursors and 404s on cross-channel anchors', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const own = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'own',
      })
    ).json() as any;

    // 2+ cursors → 400 with a stable code.
    const conflict = await http(t).get(
      `/api/channels/${channelId}/messages?before_seq=2&after_seq=1`,
    );
    expect(conflict.status).toBe(400);
    const conflictBody = (await conflict.json()) as any;
    expect(conflictBody.code).toBe('mutually_exclusive_cursors');

    // Bad numeric cursor → 400 / invalid_cursor.
    const bad = await http(t).get(
      `/api/channels/${channelId}/messages?before_seq=foo`,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).code).toBe('invalid_cursor');

    // Negative seq cursor → 400 / invalid_cursor (seq is 1-indexed).
    const negative = await http(t).get(
      `/api/channels/${channelId}/messages?after_seq=-1`,
    );
    expect(negative.status).toBe(400);
    expect(((await negative.json()) as any).code).toBe('invalid_cursor');

    // Empty around_message_id= is a client bug, not "latest".
    const emptyAround = await http(t).get(
      `/api/channels/${channelId}/messages?around_message_id=`,
    );
    expect(emptyAround.status).toBe(400);
    expect(((await emptyAround.json()) as any).code).toBe('invalid_cursor');

    // Anchor message id from a sibling channel → 404 / message_not_found.
    const { channelId: otherChannelId } = await createWorkspaceChannel(t, [
      'bob',
    ]);
    const stranger = await (
      await http(t).post(`/api/channels/${otherChannelId}/messages`, {
        content: 'stranger',
      })
    ).json() as any;
    const cross = await http(t).get(
      `/api/channels/${channelId}/messages?around_message_id=${stranger.message.id}`,
    );
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as any).code).toBe('message_not_found');

    // Anchor in the same channel works.
    const ok = await http(t).get(
      `/api/channels/${channelId}/messages?around_message_id=${own.message.id}`,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as any;
    expect(okBody.messages.map((m: any) => m.content)).toContain('own');
    expect(okBody.has_more_after).toBe(false);
  });

  it('creates a thread from a channel message and enforces kind guards', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'start a thread here',
      })
    ).json() as any;
    t.fake.starts = [];
    t.fake.delivered = [];

    const created = await (
      await http(t).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;
    expect(typeof created.thread_id).toBe('string');
    expect(created.thread.id).toBe(created.thread_id);
    expect(created.thread.channel_id).toBe(channelId);
    expect(created.thread.parent_conversation_id).toBe(channelId);

    expect((await http(t).get(`/api/channels/${created.thread_id}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${created.thread_id}/messages`)).status)
      .toBe(200);
    const threadMessages = await (
      await http(t).get(`/api/threads/${created.thread_id}/messages`)
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
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await http(t).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;

    const post = await http(t).post(`/api/threads/${created.thread_id}/messages`, {
      content: 'thread reply',
    });
    expect(post.status).toBe(201);
    const threads = await (
      await http(t).get(`/api/channels/${channelId}/threads`)
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
      await http(t).get(`/api/channels/${channelId}/threads`)
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

    const res = await http(t).get('/api/message-unread-summary');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.by_workspace).toEqual({ [workspace.id]: 1 });
  });

  it('lists, saves, and unsaves messages through canonical saved routes', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const alice = http(t, { 'X-Silverhand-User-Id': 'alice' });
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await local.post(`/api/channels/${channelId}/messages`, {
        content: 'save me',
      })
    ).json() as any;

    expect((await (await local.get('/api/saved')).json() as any).saved)
      .toEqual([]);

    const saved = await (
      await local.post(`/api/messages/${msg.message.id}/save`)
    ).json() as any;
    expect(saved.saved.message.id).toBe(msg.message.id);

    const listed = await (await local.get('/api/saved')).json() as any;
    expect(listed.saved).toHaveLength(1);
    expect(listed.saved[0].message.id).toBe(msg.message.id);

    expect((await (await alice.get('/api/saved')).json() as any).saved).toEqual([]);
    const aliceSaved = await alice.post(`/api/messages/${msg.message.id}/save`);
    expect(aliceSaved.status).toBe(201);
    expect((await (await alice.get('/api/saved')).json() as any).saved)
      .toHaveLength(1);

    const deleted = await local.del(`/api/messages/${msg.message.id}/save`);
    expect(deleted.status).toBe(204);
    const afterDelete = await (await local.get('/api/saved')).json() as any;
    expect(afterDelete.saved).toEqual([]);
    expect((await (await alice.get('/api/saved')).json() as any).saved)
      .toHaveLength(1);
  });

  it('gates saved-message operations by source conversation visibility', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'hidden save',
      })
    ).json() as any;
    const saved = await http(t).post(`/api/messages/${msg.message.id}/save`);
    expect(saved.status).toBe(201);

    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);
    const listed = await (await http(t).get('/api/saved')).json() as any;
    expect(listed.saved).toEqual([]);

    const resave = await http(t).post(`/api/messages/${msg.message.id}/save`);
    expect(resave.status).toBe(404);
    const unsave = await http(t).del(`/api/messages/${msg.message.id}/save`);
    expect(unsave.status).toBe(404);
  });

  it('starts and stops channel/thread agents through canonical routes', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const start = await http(t).post(
      `/api/channels/${channelId}/agents/${agentIds.alice}/start`,
    );
    expect(start.status).toBe(200);
    expect(t.fake.starts).toEqual([{ conversationId: channelId, agentId: agentIds.alice }]);
    t.fake.starts = [];
    const nonOwnerStart = await http(t, { 'X-Silverhand-User-Id': 'alice' }).post(
      `/api/channels/${channelId}/agents/${agentIds.alice}/start`,
    );
    expect(nonOwnerStart.status).toBe(403);
    expect(t.fake.starts).toEqual([]);

    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await http(t).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;
    const stop = await http(t).post(
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

    t.fake.clearSessionResult = {
      prevCliSessionId: 'cli-prev-route',
      wasRunning: true,
    };
    const clear = await http(t, { 'X-Silverhand-User-Id': 'local' }).post(
      `/api/channels/${channelId}/agents/${agentIds.alice}/clear-session`,
    );
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({
      ok: true,
      prev_cli_session_id: 'cli-prev-route',
      was_running: true,
    });
    expect(t.fake.clearedSessions).toContainEqual({
      conversationId: channelId,
      agentId: agentIds.alice,
      actorUserId: 'local',
    });
  });

  it('marks channel and thread read cursors through canonical routes', async () => {
    t = buildTestApp();
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
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
    const viewer = http(t, { 'X-Silverhand-User-Id': 'local' });
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
      userId: 'local',
      workspaceId: workspace.id,
      conversationId: channelId,
    });
    notifications.insert({
      kind: 'mention_external',
      workspaceId: workspace.id,
      conversationId: channelId,
    });

    const events: Array<{ kind: string; payload: unknown }> = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e => {
      events.push({ kind: e.kind, payload: e.payload });
    });
    const first = await http(t).post('/api/notifications/read', {
      conversation_id: channelId,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ marked: 1 });
    expect(events).toEqual([{ kind: 'unread_updated', payload: { marked: 1 } }]);

    events.length = 0;
    const second = await http(t).post('/api/notifications/read', {
      conversation_id: channelId,
    });
    unsub();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ marked: 0 });
    expect(events).toEqual([]);
    const unread = await (await http(t).get('/api/notifications/unread')).json() as any;
    expect(unread.total).toBe(0);
  });
});
