import { afterEach, describe, expect, it } from 'vitest';
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
      name: `thread-ws-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

describe('thread routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('message thread route creates once and reuses without a second publish', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const posted = await (
      await http(t).post(`/api/channels/${channelId}/messages`, {
        content: 'open a focused thread',
      })
    ).json() as any;
    const events: Array<{ kind: string; payload: any }> = [];
    const unsub = t.ctx.events.subscribe(channelId, e => {
      if (e.kind === 'thread_updated') events.push({ kind: e.kind, payload: e.payload });
    });

    const first = await http(t).post(`/api/messages/${posted.message.id}/thread`);
    const firstBody = await first.json() as any;
    const second = await http(t).post(`/api/messages/${posted.message.id}/thread`);
    const secondBody = await second.json() as any;
    unsub();

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      thread_id: firstBody.thread_id,
      reused: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: 'thread_updated',
      payload: {
        parent_conversation_id: channelId,
        thread_id: firstBody.thread_id,
      },
    });
  });

});
