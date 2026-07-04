import { afterEach, describe, expect, it } from 'vitest';
import { X_SILVERHAND_PRINCIPAL_HEADER } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function setupSession(
  t: TestApp,
  members: string[] = ['alice', 'bob'],
): Promise<{
  conversationId: string;
  channelId: string;
  agentIds: Record<string, string>;
}> {
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const r = await (
      await http(t).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = r.agent.id;
  }
  const ws = await (
    await http(t).post('/api/workspaces', {
      name: 'eng',
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  // reset spawn sinks
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    conversationId: ws.onboarding_channel_id,
    channelId: ws.workspace.id,
    agentIds,
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('Internal route auth', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects request with no Authorization header (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const r = await http(t.app).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
    );
    expect(r.status).toBe(401);
  });

  it('rejects request with wrong bearer token (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
      { headers: authHeaders('wrong') },
    );
    expect(r.status).toBe(401);
  });

  it('accepts a token scoped to the URL conversation and agent', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t);
    const token = t.ctx.agentTokens.issue(conversationId, agentIds.alice!);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
      { headers: authHeaders(token) },
    );
    expect(r.status).toBe(200);
  });

  it('rejects a token scoped to a different agent URL (401)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const aliceToken = t.ctx.agentTokens.issue(conversationId, agentIds.alice!);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.bob}/send-message`,
      { content: 'hi' },
      { headers: authHeaders(aliceToken) },
    );
    expect(r.status).toBe(401);
  });

  it.each(['agent:forged', 'user:local'])(
    'rejects principal header %s on internal routes (400)',
    async principalHeader => {
      t = buildTestApp();
      const { conversationId, agentIds } = await setupSession(t);
      const r = await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
        { content: 'hi' },
        {
          headers: {
            ...authHeaders(t.authToken),
            [X_SILVERHAND_PRINCIPAL_HEADER]: principalHeader,
          },
        },
      );
      expect(r.status).toBe(400);
      const body = await r.json() as any;
      expect(body.error).toBe('principal header is not allowed on internal routes');
    },
  );
});

describe('POST /internal/.../send-message', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('writes the message to self target + distributes to other agents (not the sender)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubViewer = t.ctx.events.subscribeScope('viewer:local', e => {
      viewerEvents.push({ kind: e.kind, payload: e.payload });
    });
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'hello team' },
      { headers: authHeaders(t.authToken) },
    );
    unsubViewer();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.message_id).toBe('string');
    expect(typeof body.message_seq).toBe('number');

    // Sender (alice) is excluded; bob gets the delivery.
    expect(t.fake.delivered.map(d => d.agentId)).toEqual([agentIds.bob]);
    expect(t.fake.delivered[0]!.conversationId).toBe(conversationId);

    const msgs = await (
      await http(t).get(`/api/channels/${conversationId}/messages`)
    ).json() as any;
    const inserted = msgs.messages.find((m: any) => m.id === body.message_id);
    expect(inserted.seq).toBe(body.message_seq);
    expect(inserted.from_kind).toBe('agent');
    expect(inserted.from_agent_id).toBe(agentIds.alice);
    expect(inserted.content).toBe('hello team');
    // #task:1283: message variant enriched with absolute counts; assert the
    // discriminator + presence of the enriched fields.
    expect(viewerEvents).toContainEqual(
      expect.objectContaining({
        kind: 'unread_updated',
        payload: expect.objectContaining({
          conversation_id: conversationId,
          conversation_unread_count: expect.any(Number),
          workspace_unread_count: expect.any(Number),
        }),
      }),
    );
  });

  it('returns a stale_event_id when same-conversation agent send is stale', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const observed = await (
      await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
        { content: 'observed' },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;
    await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.bob}/send-message`,
      { content: 'newer context' },
      { headers: authHeaders(t.authToken) },
    );

    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'stale draft', seen_up_to_seq: observed.message_seq },
      { headers: authHeaders(t.authToken) },
    );

    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.error.code).toBe('conflict');
    expect(body.error.details.subkind).toBe('message_stale');
    expect(typeof body.error.details.stale_event_id).toBe('string');
    expect(body.error.details.current_seq).toBe(observed.message_seq + 1);
  });

  it('accepts obsolete stale-resolution telemetry without sending a message', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/stale-message-resolution`,
      { stale_event_id: 'evt-obsolete', resolution_reason: 'obsolete' },
      { headers: authHeaders(t.authToken) },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('rejects parent target when current session has no parent', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      { content: 'up', target: 'parent' },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.code).toBe('no_parent');
  });

});

describe('POST /internal/.../create-channel', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates a top-level channel in the current workspace with all current members', async () => {
    t = buildTestApp();
    const { conversationId, channelId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const outsider = await (
      await http(t).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    t.fake.starts = [];
    t.fake.delivered = [];
    const workspaceEvents: Array<{ kind: string; payload: any }> = [];
    const unsubscribe = t.ctx.events.subscribeScope(
      `workspace:${channelId}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-channel`,
      {
        title: 'release signing',
        context_summary: 'user explicitly asked to split release signing out',
        initial_prompt: 'Discuss release signing separately.',
        channel_id: 'other-channel',
        members: [outsider.agent.id],
      },
      { headers: authHeaders(t.authToken) },
    );
    unsubscribe();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.channel_id).toBe('string');
    expect(Object.keys(body)).toEqual(['channel_id']);

    const created = await (
      await http(t).get(`/api/channels/${body.channel_id}`)
    ).json() as any;
    expect(created.channel.parent_conversation_id).toBeNull();
    expect(created.channel.workspace_id).toBe(channelId);
    expect(created.channel.spawned_by_agent_id).toBe(agentIds.alice);
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: channelId,
        channel_id: body.channel_id,
      },
    });

    const channelAgents = await (
      await http(t).get(`/api/channels/${body.channel_id}/agents`)
    ).json() as any;
    expect(channelAgents.agents.map((a: any) => a.agent_id).sort()).toEqual([
      agentIds.alice,
      agentIds.bob,
    ].sort());
    expect(
      channelAgents.agents.map((a: any) => a.agent_id),
    ).not.toContain(outsider.agent.id);

    const msgs = await (
      await http(t).get(`/api/channels/${body.channel_id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('release signing out');
    expect(msgs.messages[1].from_kind).toBe('agent');
    expect(msgs.messages[1].from_agent_id).toBe(agentIds.alice);
    expect(msgs.messages[1].content).toBe('Discuss release signing separately.');

    expect(t.fake.delivered).toEqual([
      {
        conversationId: body.channel_id,
        agentId: agentIds.alice,
        messageId: msgs.messages[0].id,
      },
      {
        conversationId: body.channel_id,
        agentId: agentIds.bob,
        messageId: msgs.messages[1].id,
      },
    ]);
    expect(t.fake.starts).toHaveLength(2);
    expect(t.fake.starts).toEqual(expect.arrayContaining([
      { conversationId: body.channel_id, agentId: agentIds.alice },
      { conversationId: body.channel_id, agentId: agentIds.bob },
    ]));
  });

  it('requires an initial_prompt', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-channel`,
      {
        title: 'missing prompt',
        context_summary: 'x',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
  });

  it('returns not found for a missing actor agent', async () => {
    t = buildTestApp();
    const { conversationId } = await setupSession(t, ['alice']);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/missing-agent/create-channel`,
      {
        title: 'missing actor',
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(404);
  });
});
