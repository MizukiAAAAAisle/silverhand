import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { MessageReactionRepo } from '../../src/repos/message-reaction-repo.js';
import {
  buildTestApp,
  conversationSlotAuth,
  http,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';

/**
 * HTTP-surface tests for message reactions (docs/reactions-design.md §5.1):
 *   - human viewer routes: POST / DELETE / GET /api/messages/:id/reactions
 *   - internal agent routes: POST / DELETE .../react-message
 *   - the message-window read enriches each row with the viewer's aggregates
 * The application contract (idempotency, CAS exclusion, isomorphism) is pinned
 * in tests/application/react-message.test.ts; here we pin the route mapping
 * (status codes, principal wiring, body shapes).
 */

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

function insertMessage(
  t: TestApp,
  conversationId: string,
  opts: { fromKind: 'user' | 'agent' | 'system' } = { fromKind: 'user' },
): string {
  return new MessageRepo(t.ctx.db).insertForConversation({
    conversationId,
    fromKind: opts.fromKind,
    content: 'hi',
  }).id;
}

describe('message reaction routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('human viewer can add, read detail, and remove a reaction', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'human-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);

    const addRes = await http(t).post(`/api/messages/${messageId}/reactions`, {
      emoji: '👀',
    });
    expect(addRes.status).toBe(200);
    expect(await addRes.json()).toEqual({ changed: true, emoji: '👀', count: 1 });

    const detailRes = await http(t).get(`/api/messages/${messageId}/reactions`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as any;
    expect(detail.reactions).toEqual([
      {
        emoji: '👀',
        reactors: [{ kind: 'user', id: 'local', display_name: expect.any(String) }],
      },
    ]);

    const delRes = await http(t).del(`/api/messages/${messageId}/reactions`, {
      body: JSON.stringify({ emoji: '👀' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ changed: true, emoji: '👀', count: 0 });
  });

  it('maps an invalid emoji to 422 invalid_reaction', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'bad-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId);

    const res = await http(t).post(`/api/messages/${messageId}/reactions`, {
      emoji: 'nope nope',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('invalid_reaction');
  });

  it('maps a system-message target to 422 system_message_not_reactable', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'sys-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const messageId = insertMessage(t, channelId, { fromKind: 'system' });

    const res = await http(t).post(`/api/messages/${messageId}/reactions`, {
      emoji: '👍',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe('system_message_not_reactable');
  });

  it('maps a missing message to 404 message_not_found', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/messages/missing/reactions', {
      emoji: '👍',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).code).toBe('message_not_found');
  });

  it('agent reacts via the internal route as an agent-kind reactor', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await createWorkspace(t, 'agent-ws', [alice]);
    const channelId = await createChannel(t, ws, 'room', [alice]);
    const messageId = insertMessage(t, channelId);

    const res = await http(t, conversationSlotAuth(t, channelId, alice)).post(
      `/internal/agents/${alice}/react-message`,
      { message_id: messageId, emoji: '🎉' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true, emoji: '🎉', count: 1 });

    // Persisted as an agent reactor.
    const row = t.ctx.db
      .prepare<[string], { reactor_kind: string; reactor_id: string }>(
        'SELECT reactor_kind, reactor_id FROM message_reactions WHERE message_id = ?',
      )
      .get(messageId);
    expect(row).toEqual({ reactor_kind: 'agent', reactor_id: alice });

    // DELETE via the internal route takes it back.
    const del = await http(t, conversationSlotAuth(t, channelId, alice)).del(
      `/internal/agents/${alice}/react-message`,
      {
        body: JSON.stringify({ message_id: messageId, emoji: '🎉' }),
        headers: { 'content-type': 'application/json' },
      },
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ changed: true, emoji: '🎉', count: 0 });
  });

  it('keeps object-addressed reaction writes inside a ConversationSlot while AgentSlot remains cross-stream', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const global = insertAgentScopedAgent(t, alice, 'global');
    const ws = await createWorkspace(t, 'reaction-reach', [alice, global]);
    const anchor = await createChannel(t, ws, 'anchor', [alice, global]);
    const owner = await createChannel(t, ws, 'owner', [alice, global]);
    const messageId = insertMessage(t, owner);
    const path = `/internal/agents/${alice}/react-message`;
    const reactions = new MessageReactionRepo(t.ctx.db);

    const confinedAdd = await http(t, conversationSlotAuth(t, anchor, alice)).post(
      path,
      { message_id: messageId, emoji: '🎯' },
    );
    expect(confinedAdd.status).toBe(404);
    expect(await confinedAdd.json()).toEqual({ error: 'message not found' });
    expect(reactions.countForEmoji(messageId, '🎯')).toBe(0);

    const globalPath = `/internal/agents/${global}/react-message`;
    const globalAdd = await http(t, agentSlotAuth(t, global)).post(globalPath, {
      message_id: messageId,
      emoji: '🎯',
    });
    expect(globalAdd.status).toBe(200);
    expect(reactions.countForEmoji(messageId, '🎯')).toBe(1);

    const confinedRemove = await http(
      t,
      conversationSlotAuth(t, anchor, alice),
    ).del(path, {
      body: JSON.stringify({ message_id: messageId, emoji: '🎯' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(confinedRemove.status).toBe(404);
    expect(await confinedRemove.json()).toEqual({ error: 'message not found' });
    expect(reactions.countForEmoji(messageId, '🎯')).toBe(1);
  });

  it('the message-window read enriches rows with the viewer aggregates', async () => {
    t = buildTestApp();
    const ws = await createWorkspace(t, 'window-ws', []);
    const channelId = await createChannel(t, ws, 'room', []);
    const reacted = insertMessage(t, channelId);
    const plain = insertMessage(t, channelId);

    await http(t).post(`/api/messages/${reacted}/reactions`, { emoji: '👍' });

    const res = await http(t).get(`/api/channels/${channelId}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const byId = new Map<string, any>(body.messages.map((m: any) => [m.id, m]));
    expect(byId.get(reacted).reactions).toEqual([
      { emoji: '👍', count: 1, viewer_reacted: true },
    ]);
    // A message with no reactions carries reactions: null.
    expect(byId.get(plain).reactions).toBeNull();
  });
});
