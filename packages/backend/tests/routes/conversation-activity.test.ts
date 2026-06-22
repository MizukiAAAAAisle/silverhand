import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { ConversationEventRepo } from '../../src/repos/conversation-event-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function createAgent(t: TestApp, name: string): Promise<{
  agentId: string;
  dmChannelId: string;
}> {
  const res = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(res.status).toBe(201);
  const body = await res.json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    agentId: body.agent.id,
    dmChannelId: body.dm_channel_id,
  };
}

describe('GET /api/conversations/:id/agents/:aid/activity', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns persisted activity for the selected conversation-agent pair with cursor pagination', async () => {
    t = buildTestApp();
    const { agentId, dmChannelId } = await createAgent(t, 'activity-route');
    const repo = new ConversationEventRepo(t.ctx.db);
    for (let i = 1; i <= 3; i += 1) {
      repo.recordParsedEvent({
        conversationId: dmChannelId,
        agentId,
        event: { kind: 'text', text: `event-${i}` },
        createdAt: 1_700_000_000_000 + i,
      });
    }

    const firstRes = await http(t).get(
      `${apiPaths.conversationAgentActivity(dmChannelId, agentId)}?limit=2`,
    );
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json() as any;
    expect(first.events.map((e: any) => e.payload)).toEqual([
      { text: 'event-2' },
      { text: 'event-3' },
    ]);
    expect(first.next_before_id).toBe(first.events[0].id);

    const secondRes = await http(t).get(
      `${apiPaths.conversationAgentActivity(dmChannelId, agentId)}?limit=2&before_id=${first.next_before_id}`,
    );
    expect(secondRes.status).toBe(200);
    const second = await secondRes.json() as any;
    expect(second.events.map((e: any) => e.payload)).toEqual([
      { text: 'event-1' },
    ]);
    expect(second.next_before_id).toBeNull();
  });

  it('requires the agent to be a member of the selected conversation', async () => {
    t = buildTestApp();
    const first = await createAgent(t, 'activity-member-a');
    const second = await createAgent(t, 'activity-member-b');

    const res = await http(t).get(
      apiPaths.conversationAgentActivity(first.dmChannelId, second.agentId),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: 'agent is not a member of this conversation',
    });
  });

  it('applies the conversation visibility gate before reading activity', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { agentId, dmChannelId } = await createAgent(t, 'activity-private');

    const res = await http(t).get(
      apiPaths.conversationAgentActivity(dmChannelId, agentId),
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other'),
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it('rejects invalid pagination query params', async () => {
    t = buildTestApp();
    const { agentId, dmChannelId } = await createAgent(t, 'activity-invalid');

    const badLimit = await http(t).get(
      `${apiPaths.conversationAgentActivity(dmChannelId, agentId)}?limit=0`,
    );
    expect(badLimit.status).toBe(400);
    expect(await badLimit.json()).toMatchObject({ code: 'invalid_limit' });

    const badBefore = await http(t).get(
      `${apiPaths.conversationAgentActivity(dmChannelId, agentId)}?before_id=nope`,
    );
    expect(badBefore.status).toBe(400);
    expect(await badBefore.json()).toMatchObject({ code: 'invalid_before_id' });
  });
});
