import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
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

  it('allows a thread member to read parent history via target=parent', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const thread = await (
      await http(t).post(
        `/internal/conversations/${channelId}/agents/${aliceId}/create-thread`,
        {
          title: 'child',
          members: [aliceId],
          context_summary: 'x',
          initial_prompt: 'seed child',
        },
      )
    ).json() as any;
    const parentMessage = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'parent context',
    });

    const res = await http(t).post(
      readHistoryPath(thread.thread_id, aliceId),
      {
        target: 'parent',
        around_message_id: parentMessage.id,
        include_content: true,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.conversation_id).toBe(channelId);
    expect(body.messages.map((m: any) => m.content)).toContain('parent context');
  });

  it('rejects reading a child thread when the caller is not a member of that target', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const thread = await (
      await http(t).post(
        `/internal/conversations/${channelId}/agents/${aliceId}/create-thread`,
        {
          title: 'alice-only child',
          members: [aliceId],
          context_summary: 'x',
          initial_prompt: 'seed child',
        },
      )
    ).json() as any;

    const res = await http(t).post(readHistoryPath(channelId, bobId), {
      target: { thread_id: thread.thread_id },
      before_seq: 99,
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.code).toBe('not_target_conversation_member');
  });
});
