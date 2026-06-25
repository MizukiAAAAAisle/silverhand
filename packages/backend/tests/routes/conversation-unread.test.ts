import { afterEach, describe, expect, it } from 'vitest';
import { apiPaths } from '@silverhand/shared';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

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
      name: 'ws-unread',
      member_agent_ids: [agentId],
    })
  ).json()) as any;
  return { channelId: workspace.onboarding_channel_id, agentId };
}

const unreadPath = (id: string) => apiPaths.conversationUnread(id);

describe('GET /api/conversations/:id/unread', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns mainline + sparse per-thread unread for the viewer', async () => {
    t = buildTestApp();
    const { channelId, agentId } = await createChannel(t);
    const messages = new MessageRepo(t.ctx.db);

    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      content: 'root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      threadRootId: root.id,
      content: 'r1',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentId,
      threadRootId: root.id,
      content: 'r2',
    });

    const res = await http(t).get(unreadPath(channelId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    // Mainline carries the (onboarding) seed messages + the root; the exact
    // count varies with provisioning, but the root is the relevant unread here.
    expect(body.mainline.unread_count).toBeGreaterThanOrEqual(1);
    // Thread is follow-AGNOSTIC and sparse — present because it has 2 unread.
    expect(body.threads[root.id]).toEqual({
      unread_count: 2,
      first_unread_message_id: reply1.id,
      first_unread_seq: reply1.seq,
    });

    // Reading the thread to its head removes it from the sparse map; the chip
    // and Threads list (which both read THIS endpoint) then show 0.
    new ConversationReadRepo(t.ctx.db).markRead({
      viewerUserId: 'local',
      conversationId: channelId,
      threadRootId: root.id,
      seq: reply1.seq + 1,
    });
    const after = (await (await http(t).get(unreadPath(channelId))).json()) as any;
    expect(after.threads[root.id]).toBeUndefined();
  });

  it('404s for an unknown conversation', async () => {
    t = buildTestApp();
    await createChannel(t);
    const res = await http(t).get(unreadPath('does-not-exist'));
    expect(res.status).toBe(404);
  });
});
