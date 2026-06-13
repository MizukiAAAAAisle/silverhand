import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGE_REACTION_CHANGED_EVENT } from '@silverhand/shared';
import type { Principal } from '../../src/auth/principal.js';
import {
  addReaction,
  removeReaction,
  type ReactMessageDeps,
} from '../../src/application/react-message.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { MessageReactionRepo } from '../../src/repos/message-reaction-repo.js';
import {
  loadReactionAggregates,
  loadReactionDetail,
} from '../../src/read-model/message-reactions.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Application + repo + read-model tests for message reactions
 * (docs/reactions-design.md §12). The keystone here is §12.A — the
 * CAS-exclusion invariant: a reaction write must never allocate a message
 * seq, advance `conversations.latest_message_seq`, or move any
 * `conversation_stream_heads.latest_seq`. The rest pin reactor isomorphism
 * (user/agent symmetry), idempotency, the authorization guards
 * (system-principal, system-message, non-member, closed/archived), and the
 * read-model projection (viewer_reacted, ordered aggregates, reactor detail).
 */

const LOCAL_USER: Principal = { kind: 'user', userId: 'local' };

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function createWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.workspace.id;
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json()) as any;
  return created.channel.id;
}

function reactDeps(t: TestApp): ReactMessageDeps {
  return {
    ctx: t.ctx,
    conversations: new ConversationRepo(t.ctx.db),
    messages: new MessageRepo(t.ctx.db),
    reactions: new MessageReactionRepo(t.ctx.db),
  };
}

function insertMessage(
  t: TestApp,
  conversationId: string,
  opts: { fromKind: 'user' | 'agent' | 'system'; fromAgentId?: string } = {
    fromKind: 'user',
  },
): string {
  const repo = new MessageRepo(t.ctx.db);
  const m = repo.insertForConversation({
    conversationId,
    fromKind: opts.fromKind,
    ...(opts.fromAgentId ? { fromAgentId: opts.fromAgentId } : {}),
    content: 'hello world',
  });
  return m.id;
}

/** Read the two freshness scalars a reaction write must never move. */
function freshnessSnapshot(
  t: TestApp,
  conversationId: string,
): { latestMessageSeq: number; mainStreamHead: number } {
  const latestMessageSeq =
    t.ctx.db
      .prepare<[string], { latest_message_seq: number }>(
        'SELECT latest_message_seq FROM conversations WHERE id = ?',
      )
      .get(conversationId)?.latest_message_seq ?? 0;
  const mainStreamHead = new MessageRepo(t.ctx.db).streamHeadLatestSeq(
    conversationId,
    null,
  );
  return { latestMessageSeq, mainStreamHead };
}

describe('MessageReactionRepo (persistence)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('add is idempotent over the unique four-tuple; remove + count track it', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'repo-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const repo = new MessageReactionRepo(t.ctx.db);
    const now = Date.now();

    expect(repo.add(messageId, 'user', 'local', '👍', now)).toEqual({ created: true });
    // Re-adding the SAME (message, reactor, emoji) is a no-op.
    expect(repo.add(messageId, 'user', 'local', '👍', now)).toEqual({ created: false });
    expect(repo.countForEmoji(messageId, '👍')).toBe(1);

    // Removing it once removes; removing again is a no-op.
    expect(repo.remove(messageId, 'user', 'local', '👍')).toEqual({ removed: true });
    expect(repo.remove(messageId, 'user', 'local', '👍')).toEqual({ removed: false });
    expect(repo.countForEmoji(messageId, '👍')).toBe(0);
  });
});

describe('react-message use cases (application layer)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('§12.A: a reaction add/remove never moves message seq or stream head', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'cas-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    const before = freshnessSnapshot(t, channelId);

    const added = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: '👀',
    });
    expect(added).toEqual({ ok: true, changed: true, emoji: '👀', count: 1 });
    expect(freshnessSnapshot(t, channelId)).toEqual(before);

    const removed = await removeReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: '👀',
    });
    expect(removed).toEqual({ ok: true, changed: true, emoji: '👀', count: 0 });
    expect(freshnessSnapshot(t, channelId)).toEqual(before);

    // And no message row was ever inserted for the reaction.
    const messageCount = t.ctx.db
      .prepare<[string], { n: number }>(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
      )
      .get(channelId)?.n;
    expect(messageCount).toBe(1);
  });

  it('§12.A: reacting on a reply moves neither the main nor the cluster stream head; event carries thread_root_id', async () => {
    // shiki: CAS exclusion is "both channel and thread". §12.A lists main
    // (thread_root_id IS NULL) and cluster (id=root OR thread_root_id=root)
    // as the two streams; a reaction must move NEITHER head. A real reply is
    // inserted first so the cluster head sits at a non-zero seq before we react.
    t = buildTestApp();
    const ws = await createWorkspace(t, 'cas-thread-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const repo = new MessageRepo(t.ctx.db);
    const root = repo.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'cluster root',
    });
    const reply = repo.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'a reply',
      threadRootId: root.id,
    });
    const deps = reactDeps(t);

    const mainBefore = repo.streamHeadLatestSeq(channelId, null);
    const clusterBefore = repo.streamHeadLatestSeq(channelId, root.id);
    // The reply's insert advanced the cluster head to a real, non-zero seq.
    expect(clusterBefore).toBe(reply.seq);
    const latestBefore = freshnessSnapshot(t, channelId).latestMessageSeq;

    const payloads: any[] = [];
    const off = t.ctx.events.subscribeScope(`conversation:${channelId}`, e => {
      if (e.kind === MESSAGE_REACTION_CHANGED_EVENT) payloads.push(e.payload);
    });
    const res = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId: reply.id,
      emoji: '👍',
    });
    off();

    expect(res).toEqual({ ok: true, changed: true, emoji: '👍', count: 1 });
    // Neither stream head moved, nor did the conversation's latest seq.
    expect(repo.streamHeadLatestSeq(channelId, null)).toBe(mainBefore);
    expect(repo.streamHeadLatestSeq(channelId, root.id)).toBe(clusterBefore);
    expect(freshnessSnapshot(t, channelId).latestMessageSeq).toBe(latestBefore);
    // The event carries the cluster root so the renderer can route the chip
    // to the thread pane (§12.C).
    expect(payloads).toHaveLength(1);
    expect(payloads[0].thread_root_id).toBe(root.id);
  });

  it('reactor isomorphism: a user and an agent react to the same message as distinct reactors', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createWorkspace(t, 'iso-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);
    const agentPrincipal: Principal = {
      kind: 'agent',
      agentId: alice,
      conversationId: channelId,
    };

    const u = await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '🎉' });
    expect(u).toEqual({ ok: true, changed: true, emoji: '🎉', count: 1 });
    const a = await addReaction(deps, { principal: agentPrincipal, messageId, emoji: '🎉' });
    // Same emoji, different reactor → count climbs to 2 (not a dedup).
    expect(a).toEqual({ ok: true, changed: true, emoji: '🎉', count: 2 });

    // Two distinct rows: one user-kind, one agent-kind.
    const rows = t.ctx.db
      .prepare<[string], { reactor_kind: string; reactor_id: string }>(
        'SELECT reactor_kind, reactor_id FROM message_reactions WHERE message_id = ? ORDER BY reactor_kind',
      )
      .all(messageId);
    expect(rows).toEqual([
      { reactor_kind: 'agent', reactor_id: alice },
      { reactor_kind: 'user', reactor_id: 'local' },
    ]);
  });

  it('re-adding / re-removing is an idempotent no-op (changed:false, no event)', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'idem-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    const events: string[] = [];
    const off = t.ctx.events.subscribeScope(`conversation:${channelId}`, e =>
      events.push(e.kind),
    );

    await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👍' });
    const dupe = await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👍' });
    expect(dupe).toEqual({ ok: true, changed: false, emoji: '👍', count: 1 });

    const ghost = await removeReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: '🚀', // never added
    });
    expect(ghost).toEqual({ ok: true, changed: false, emoji: '🚀', count: 0 });
    off();

    // Only the first, real add published an event.
    expect(events).toEqual([MESSAGE_REACTION_CHANGED_EVENT]);
  });

  it('publishes a message_reaction_changed event carrying op/reactor/count', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'evt-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    const payloads: any[] = [];
    const off = t.ctx.events.subscribeScope(`conversation:${channelId}`, e => {
      if (e.kind === MESSAGE_REACTION_CHANGED_EVENT) payloads.push(e.payload);
    });
    await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👀' });
    await removeReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👀' });
    off();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      message_id: messageId,
      conversation_id: channelId,
      thread_root_id: null,
      emoji: '👀',
      op: 'add',
      reactor_kind: 'user',
      reactor_id: 'local',
      count: 1,
    });
    expect(payloads[1]).toMatchObject({ op: 'remove', count: 0 });
  });

  it('rejects an invalid emoji with invalid_reaction (no write)', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'bad-emoji-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    const res = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: 'not an emoji',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('invalid_reaction');
    expect(
      t.ctx.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?',
        )
        .get(messageId)?.n,
    ).toBe(0);
  });

  it('rejects a missing message with message_not_found', async () => {
    t = buildTestApp();
    const deps = reactDeps(t);
    const res = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId: 'does-not-exist',
      emoji: '👍',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('message_not_found');
  });

  it('§12.E: rejects reacting to a system message', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'sys-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId, { fromKind: 'system' });
    const deps = reactDeps(t);

    const res = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: '👍',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('system_message_not_reactable');
  });

  it('rejects a non-member agent principal with forbidden', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const carol = await makeAgent(t, 'carol'); // NOT a channel member
    const ws = await createWorkspace(t, 'acl-ws', [alice, carol]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    const res = await addReaction(deps, {
      principal: { kind: 'agent', agentId: carol, conversationId: channelId },
      messageId,
      emoji: '👍',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('forbidden');
  });

  it('locks message_id to the agent token conversation: a member of BOTH A and B cannot react cross-conversation', async () => {
    // Cindy review boundary: an agent whose token is bound to conversation A
    // must not use it to react on a message in conversation B, EVEN when it
    // is a member of B. The lock is canViewConversation's agent branch
    // (permissions.ts: principal.conversationId === message.conversation_id),
    // mirroring how send only ever writes to the principal's own conversation
    // — react is strictly no-broader. (The token↔(cid,aid) binding is the
    // transport-layer half; this pins the domain-layer half.)
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createWorkspace(t, 'twoconv-ws', [alice]);
    const channelA = await createChannel(t, ws, 'room-a', [alice]);
    const channelB = await createChannel(t, ws, 'room-b', [alice]);
    const messageInB = insertMessage(t, channelB);
    const deps = reactDeps(t);

    // Principal bound to A (as the token would be), targeting B's message.
    const res = await addReaction(deps, {
      principal: { kind: 'agent', agentId: alice, conversationId: channelA },
      messageId: messageInB,
      emoji: '👍',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('forbidden');
    // No write leaked into B.
    expect(
      t.ctx.db
        .prepare<[string], { n: number }>(
          'SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?',
        )
        .get(messageInB)?.n,
    ).toBe(0);

    // Sanity: the SAME agent reacting with a B-bound principal succeeds, so
    // the rejection is specifically the cross-conversation lock, not a
    // blanket membership failure.
    const ok = await addReaction(deps, {
      principal: { kind: 'agent', agentId: alice, conversationId: channelB },
      messageId: messageInB,
      emoji: '👍',
    });
    expect(ok.ok).toBe(true);
  });

  it('§12.F: rejects reacting in an archived conversation', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'arch-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    t.ctx.db
      .prepare('UPDATE conversations SET archived_at = ? WHERE id = ?')
      .run(Date.now(), channelId);

    const res = await addReaction(deps, {
      principal: LOCAL_USER,
      messageId,
      emoji: '👍',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('conversation_archived');
  });
});

describe('reactions read-model', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('loadReactionAggregates: per-emoji counts with viewer_reacted scoped to the viewer', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createWorkspace(t, 'agg-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);
    const agentPrincipal: Principal = {
      kind: 'agent',
      agentId: alice,
      conversationId: channelId,
    };

    await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👍' });
    await addReaction(deps, { principal: agentPrincipal, messageId, emoji: '👍' });
    await addReaction(deps, { principal: agentPrincipal, messageId, emoji: '🎉' });

    const forUser = loadReactionAggregates(t.ctx, [messageId], {
      kind: 'user',
      id: 'local',
    }).get(messageId);
    // Order is by first-reaction time then emoji (§6); two adds in the same
    // millisecond tie-break by emoji codepoint, so assert order-independently.
    expect(forUser).toEqual(
      expect.arrayContaining([
        { emoji: '👍', count: 2, viewer_reacted: true },
        { emoji: '🎉', count: 1, viewer_reacted: false },
      ]),
    );
    expect(forUser).toHaveLength(2);

    const forAgent = loadReactionAggregates(t.ctx, [messageId], {
      kind: 'agent',
      id: alice,
    }).get(messageId);
    expect(forAgent).toEqual(
      expect.arrayContaining([
        { emoji: '👍', count: 2, viewer_reacted: true },
        { emoji: '🎉', count: 1, viewer_reacted: true },
      ]),
    );
    expect(forAgent).toHaveLength(2);

    // A null viewer never reports viewer_reacted.
    const forNobody = loadReactionAggregates(t.ctx, [messageId], null).get(messageId);
    expect(forNobody?.every(a => a.viewer_reacted === false)).toBe(true);

    // A message with no reactions is absent from the map.
    const empty = insertMessage(t, channelId);
    expect(loadReactionAggregates(t.ctx, [empty], null).has(empty)).toBe(false);
  });

  it('loadReactionDetail: groups reactors per emoji with resolved display names', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createWorkspace(t, 'detail-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messageId = insertMessage(t, channelId);
    const deps = reactDeps(t);

    await addReaction(deps, { principal: LOCAL_USER, messageId, emoji: '👍' });
    await addReaction(deps, {
      principal: { kind: 'agent', agentId: alice, conversationId: channelId },
      messageId,
      emoji: '👍',
    });

    const detail = loadReactionDetail(t.ctx, messageId);
    expect(detail).toHaveLength(1);
    expect(detail[0]!.emoji).toBe('👍');
    const reactors = detail[0]!.reactors;
    expect(reactors).toHaveLength(2);
    expect(reactors.map(r => r.kind).sort()).toEqual(['agent', 'user']);
    // Display names resolve server-side (never the raw id fallback here:
    // both the fixture user and the created agent have names).
    expect(reactors.find(r => r.kind === 'agent')?.display_name).toBe('alice');
  });
});
