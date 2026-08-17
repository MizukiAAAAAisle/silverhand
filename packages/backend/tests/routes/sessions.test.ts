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

    for (const path of [
      `/api/channels/${channelId}/stream`,
      `/api/channels/${channelId}/events`,
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

  it('messages window can be scoped to a reply cluster root', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'reply-1',
      threadRootId: root.id,
    });
    const mainNoise = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'main-noise',
    });
    const reply2 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'reply-2',
      threadRootId: root.id,
    });
    const otherRoot = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'other-root',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'other-reply',
      threadRootId: otherRoot.id,
    });

    const cluster = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?thread_root_id=${root.id}&limit=10`,
      )
    ).json() as any;
    expect(cluster.messages.map((m: any) => m.content)).toEqual([
      'root',
      'reply-1',
      'reply-2',
    ]);
    expect(cluster.messages.map((m: any) => m.thread_root_id)).toEqual([
      null,
      root.id,
      root.id,
    ]);

    const viaReply = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?thread_root_id=${reply1.id}&limit=10`,
      )
    ).json() as any;
    expect(viaReply.messages.map((m: any) => m.id)).toEqual([
      root.id,
      reply1.id,
      reply2.id,
    ]);

    const forward = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?thread_root_id=${root.id}&limit=2&after_seq=0`,
      )
    ).json() as any;
    expect(forward.messages.map((m: any) => m.content)).toEqual([
      'root',
      'reply-1',
    ]);
    expect(forward.has_more_before).toBe(false);
    expect(forward.has_more_after).toBe(true);

    const aroundOutsideCluster = await http(t).get(
      `/api/channels/${channelId}/messages?thread_root_id=${root.id}&around_message_id=${mainNoise.id}`,
    );
    expect(aroundOutsideCluster.status).toBe(404);
    expect(((await aroundOutsideCluster.json()) as any).code).toBe(
      'message_not_found',
    );
  });

  it('messages window includes per-root reply counts for visible roots', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'reply-1',
      threadRootId: root.id,
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'system',
      content: 'system reply does not count',
      threadRootId: root.id,
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'reply-2',
      threadRootId: root.id,
    });
    const otherRoot = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'other-root',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'other-reply',
      threadRootId: otherRoot.id,
    });
    const emptyRoot = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'empty-root',
    });

    const body = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?limit=10&after_seq=${root.seq - 1}`,
      )
    ).json() as any;
    expect(body.messages.map((m: any) => m.content)).toEqual([
      'root',
      'other-root',
      'empty-root',
    ]);
    expect(body.reply_counts_by_root[root.id]).toBe(2);
    expect(body.reply_counts_by_root[otherRoot.id]).toBe(1);
    expect(body.reply_counts_by_root[emptyRoot.id]).toBe(0);
    // The count is total for the root, not local to the current
    // message page. A small window containing only the root still
    // reports all replies in the cluster.
    const firstPage = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?limit=1&after_seq=${root.seq - 1}`,
      )
    ).json() as any;
    expect(firstPage.messages.map((m: any) => m.id)).toEqual([root.id]);
    expect(firstPage.reply_counts_by_root[root.id]).toBe(2);
  });

  it('messages window rejects invalid reply-cluster roots', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);

    const empty = await http(t).get(
      `/api/channels/${channelId}/messages?thread_root_id=`,
    );
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as any).code).toBe('invalid_thread_root_id');

    const unknown = await http(t).get(
      `/api/channels/${channelId}/messages?thread_root_id=missing-root`,
    );
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as any).code).toBe('thread_root_not_found');

    const { channelId: otherChannelId } = await createWorkspaceChannel(t, [
      'bob',
    ]);
    const otherRoot = messages.insertForConversation({
      conversationId: otherChannelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'other-channel-root',
    });
    const cross = await http(t).get(
      `/api/channels/${channelId}/messages?thread_root_id=${otherRoot.id}`,
    );
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as any).code).toBe('thread_root_not_found');
  });

  it('human channel sends can reply to root messages and existing replies', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const root = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'root',
      })
    ).json() as any;

    const replyToRootRes = await http(t).post(
      `/api/channels/${channelId}/messages`,
      {
        content: 'reply-to-root',
        reply_to_message_id: root.message.id,
      },
    );
    expect(replyToRootRes.status).toBe(201);
    const replyToRoot = (await replyToRootRes.json()) as any;
    expect(replyToRoot.message.thread_root_id).toBe(root.message.id);

    const replyToReplyRes = await http(t).post(
      `/api/channels/${channelId}/messages`,
      {
        content: 'reply-to-reply',
        reply_to_message_id: replyToRoot.message.id,
      },
    );
    expect(replyToReplyRes.status).toBe(201);
    const replyToReply = (await replyToReplyRes.json()) as any;
    expect(replyToReply.message.thread_root_id).toBe(root.message.id);

    const cluster = await (
      await http(t).get(
        `/api/channels/${channelId}/messages?thread_root_id=${root.message.id}&limit=10`,
      )
    ).json() as any;
    expect(cluster.messages.map((m: any) => m.content)).toEqual([
      'root',
      'reply-to-root',
      'reply-to-reply',
    ]);
  });

  it('human channel sends reject invalid reply targets without reopening legacy threads', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);

    const missing = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'missing target',
      reply_to_message_id: 'does-not-exist',
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).code).toBe('reply_target_not_found');

    const { channelId: otherChannelId } = await createWorkspaceChannel(t, [
      'bob',
    ]);
    const otherRoot = await (
      await http(t).post(`/api/channels/${otherChannelId}/messages`, {
        content: 'other root',
      })
    ).json() as any;
    const cross = await http(t).post(`/api/channels/${channelId}/messages`, {
      content: 'cross target',
      reply_to_message_id: otherRoot.message.id,
    });
    expect(cross.status).toBe(404);
    expect(((await cross.json()) as any).code).toBe('reply_target_not_found');

    // The public legacy thread write route stays retired: posting to a
    // `/api/threads/:id/messages` path (using a real channel id) 404s.
    const legacyWrite = await http(t).post(
      `/api/threads/${channelId}/messages`,
      {
        content: 'public legacy route is gone',
      },
    );
    expect(legacyWrite.status).toBe(404);
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

  it('enforces channel guards on the retired public thread read route', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    // The public `/api/threads/:id` read route is retired: a real channel id
    // routed through it must 404 (a channel is not addressable as a thread).
    expect((await http(t).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);
  });

  it('retires the old channel threads summary route', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    expect((await http(t).get(`/api/channels/${channelId}/threads`)).status)
      .toBe(404);
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

  it('serves per-channel message unread latest pointers with thread root and seq', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice,
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice,
      threadRootId: root.id,
      content: 'thread reply',
    });

    // The channel-level roll-up only counts FOLLOWED threads (#task:1226 §3.5);
    // the viewer follows this cluster so its reply surfaces in the count + pointer.
    t.ctx.db
      .prepare(
        `INSERT INTO thread_followers
           (thread_root_id, conversation_id, principal_kind, principal_id, followed_at, source)
         VALUES (?, ?, 'human', ?, ?, 'manual')`,
      )
      .run(root.id, channelId, 'local', Date.now());

    const res = await http(t).get(`/api/channels/${channelId}/message-unread`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.by_conversation).toEqual({ [channelId]: 2 });
    expect(body.latest_by_conversation).toEqual({
      [channelId]: {
        conversation_id: channelId,
        message_id: reply.id,
        seq: reply.seq,
        thread_root_id: root.id,
      },
    });
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
    expect(listed.saved[0]).toMatchObject({
      message: { thread_root_id: null },
    });

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

  it('saved reply-cluster messages expose the message anchor target, not a legacy thread id', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const root = await (
      await local.post(`/api/channels/${channelId}/messages`, {
        content: 'root for saved cluster',
      })
    ).json() as any;
    const reply = await (
      await local.post(`/api/channels/${channelId}/messages`, {
        content: 'saved cluster reply',
        reply_to_message_id: root.message.id,
      })
    ).json() as any;

    expect((await local.post(`/api/messages/${reply.message.id}/save`)).status)
      .toBe(201);
    const listed = await (await local.get('/api/saved')).json() as any;
    expect(listed.saved).toHaveLength(1);
    expect(listed.saved[0]).toMatchObject({
      place: { kind: 'workspace_channel', conversation_id: channelId },
      message: {
        id: reply.message.id,
        thread_root_id: root.message.id,
      },
    });
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

  it('?workspace_id filters saved messages to one workspace; unknown workspace → 404 (#task:1258)', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const a = await createWorkspaceChannel(t, ['alice']);
    const b = await createWorkspaceChannel(t, ['bob']);
    const msgA = await (
      await local.post(`/api/channels/${a.channelId}/messages`, { content: 'in A' })
    ).json() as any;
    const msgB = await (
      await local.post(`/api/channels/${b.channelId}/messages`, { content: 'in B' })
    ).json() as any;
    await local.post(`/api/messages/${msgA.message.id}/save`);
    await local.post(`/api/messages/${msgB.message.id}/save`);

    const all = await (await local.get('/api/saved')).json() as any;
    expect(all.saved.map((s: any) => s.message.id).sort()).toEqual(
      [msgA.message.id, msgB.message.id].sort(),
    );

    const onlyA = await (
      await local.get(`/api/saved?workspace_id=${a.workspace.id}`)
    ).json() as any;
    expect(onlyA.saved).toHaveLength(1);
    expect(onlyA.saved[0].message.id).toBe(msgA.message.id);
    expect(onlyA.saved[0].place).toMatchObject({
      kind: 'workspace_channel',
      workspace_id: a.workspace.id,
    });

    // Unknown workspace id → 404 (mirrors archived-channels not-found semantics).
    const unknown = await local.get('/api/saved?workspace_id=does-not-exist');
    expect(unknown.status).toBe(404);
  });

  it('?since filters saved messages by the saved_at window (#task:1258)', async () => {
    t = buildTestApp();
    const local = http(t, { 'X-Silverhand-User-Id': 'local' });
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const older = await (
      await local.post(`/api/channels/${channelId}/messages`, { content: 'older' })
    ).json() as any;
    const newer = await (
      await local.post(`/api/channels/${channelId}/messages`, { content: 'newer' })
    ).json() as any;
    await local.post(`/api/messages/${older.message.id}/save`);
    await local.post(`/api/messages/${newer.message.id}/save`);
    // Backdate the "older" save so it falls outside the `since` window. `since`
    // is a SAVE-time filter (`saved_at >= since`), not message time.
    t.ctx.db
      .prepare(
        `UPDATE saved_messages SET saved_at = 1000 WHERE message_id = ? AND user_id = 'local'`,
      )
      .run(older.message.id);

    const since = await (await local.get('/api/saved?since=2000')).json() as any;
    expect(since.saved).toHaveLength(1);
    expect(since.saved[0].message.id).toBe(newer.message.id);

    // since=0 returns the whole window again.
    const both = await (await local.get('/api/saved?since=0')).json() as any;
    expect(both.saved.map((s: any) => s.message.id).sort()).toEqual(
      [older.message.id, newer.message.id].sort(),
    );
  });

  it('starts and clears channel agents through canonical routes', async () => {
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

    t.fake.clearSessionResult = {
      prevCliSessionId: 'cli-prev-route',
      wasRunning: true,
      focusConversationId: channelId,
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
      scope: {
        kind: 'conversation',
        conversationId: channelId,
        agentId: agentIds.alice,
      },
      actorUserId: 'local',
    });
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
