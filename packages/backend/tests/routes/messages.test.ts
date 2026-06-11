import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
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
      name: `ws-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.resolvedRuns = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function seedLegacyThread(
  t: TestApp,
  channelId: string,
  title: string,
  memberAgentIds: string[],
): { thread_id: string } {
  const conversations = new ConversationRepo(t.ctx.db);
  const thread = conversations.insertThread({ channelId, title });
  for (const agentId of memberAgentIds) {
    conversations.addAgent(thread.id, agentId);
  }
  for (const member of conversations.listUsers(channelId)) {
    conversations.addUser(thread.id, member.user_id);
  }
  return { thread_id: thread.id };
}

describe('message routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('human channel routes publish message and legacy thread writes are read-only', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const channelEvents: Array<{ kind: string; payload: any }> = [];
    const viewerEvents: Array<{ kind: string; payload: any }> = [];
    const unsubChannel = t.ctx.events.subscribe(channelId, e => {
      channelEvents.push({ kind: e.kind, payload: e.payload });
    });
    const unsubViewer = t.ctx.events.subscribeScope('viewer:local', e => {
      viewerEvents.push({ kind: e.kind, payload: e.payload });
    });

    const channelPost = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const thread = seedLegacyThread(t, channelId, 'legacy child', []);
    const threadPost = await http(t).post(`/api/threads/${thread.thread_id}/messages`, {
      content: 'thread reply',
    });
    unsubChannel();
    unsubViewer();

    expect(threadPost.status).toBe(409);
    expect(await threadPost.json()).toMatchObject({ code: 'legacy_thread_read_only' });
    expect(channelEvents).toEqual(
      expect.arrayContaining([
        {
          kind: 'message',
          payload: { message: expect.objectContaining({ id: channelPost.message.id }) },
        },
      ]),
    );
    expect(viewerEvents).toEqual(
      expect.arrayContaining([
        { kind: 'unread_updated', payload: { conversation_id: channelId } },
      ]),
    );
    expect(viewerEvents).not.toEqual(
      expect.arrayContaining([
        { kind: 'unread_updated', payload: { conversation_id: thread.thread_id } },
      ]),
    );
  });

  it('routes user requests through the session bearer subject', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const post = await http(t).post(
      `/api/channels/${channelId}/messages`,
      { content: 'from teammate' },
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(post.status).toBe(201);
    const body = await post.json() as any;
    expect(body.message.from_user_id).toBe('teammate');
  });

  it('rejects agent sends originating from legacy threads', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const thread = seedLegacyThread(
      t,
      channelId,
      'child',
      [agentIds.alice!, agentIds.bob!],
    );
    t.fake.delivered = [];
    t.fake.resolvedRuns = [];

    const send = await http(t).post(
      `/internal/conversations/${thread.thread_id}/agents/${agentIds.alice}/send-message`,
      { content: 'up to parent', target: 'parent' },
      { headers: authHeaders(t.authToken) },
    );

    expect(send.status).toBe(409);
    expect(await send.json()).toMatchObject({ code: 'legacy_thread_read_only' });
    const parentMessages = await (
      await http(t).get(`/api/channels/${channelId}/messages`)
    ).json() as any;
    expect(parentMessages.messages.map((m: any) => m.content)).not.toContain('up to parent');
    expect(t.fake.resolvedRuns).toEqual([]);
  });

  it('agent send-message into a closed target returns 409', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const thread = seedLegacyThread(t, channelId, 'child', [agentIds.alice!]);
    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ?, status = 'archived' WHERE id = ?`)
      .run(Date.now(), thread.thread_id);

    const send = await http(t).post(
      `/internal/conversations/${channelId}/agents/${agentIds.alice}/send-message`,
      { content: 'down', target: { thread_id: thread.thread_id } },
      { headers: authHeaders(t.authToken) },
    );

    expect(send.status).toBe(409);
  });
});
