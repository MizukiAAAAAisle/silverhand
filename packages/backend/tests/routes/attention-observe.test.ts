import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// observe() — the single eliminate primitive (#task:1231,
// docs/observe-collapse-v1.md). These cover the contract the renderer (step-3)
// and the legacy mark-read delegation both rely on.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createChannel(
  t: TestApp,
): Promise<{ channelId: string; agentId: string }> {
  const agentId = await makeAgent(t, 'alice');
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: 'ws-observe',
      member_agent_ids: [agentId],
    })
  ).json()) as any;
  return { channelId: workspace.onboarding_channel_id, agentId };
}

const observePath = apiPaths.attentionObserve;

describe('POST /api/attention/observe (#task:1231)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('mainline stream_head advances the cursor and fires one unread_updated', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const reads = new ConversationReadRepo(t.ctx.db);

    const msg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'hello',
    });

    const events: string[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push(e.kind),
    );

    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
      ],
    });
    unsub();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect(reads.getLastReadSeq('local', channelId, null)).toBeGreaterThanOrEqual(
      msg.seq,
    );
    expect(events.filter(k => k === 'unread_updated')).toHaveLength(1);
  });

  it('is idempotent: re-observing an already-read stream changes nothing and emits no event', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'hello',
    });

    const source = {
      kind: 'stream',
      conversation_id: channelId,
      thread_root_id: null,
      position: { kind: 'stream_head' },
    };
    await http(t).post(observePath, { sources: [source] });

    const events: string[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push(e.kind),
    );
    const res = await http(t).post(observePath, { sources: [source] });
    unsub();

    expect(await res.json()).toEqual({ changed: false });
    expect(events).not.toContain('unread_updated');
  });

  it('advances a thread cursor with an at_seq position', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const reads = new ConversationReadRepo(t.ctx.db);

    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      threadRootId: root.id,
      content: 'reply',
    });

    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: root.id,
          position: { kind: 'at_seq', seq: reply.seq },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect(reads.getLastReadSeq('local', channelId, root.id)).toBe(reply.seq);
  });

  it('rejects a thread + stream_head with 400 (§9.10 tail-swallow guard)', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root',
    });

    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: root.id,
          position: { kind: 'stream_head' },
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('thread_position_required');
  });

  it('rejects an at_seq beyond the stream head with 400', async () => {
    t = buildTestApp();
    const { channelId } = await createChannel(t);

    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'at_seq', seq: 999999 },
        },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('position_future');
  });

  it('404s an unknown conversation', async () => {
    t = buildTestApp();
    await createChannel(t);
    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: 'does-not-exist',
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
      ],
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('conversation_not_found');
  });

  it('clears a notification by id (directed dismiss); unknown id is a no-op', async () => {
    t = buildTestApp();
    const { channelId } = await createChannel(t);
    const notifications = new NotificationRepo(t.ctx.db);
    const n = notifications.insert({
      kind: 'agent_start_failed',
      userId: 'local',
      conversationId: channelId,
    });

    const res = await http(t).post(observePath, {
      sources: [{ kind: 'notification', notification_id: n.id }],
    });
    expect(await res.json()).toEqual({ changed: true });
    expect(notifications.get(n.id)?.read_at).not.toBeNull();

    const res2 = await http(t).post(observePath, {
      sources: [{ kind: 'notification', notification_id: 'nope' }],
    });
    expect(await res2.json()).toEqual({ changed: false });
  });

  it('overlap: a positional clear folds in seq<=N mention_self, but never anchorless or other-stream notifications', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);

    const mainMsg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '@local on mainline',
    });
    const mainMention = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: mainMsg.id,
    });
    // Anchorless: must survive a mainline stream observe (no seq to compare).
    const anchorless = notifications.insert({
      kind: 'agent_start_failed',
      userId: 'local',
      conversationId: channelId,
    });
    // A mention inside a thread: a MAINLINE observe must not reach it.
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root',
    });
    const threadReply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      threadRootId: root.id,
      content: '@local in thread',
    });
    const threadMention = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: threadReply.id,
    });

    await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
      ],
    });

    expect(notifications.get(mainMention.id)?.read_at).not.toBeNull(); // folded
    expect(notifications.get(anchorless.id)?.read_at).toBeNull(); // anchorless
    expect(notifications.get(threadMention.id)?.read_at).toBeNull(); // other stream
  });

  it('batch fail-whole: one illegal source clears nothing (no partial)', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const reads = new ConversationReadRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);

    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'hello',
    });
    const n = notifications.insert({
      kind: 'agent_start_failed',
      userId: 'local',
      conversationId: channelId,
    });

    const res = await http(t).post(observePath, {
      sources: [
        { kind: 'notification', notification_id: n.id },
        {
          kind: 'stream',
          conversation_id: 'does-not-exist',
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
      ],
    });
    expect(res.status).toBe(404);
    // The valid notification source in the same batch must NOT have been cleared.
    expect(notifications.get(n.id)?.read_at).toBeNull();
    expect(reads.getLastReadSeq('local', channelId, null)).toBe(0);
  });
});
