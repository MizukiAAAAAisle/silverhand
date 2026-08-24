import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { SavedMessagesQueryInputSchema } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import fixture from '../fixtures/saved-wire.json' with { type: 'json' };
import queryFixture from '../fixtures/saved-query-wire.json' with { type: 'json' };
import orderingFixture from '../fixtures/saved-ordering.json' with { type: 'json' };

function fixtureCase(name: string): any {
  const found = fixture.find(entry => entry.name === name);
  if (!found) throw new Error(`missing saved fixture case ${name}`);
  return found;
}

function expectedBody(name: string): unknown {
  const entry = fixtureCase(name);
  if (entry.body_case) return expectedBody(entry.body_case);
  if (entry.body?.saved_case) {
    const projected = expectedBody(entry.body.saved_case) as { saved: unknown };
    return { saved: [projected.saved] };
  }
  return entry.body;
}

function normalizeSaved(body: any, ids: { workspace: string; conversation: string; message: string }): any {
  const normalize = (entry: any): any => ({
    ...entry,
    id: 'saved-1',
    saved_at: 1000,
    message: {
      ...entry.message,
      id: entry.message.id === ids.message ? 'message-1' : entry.message.id,
      conversation_id: entry.message.conversation_id === ids.conversation
        ? 'conversation-1'
        : entry.message.conversation_id,
      from_user_id: entry.message.from_user_id === 'local' ? 'user-1' : entry.message.from_user_id,
      author: entry.message.author
        ? { ...entry.message.author, id: entry.message.author.id === 'local' ? 'user-1' : entry.message.author.id }
        : null,
      created_at: 100,
    },
    place: {
      ...entry.place,
      conversation_id: entry.place.conversation_id === ids.conversation
        ? 'conversation-1'
        : entry.place.conversation_id,
      ...(entry.place.workspace_id === ids.workspace ? { workspace_id: 'workspace-1' } : {}),
    },
  });
  return body.saved && Array.isArray(body.saved)
    ? { saved: body.saved.map(normalize) }
    : { saved: normalize(body.saved) };
}

async function body(response: Response): Promise<unknown> {
  return response.status === 204 ? null : response.json();
}

describe('saved wire is signed by the production TypeScript routes', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('consumes every shared route case and publishes only committed changes', async () => {
    t = buildTestApp();
    const workspaceResponse = await http(t).post('/api/workspaces', { name: 'saved-parity' });
    const workspace = ((await workspaceResponse.json()) as any).workspace.id as string;
    const channelResponse = await http(t).post(`/api/workspaces/${workspace}/channels`, {
      title: 'saved-main',
      member_agent_ids: [],
    });
    const conversation = ((await channelResponse.json()) as any).channel.id as string;
    const message = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: conversation,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'saved parity',
    }).id;
    const publicResponse = await http(t).post(`/api/workspaces/${workspace}/channels`, {
      title: 'saved-public',
      visibility: 'public',
      member_agent_ids: [],
    });
    const publicConversation = ((await publicResponse.json()) as any).channel.id as string;
    t.ctx.db.prepare(
      "DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'",
    ).run(publicConversation);
    const publicMessage = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: publicConversation,
      fromKind: 'system',
      content: 'public read is not saved participation',
    }).id;
    const ids = { workspace, conversation, message };
    const events: unknown[] = [];
    const unsubscribe = t.ctx.events.subscribeScope('viewer:local', event => {
      if (event.kind !== 'saved_changed') return;
      const payload = event.payload as Record<string, unknown>;
      events.push({
        ...payload,
        message_id: payload.message_id === message ? 'message-1' : payload.message_id,
      });
    });

    for (const name of ['save_changed', 'save_duplicate'] as const) {
      const response = await http(t).post(`/api/messages/${message}/save`, {});
      expect(response.status, name).toBe(fixtureCase(name).status);
      expect(normalizeSaved(await body(response), ids), name).toEqual(expectedBody(name));
    }
    expect(events).toEqual([fixtureCase('save_changed').event]);

    const list = await http(t).get('/api/saved?workspace_id=' + workspace + '&user_id=local');
    expect(list.status).toBe(fixtureCase('list').status);
    expect(normalizeSaved(await body(list), ids)).toEqual(expectedBody('list'));

    for (const entry of queryFixture.filter(entry => 'path' in entry)) {
      const beyond = await http(t).get(entry.path!);
      expect(beyond.status, entry.name).toBe(200);
      expect(await beyond.json(), entry.name).toEqual({ saved: [] });
      const missingWorkspace = await http(t).get(`${entry.path!}&workspace_id=missing`);
      expect(missingWorkspace.status, `${entry.name}: workspace authority first`).toBe(404);
      expect(await missingWorkspace.json()).toEqual({ error: 'workspace not found' });
    }

    for (const [name, path] of [
      ['list_both_senders', '/api/saved?user_id=local&agent_id=agent-1'],
      ['list_negative_since', '/api/saved?since=-1'],
    ] as const) {
      const response = await http(t).get(path);
      expect(response.status, name).toBe(fixtureCase(name).status);
      expect(await body(response), name).toEqual(expectedBody(name));
    }

    for (const name of ['unsave_changed', 'unsave_duplicate'] as const) {
      const response = await http(t).del(`/api/messages/${message}/save`);
      expect(response.status, name).toBe(fixtureCase(name).status);
      expect(await body(response), name).toEqual(expectedBody(name));
    }
    expect(events).toEqual([
      fixtureCase('save_changed').event,
      fixtureCase('unsave_changed').event,
    ]);

    for (const [name, method] of [
      ['save_missing', 'post'],
      ['unsave_missing', 'del'],
    ] as const) {
      const response = await http(t)[method]('/api/messages/missing/save');
      expect(response.status, name).toBe(fixtureCase(name).status);
      expect(await body(response), name).toEqual(expectedBody(name));
    }
    const publicUnseated = await http(t).post(`/api/messages/${publicMessage}/save`, {});
    expect(publicUnseated.status).toBe(fixtureCase('save_public_unseated').status);
    expect(await body(publicUnseated)).toEqual(expectedBody('save_public_unseated'));
    unsubscribe();

    expect([...new Set(fixture.map(entry => entry.surface))].sort()).toEqual([
      'human_delete',
      'human_get',
      'human_post',
    ]);
    expect(fixture).toHaveLength(10);
  });

  it('uses the persisted saved id as the total-order tie break at the 200-row cap', async () => {
    t = buildTestApp();
    const workspaceResponse = await http(t).post('/api/workspaces', { name: 'saved-ordering' });
    const workspace = ((await workspaceResponse.json()) as any).workspace.id as string;
    const channelResponse = await http(t).post(`/api/workspaces/${workspace}/channels`, {
      title: 'saved-ordering', member_agent_ids: [],
    });
    const conversation = ((await channelResponse.json()) as any).channel.id as string;
    const messages = new MessageRepo(t.ctx.db);
    for (let ordinal = 1; ordinal <= orderingFixture.seed_count; ordinal += 1) {
      const message = messages.insertForConversation({
        conversationId: conversation,
        fromKind: 'user',
        fromUserId: 'local',
        content: `same-millisecond-${ordinal}`,
      });
      t.ctx.db.prepare(
        `INSERT INTO saved_messages (id, user_id, message_id, conversation_id, saved_at)
         VALUES (?, 'local', ?, ?, 1000)`,
      ).run(`saved-${String(ordinal).padStart(3, '0')}`, message.id, conversation);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await http(t).get('/api/saved');
      expect(response.status).toBe(200);
      const ids = ((await response.json()) as any).saved.map((entry: any) => entry.id);
      expect(ids).toHaveLength(orderingFixture.limit);
      expect(ids[0]).toBe(orderingFixture.first_saved_id);
      expect(ids.at(-1)).toBe(orderingFixture.last_saved_id);
    }
  });
});

describe('saved query wire is signed by the production TypeScript schema', () => {
  it('locks ECMAScript trim and number coercion without a second parser', () => {
    for (const entry of queryFixture) {
      const parsed = SavedMessagesQueryInputSchema.safeParse(entry.input);
      if ('issues' in entry) {
        expect(parsed.success, entry.name).toBe(false);
        if (!parsed.success) expect(parsed.error.issues, entry.name).toEqual(entry.issues);
      } else {
        expect(parsed.success, entry.name).toBe(true);
        if (parsed.success) expect(parsed.data, entry.name).toEqual(entry.output);
      }
    }
  });
});
