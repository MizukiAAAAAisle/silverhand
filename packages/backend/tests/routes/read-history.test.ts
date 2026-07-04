import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { MessageReactionRepo } from '../../src/repos/message-reaction-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
): Promise<{ workspaceId: string; channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = await (
    await http(t).post('/api/workspaces', {
      name: `history-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

function readHistoryPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/read-history`;
}

describe('POST /internal/.../read-history', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('requires exactly one anchor', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;

    const missing = await http(t).post(readHistoryPath(channelId, aliceId), {});
    expect(missing.status).toBe(400);
    const missingBody = await missing.json() as any;
    expect(JSON.stringify(missingBody)).toContain('anchor required');

    const mixed = await http(t).post(readHistoryPath(channelId, aliceId), {
      before_seq: 10,
      after_seq: 1,
    });
    expect(mixed.status).toBe(400);
  });

  it('reads anchored snippets without mutating inbox delivery state', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const first = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'first visible message',
    });
    const second = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'second visible message with enough text for a snippet',
    });
    const third = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'third visible message',
    });
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_inboxes
           (conversation_id, agent_id, message_id, delivered_at, created_at)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(channelId, aliceId, second.id, Date.now());

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      before_seq: third.seq,
      limit: 2,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.conversation_id).toBe(channelId);
    expect(body.anchor).toEqual({ type: 'before_seq', seq: third.seq });
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(body.messages[0].snippet).toBe('first visible message');
    expect(body.messages[0]).not.toHaveProperty('content');
    expect(body.messages[1].sender).toMatchObject({
      kind: 'agent',
      agent_id: aliceId,
    });

    const inbox = t.ctx.db
      .prepare<[string], { delivered_at: number | null }>(
        `SELECT delivered_at FROM conversation_inboxes WHERE message_id = ?`,
      )
      .get(second.id);
    expect(inbox?.delivered_at).toBeNull();
  });

  it('reads full content around a message id and can omit system messages', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'system',
      content: 'system bookkeeping event',
    });
    const anchor = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'anchor body',
    });
    const after = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'after body',
    });

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      around_message_id: anchor.id,
      include_content: true,
      include_system: false,
      limit: 3,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([
      anchor.id,
      after.id,
    ]);
    expect(body.messages[0].content).toBe('anchor body');
    expect(body.messages.every((m: any) => m.sender.kind !== 'system')).toBe(true);
  });

  // Characterization for the read-model SQL extraction (#task:980, Slice B):
  // pin the has_more_before / has_more_after pagination flags at an exact page
  // boundary. buildReadHistoryDto derives these from hasHistoryBefore/After on
  // the returned page's min/max seq; a module relocation that subtly changed the
  // boundary SQL would break this but NOT typecheck. include_system:false keeps
  // the onboarding system message out of the universe so only the five user
  // messages count.
  it('reports has_more_before/after at the page boundary and false on a full page', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const m = Array.from({ length: 5 }, (_, i) =>
      messages.insertForConversation({
        conversationId: channelId,
        fromKind: 'user',
        content: `msg ${i + 1}`,
      }),
    );

    // before_seq = 4th message → the latest 2 rows below it are msg2, msg3.
    // Below msg2 there is msg1 (has_more_before); above msg3 there are msg4,
    // msg5 (has_more_after).
    const mid = await http(t).post(readHistoryPath(channelId, aliceId), {
      before_seq: m[3]!.seq,
      limit: 2,
      include_system: false,
    });
    expect(mid.status).toBe(200);
    const midBody = await mid.json() as any;
    expect(midBody.messages.map((x: any) => x.message_ref.id)).toEqual([
      m[1]!.id,
      m[2]!.id,
    ]);
    expect(midBody.has_more_before).toBe(true);
    expect(midBody.has_more_after).toBe(true);

    // A page that spans every user message: nothing remains on either side.
    const full = await http(t).post(readHistoryPath(channelId, aliceId), {
      before_seq: m[4]!.seq + 1,
      limit: 10,
      include_system: false,
    });
    expect(full.status).toBe(200);
    const fullBody = await full.json() as any;
    expect(fullBody.messages.map((x: any) => x.message_ref.id)).toEqual(
      m.map(x => x.id),
    );
    expect(fullBody.has_more_before).toBe(false);
    expect(fullBody.has_more_after).toBe(false);
  });

  // Reply-cluster read path (docs/thread-reply-cluster-v1.md §6; cut2 2-B2).
  // `target: { thread_root_id }` reads the cluster INSIDE the root message's
  // channel — the root (anchor) plus every reply (thread_root_id = root) —
  // and nothing else. The DTO target echoes the canonical root so the daemon
  // side can tell the anchor root apart from its replies (observed advances
  // on replies only).
  it('reads a reply cluster: root anchor + its replies, excluding other channel messages', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'cluster root question',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'first reply',
      threadRootId: root.id,
    });
    // interleaved main-line noise — must NOT appear in the cluster read.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'unrelated main-line message',
    });
    const reply2 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'second reply',
      threadRootId: root.id,
    });
    // a different cluster — must not leak in.
    const otherRoot = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'other root',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'other reply',
      threadRootId: otherRoot.id,
    });

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      target: { thread_root_id: root.id },
      after_seq: 0,
      limit: 50,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.thread_root_id).toBe(root.id);
    expect(body.target.conversation_id).toBe(channelId);
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([
      root.id,
      reply1.id,
      reply2.id,
    ]);
  });

  it('normalizes a reply id to its canonical root when reading a cluster', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'reply one',
      threadRootId: root.id,
    });
    const reply2 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'reply two',
      threadRootId: root.id,
    });

    // Target a REPLY id, not the root — the server normalizes to the root
    // (symmetry with send-side resolveThreadRoot) and reads the whole cluster.
    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      target: { thread_root_id: reply1.id },
      after_seq: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.thread_root_id).toBe(root.id);
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([
      root.id,
      reply1.id,
      reply2.id,
    ]);
  });

  it('lets a channel member read a cluster without following it (channel-visibility gate, not follow gate)', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'reply',
      threadRootId: root.id,
    });

    // bob is a channel member but has NO thread_followers row — he can still
    // pull the cluster (pull is channel-visibility gated, never follow gated).
    const res = await http(t).post(readHistoryPath(channelId, bobId), {
      target: { thread_root_id: root.id },
      after_seq: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([
      root.id,
      reply.id,
    ]);
  });

  it('rejects an unknown thread root message id with thread_root_not_found', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      target: { thread_root_id: 'does-not-exist' },
      after_seq: 0,
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('thread_root_not_found');
  });

  it('returns only the root for a cluster with no replies (underpins seen=0 on first reply)', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'lonely root with no replies yet',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'main-line noise',
    });

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      target: { thread_root_id: root.id },
      after_seq: 0,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.thread_root_id).toBe(root.id);
    expect(body.messages.map((m: any) => m.message_ref.id)).toEqual([root.id]);
  });

  // Reaction visibility on the agent read surface (docs/reactions-design.md
  // §12.C): an agent that can `message react` must also SEE reactions when it
  // reads history — counts plus its own `viewer_reacted` — on both the main
  // line and the reply-cluster pull. This is the S2 "read-history agent viewer
  // semantics" contract, not S4 renderer.
  it('main-line read-history carries reaction aggregates with the calling agent as viewer', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const reacted = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'a message that gets reactions',
    });
    const plain = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'a message with no reactions',
    });

    // The agent reacts via its own CLI route — the exact write path Cindy
    // flagged ("写得了但看不见"). A human also reacts with a different emoji.
    const react = await http(t).post(
      `/internal/conversations/${channelId}/agents/${aliceId}/react-message`,
      { message_id: reacted.id, emoji: '👀' },
    );
    expect(react.status).toBe(200);
    new MessageReactionRepo(t.ctx.db).add(reacted.id, 'user', 'local', '🎉', Date.now());

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      after_seq: 0,
      limit: 50,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const byId = new Map<string, any>(
      body.messages.map((m: any) => [m.message_ref.id, m]),
    );
    // Agent's own 👀 → viewer_reacted true; the human's 🎉 → present, not the
    // agent's. Order is first-reaction-time then emoji; assert set-wise.
    expect(byId.get(reacted.id).reactions).toEqual(
      expect.arrayContaining([
        { emoji: '👀', count: 1, viewer_reacted: true },
        { emoji: '🎉', count: 1, viewer_reacted: false },
      ]),
    );
    expect(byId.get(reacted.id).reactions).toHaveLength(2);
    // A message with no reactions → null.
    expect(byId.get(plain.id).reactions).toBeNull();
  });

  it('reply-cluster read-history carries viewer_reacted for the calling agent (§12.C thread-pull)', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'cluster root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'a reply that the agent reacts to',
      threadRootId: root.id,
    });

    const react = await http(t).post(
      `/internal/conversations/${channelId}/agents/${aliceId}/react-message`,
      { message_id: reply.id, emoji: '👍' },
    );
    expect(react.status).toBe(200);

    const res = await http(t).post(readHistoryPath(channelId, aliceId), {
      target: { thread_root_id: root.id },
      after_seq: 0,
      limit: 50,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const replyRow = body.messages.find(
      (m: any) => m.message_ref.id === reply.id,
    );
    expect(replyRow.reactions).toEqual([
      { emoji: '👍', count: 1, viewer_reacted: true },
    ]);
    // The unreacted root carries null.
    const rootRow = body.messages.find((m: any) => m.message_ref.id === root.id);
    expect(rootRow.reactions).toBeNull();
  });
});
