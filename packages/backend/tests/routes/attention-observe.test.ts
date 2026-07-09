import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { NotificationRepo } from '../../src/repos/notification-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// observe() — the single eliminate primitive (#task:1231,
// docs/observe-collapse-v1.md). These cover the contract the renderer read-side
// collapse relies on — and, since the legacy channel mark-read route was retired
// into observe() (#task:1232), the sole backend home for per-stream cursor
// advance + §3 overlap.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createChannel(
  t: TestApp,
  label = 'a',
): Promise<{ channelId: string; agentId: string }> {
  const agentId = await makeAgent(t, `agent-${label}`);
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `ws-observe-${label}`,
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

  // #task:1283: the enriched message-variant absolutes must reflect the
  // POST-COMMIT state — the cursor already advanced inside observe(), so the
  // count the renderer patches is the CLEARED value (0), never a pre-commit
  // stale count. This is the whole point of running the enrich as a post-commit
  // effect. The badge-variant `{}` stays empty (no discriminator).
  it('observe clear emits a message variant with post-commit zeroed absolutes (#task:1283)', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'one unread',
    });

    const events: { kind: string; payload: any }[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
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
    unsub();

    const unreadEvents = events.filter(e => e.kind === 'unread_updated');
    const messageVariant = unreadEvents.filter(
      e => (e.payload as { conversation_id?: unknown }).conversation_id != null,
    );
    expect(messageVariant).toHaveLength(1);
    // Cleared: count is 0, workspace rollup is 0, and the pointer is null.
    expect(messageVariant[0]?.payload).toMatchObject({
      conversation_id: channelId,
      conversation_unread_count: 0,
      workspace_unread_count: 0,
      latest_unread: null,
    });
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

  it('allows thread + stream_head for an EXPLICIT clear (Activity hover-✓ / Mark-all), advancing the thread cursor to its head', async () => {
    // §9.10 tail-swallow is a caller-intent guard (auto open/live pin at_seq),
    // NOT a thread-shape ban: a followed-thread `unread` Activity item must be
    // hover-✓ / Mark-all clearable, which uses stream_head.
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
          position: { kind: 'stream_head' },
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect(reads.getLastReadSeq('local', channelId, root.id)).toBe(reply.seq);
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
    expect(((await res.json()) as any).code).toBe('position_future');
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
    expect(((await res.json()) as any).code).toBe('conversation_not_found');
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

  it('overlap: the badge variant carries exactly the folded notification ids (#task:1431)', async () => {
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
    // An anchorless notification the mainline observe must NOT fold, so it must
    // NOT appear in the dismissed-ids surfaced to the OS-dismiss consumer.
    const anchorless = notifications.insert({
      kind: 'agent_start_failed',
      userId: 'local',
      conversationId: channelId,
    });

    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
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
    unsub();

    const badgeVariant = events
      .filter(e => e.kind === 'unread_updated')
      .filter(e => (e.payload as { conversation_id?: unknown }).conversation_id == null);
    expect(badgeVariant).toHaveLength(1);
    expect(
      (badgeVariant[0]?.payload as { dismissed_notification_ids?: unknown })
        .dismissed_notification_ids,
    ).toEqual([mainMention.id]);
    // The anchorless row was never touched, so it is never surfaced for dismiss.
    expect(notifications.get(anchorless.id)?.read_at).toBeNull();
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

  // ── per-source root validation (Cindy review-2 gap 1) ──────────────────────
  // The new endpoint takes conversationId from the body, so it must run the
  // full root validation itself — and, now that the legacy mark-read route is
  // retired (#task:1232), this is the only place that validation is exercised.

  it('400s thread_root_is_reply when thread_root_id is a reply, not a root', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
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
          thread_root_id: reply.id, // a reply, not a root
          position: { kind: 'at_seq', seq: reply.seq },
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('thread_root_is_reply');
  });

  it('404s thread_root_not_found when the root belongs to another conversation', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    // A second channel whose root we will (illegally) reference from the first.
    const other = await createChannel(t, 'b');
    const messages = new MessageRepo(t.ctx.db);
    const foreignRoot = messages.insertForConversation({
      conversationId: other.channelId,
      fromKind: 'agent',
      fromAgentId: other.agentId,
      content: 'foreign root',
    });

    const res = await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: foreignRoot.id, // exists, but in `other`
          position: { kind: 'at_seq', seq: foreignRoot.seq },
        },
      ],
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('thread_root_not_found');
  });

  // ── thread overlap positive (Cindy review-2 gap 2) ─────────────────────────
  // The crux of markStreamMentionsRead's `m.thread_root_id IS @root` semantics:
  // a THREAD observe clears that thread's own mention_self, and only it.

  it('overlap: a thread observe clears the thread reply mention_self (and leaves the mainline mention)', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);

    // A mainline mention that a THREAD observe must NOT touch.
    const mainMsg = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: '@local mainline',
    });
    const mainMention = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: mainMsg.id,
    });
    // The thread reply mention the observe SHOULD fold in.
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
      content: '@local in thread',
    });
    const threadMention = notifications.insert({
      kind: 'mention_self',
      userId: 'local',
      conversationId: channelId,
      messageId: reply.id,
    });

    await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: root.id,
          position: { kind: 'at_seq', seq: reply.seq },
        },
      ],
    });

    expect(notifications.get(threadMention.id)?.read_at).not.toBeNull(); // folded
    expect(notifications.get(mainMention.id)?.read_at).toBeNull(); // mainline kept
  });

  // ── coalesced events (Cindy review-2 gap 3) ────────────────────────────────
  // The renderer discriminates `unread_updated` by payload shape: a body WITH
  // `conversation_id` drives the cursor / chip read-models, a body WITHOUT it
  // drives the notification badge. So a faithful "coalesced" event is: exactly
  // ONE message-variant per changed conversation (deduped across streams of the
  // same channel) + AT MOST ONE badge-variant — not a single literal event.

  it('coalesces two streams of the same conversation into ONE message-variant event', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    // Mainline message + a thread reply: two distinct streams, same channel.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'main',
    });
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

    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: root.id,
          position: { kind: 'at_seq', seq: reply.seq },
        },
      ],
    });
    unsub();

    const unreadEvents = events.filter(e => e.kind === 'unread_updated');
    // Both streams advanced, but they share one conversation → one event.
    expect(unreadEvents).toHaveLength(1);
    // #task:1283: enriched message variant — assert discriminator + counts.
    expect(unreadEvents[0]?.payload).toMatchObject({
      conversation_id: channelId,
      conversation_unread_count: expect.any(Number),
      workspace_unread_count: expect.any(Number),
    });
  });

  it('emits a message-variant (with conversation_id) + a badge-variant (without) for a stream+notification batch', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);
    const notifications = new NotificationRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'main',
    });
    // Anchorless directed notification dismissed in the same batch.
    const n = notifications.insert({
      kind: 'agent_start_failed',
      userId: 'local',
      conversationId: channelId,
    });

    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribeScope('viewer:local', e =>
      events.push({ kind: e.kind, payload: e.payload }),
    );
    await http(t).post(observePath, {
      sources: [
        {
          kind: 'stream',
          conversation_id: channelId,
          thread_root_id: null,
          position: { kind: 'stream_head' },
        },
        { kind: 'notification', notification_id: n.id },
      ],
    });
    unsub();

    const unreadEvents = events.filter(e => e.kind === 'unread_updated');
    // One message-variant (cursor advanced) + one badge-variant (read_at set).
    const messageVariant = unreadEvents.filter(
      e => (e.payload as { conversation_id?: unknown }).conversation_id != null,
    );
    const badgeVariant = unreadEvents.filter(
      e => (e.payload as { conversation_id?: unknown }).conversation_id == null,
    );
    expect(messageVariant).toHaveLength(1);
    expect(messageVariant[0]?.payload).toMatchObject({
      conversation_id: channelId,
      conversation_unread_count: expect.any(Number),
      workspace_unread_count: expect.any(Number),
    });
    expect(badgeVariant).toHaveLength(1);
  });
});
