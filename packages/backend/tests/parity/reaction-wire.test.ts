import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { MESSAGE_REACTION_CHANGED_EVENT } from '@silverhand/shared';
import { buildTestApp, conversationSlotAuth, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/reaction-wire.json' with { type: 'json' };

async function makeAgent(t: TestApp): Promise<string> {
  const response = await http(t).post('/api/agents', { name: 'reaction-agent', runtime: 'claude' });
  return ((await response.json()) as any).agent.id;
}

async function createWorkspace(t: TestApp, agent: string): Promise<string> {
  const response = await http(t).post('/api/workspaces', { name: 'reaction-parity', member_agent_ids: [agent] });
  return ((await response.json()) as any).workspace.id;
}

async function createChannel(t: TestApp, workspace: string, title: string, agent: string): Promise<string> {
  const response = await http(t).post(`/api/workspaces/${workspace}/channels`, { title, member_agent_ids: [agent] });
  return ((await response.json()) as any).channel.id;
}

function insertMessage(t: TestApp, conversation: string, fromKind: 'user' | 'system' = 'user'): string {
  return new MessageRepo(t.ctx.db).insertForConversation({ conversationId: conversation, fromKind, content: 'hello' }).id;
}

async function assertCase(name: string, response: Response): Promise<void> {
  const expected = fixture.find(entry => entry.name === name);
  if (!expected) throw new Error(`missing reaction fixture case ${name}`);
  expect(response.status, name).toBe(expected.status);
  expect(await response.json(), name).toEqual(expected.body);
}

function fixtureCase(name: string): (typeof fixture)[number] {
  const expected = fixture.find(entry => entry.name === name);
  if (!expected) throw new Error(`missing reaction fixture case ${name}`);
  return expected;
}

describe('reaction wire is signed by the production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('consumes every shared success/refusal case through real routes', async () => {
    t = buildTestApp();
    const agent = await makeAgent(t);
    const workspace = await createWorkspace(t, agent);
    const channel = await createChannel(t, workspace, 'main', agent);
    const other = await createChannel(t, workspace, 'other', agent);
    const message = insertMessage(t, channel);
    const system = insertMessage(t, channel, 'system');

    const events: unknown[] = [];
    const unsubscribe = t.ctx.events.subscribeScope(`conversation:${channel}`, event => {
      if (event.kind !== MESSAGE_REACTION_CHANGED_EVENT) return;
      events.push({
        ...event.payload,
        message_id: 'message-1',
        conversation_id: 'conversation-1',
        reactor_id: 'user-1',
      });
    });

    await assertCase('human_add', await http(t).post(`/api/messages/${message}/reactions`, { emoji: '👀' }));
    expect(events).toEqual([fixtureCase('human_add').event]);
    unsubscribe();
    await assertCase('human_duplicate', await http(t).post(`/api/messages/${message}/reactions`, { emoji: '👀' }));
    await assertCase('human_remove', await http(t).del(`/api/messages/${message}/reactions`, { body: JSON.stringify({ emoji: '👀' }), headers: { 'content-type': 'application/json' } }));
    await assertCase('invalid_reaction', await http(t).post(`/api/messages/${message}/reactions`, { emoji: 'not emoji' }));
    await assertCase('missing_message', await http(t).post('/api/messages/missing/reactions', { emoji: '👍' }));
    await assertCase('system_target', await http(t).post(`/api/messages/${system}/reactions`, { emoji: '👍' }));

    t.ctx.db.prepare('UPDATE conversations SET closed_at = 1 WHERE id = ?').run(channel);
    await assertCase('closed_conversation', await http(t).post(`/api/messages/${message}/reactions`, { emoji: '👍' }));
    t.ctx.db.prepare('UPDATE conversations SET closed_at = NULL, archived_at = 1 WHERE id = ?').run(channel);
    await assertCase('archived_conversation', await http(t).post(`/api/messages/${message}/reactions`, { emoji: '👍' }));
    t.ctx.db.prepare('UPDATE conversations SET archived_at = NULL WHERE id = ?').run(channel);

    await assertCase('agent_add', await http(t, conversationSlotAuth(t, channel, agent)).post(`/internal/agents/${agent}/react-message`, { message_id: message, emoji: '🎯' }));
    await assertCase('agent_wrong_source', await http(t, conversationSlotAuth(t, other, agent)).post(`/internal/agents/${agent}/react-message`, { message_id: message, emoji: '🚀' }));
    t.ctx.db.prepare("DELETE FROM workspace_agent_capabilities WHERE workspace_id = ? AND agent_id = ? AND capability = 'send_messages'").run(workspace, agent);
    await assertCase('agent_capability_denied', await http(t, conversationSlotAuth(t, channel, agent)).post(`/internal/agents/${agent}/react-message`, { message_id: message, emoji: '🚀' }));

    expect(fixture.map(entry => entry.name)).toHaveLength(11);
  });
});
