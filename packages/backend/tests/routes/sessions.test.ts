import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
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

function createLegacyThread(
  t: TestApp,
  channelId: string,
  opts: { anchorMessageId?: string; title?: string } = {},
) {
  const conversations = new ConversationRepo(t.ctx.db);
  const messages = new MessageRepo(t.ctx.db);
  const thread = conversations.insertThread({
    channelId,
    title: opts.title ?? 'Legacy thread',
  });
  for (const member of conversations.listAgents(channelId)) {
    conversations.addAgent(thread.id, member.agent_id);
  }
  for (const member of conversations.listUsers(channelId)) {
    conversations.addUser(thread.id, member.user_id);
  }
  if (opts.anchorMessageId) {
    messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'system',
      content: 'Legacy thread anchor',
      metadata: {
        subtype: 'thread_anchor',
        quoted_message_id: opts.anchorMessageId,
      },
    });
  }
  return thread;
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
    const thread = createLegacyThread(t, channelId, {
      anchorMessageId: msg.message.id,
    });

    for (const path of [
      `/api/channels/${channelId}/stream`,
      `/api/channels/${channelId}/events`,
      `/api/threads/${thread.id}/stream`,
      `/api/threads/${thread.id}/events`,
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

    const legacyAnchor = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'legacy anchor',
    });
    const legacy = createLegacyThread(t, channelId, {
      anchorMessageId: legacyAnchor.id,
    });
    const deprecated = await http(t).get(
      `/api/channels/${channelId}/messages?thread_root_id=${legacy.id}`,
    );
    expect(deprecated.status).toBe(400);
    const deprecatedBody = (await deprecated.json()) as any;
    expect(deprecatedBody.code).toBe('legacy_thread_target_deprecated');
    expect(deprecatedBody.error).toContain(`conversation:${legacy.id}`);
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

    const root = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'legacy root',
      })
    ).json() as any;
    const legacy = createLegacyThread(t, channelId, {
      anchorMessageId: root.message.id,
    });
    const legacyWrite = await http(t).post(
      `/api/threads/${legacy.id}/messages`,
      {
        content: 'should stay read-only',
        reply_to_message_id: root.message.id,
      },
    );
    expect(legacyWrite.status).toBe(409);
    expect(((await legacyWrite.json()) as any).code).toBe(
      'legacy_thread_read_only',
    );
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

  it('serves legacy thread reads and enforces kind guards', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'start a thread here',
      })
    ).json() as any;
    const thread = createLegacyThread(t, channelId, {
      anchorMessageId: msg.message.id,
    });

    expect((await http(t).get(`/api/channels/${thread.id}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${channelId}/messages`)).status)
      .toBe(404);
    expect((await http(t).get(`/api/threads/${thread.id}/messages`)).status)
      .toBe(200);
    const threadMessages = await (
      await http(t).get(`/api/threads/${thread.id}/messages`)
    ).json() as any;
    const anchor = threadMessages.messages.find(
      (m: any) => m.metadata?.subtype === 'thread_anchor',
    );
    expect(anchor).toBeDefined();
  });

  it('rejects human writes to legacy threads and retires public thread summaries', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const msg = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const thread = createLegacyThread(t, channelId, {
      anchorMessageId: msg.message.id,
    });

    const post = await http(t).post(`/api/threads/${thread.id}/messages`, {
      content: 'thread reply',
    });
    expect(post.status).toBe(409);
    expect(await post.json()).toMatchObject({ code: 'legacy_thread_read_only' });
    expect((await http(t).get(`/api/channels/${channelId}/threads`)).status)
      .toBe(404);

    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ?, status = 'archived' WHERE id = ?`)
      .run(Date.now(), thread.id);
    expect((await http(t).get(`/api/threads/${thread.id}/messages`)).status)
      .toBe(200);
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
    const created = createLegacyThread(t, channelId, {
      anchorMessageId: msg.message.id,
    });
    const stop = await http(t).post(
      `/api/threads/${created.id}/agents/${agentIds.alice}/stop`,
      { mode: 'soft', directive: 'pause' },
    );
    expect(stop.status).toBe(200);
    expect(t.fake.stops).toContainEqual({
      conversationId: created.id,
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
    const thread = createLegacyThread(t, channelId, {
      anchorMessageId: msg.message.id,
    });
    new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: thread.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'existing fossil reply',
    });
    const writeThread = await viewer.post(`/api/threads/${thread.id}/messages`, {
      content: 'thread msg',
    });
    expect(writeThread.status).toBe(409);
    const markThread = await viewer.post(`/api/threads/${thread.id}/mark-read`);
    expect(markThread.status).toBe(200);
    expect(await markThread.json()).toEqual({ last_read_seq: 2 });
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
