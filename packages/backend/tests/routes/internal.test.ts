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

    // Sender (alice) is excluded; bob gets the delivery.
    expect(t.fake.delivered.map(d => d.agentId)).toEqual([agentIds.bob]);
    expect(t.fake.delivered[0]!.conversationId).toBe(conversationId);

    const msgs = await (
      await http(t).get(`/api/channels/${conversationId}/messages`)
    ).json() as any;
    const inserted = msgs.messages.find((m: any) => m.id === body.message_id);
    expect(inserted.from_kind).toBe('agent');
    expect(inserted.from_agent_id).toBe(agentIds.alice);
    expect(inserted.content).toBe('hello team');
    expect(viewerEvents).toContainEqual({
      kind: 'unread_updated',
      payload: { conversation_id: conversationId },
    });
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

  it('rejects child target that is not a direct child', async () => {
    t = buildTestApp();
    const { conversationId, agentIds, channelId } = await setupSession(t, ['alice']);
    // Make a sibling top-level channel with its own thread, not a direct
    // child of the current conversation.
    const sibling = await (
      await http(t).post(`/api/workspaces/${channelId}/channels`, {
        title: 'sibling',
        member_agent_ids: [agentIds.alice],
      })
    ).json() as any;
    const siblingThread = await (
      await http(t).post(
        `/internal/conversations/${sibling.channel.id}/agents/${agentIds.alice}/create-thread`,
        {
          title: 'sibling child',
          members: [agentIds.alice],
          context_summary: 'x',
          initial_prompt: 'seed',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      {
        content: 'down',
        target: { thread_id: siblingThread.thread_id },
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
  });

  it('writes to a real thread via { thread_id }', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const child = await (
      await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
        {
        title: 'child',
        members: [agentIds.alice],
        context_summary: 'x',
        initial_prompt: 'seed child',
      },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/send-message`,
      {
        content: 'down to child',
        target: { thread_id: child.thread_id },
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const childMsgs = await (
      await http(t).get(`/api/threads/${child.thread_id}/messages`)
    ).json() as any;
    expect(
      childMsgs.messages.some(
        (m: any) => m.from_kind === 'agent' && m.content === 'down to child',
      ),
    ).toBe(true);
  });

});

describe('POST /internal/.../create-thread', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects members that are not in the parent channel (400)', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    const outsider = await (
      await http(t).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
      {
        title: 'oops',
        members: [outsider.agent.id],
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
  });

  it('creates a child thread, lists it without an anchor, and seeds 2 messages', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribe(conversationId, e => events.push(e));
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
      {
        title: 'investigate',
        members: [agentIds.bob],
        context_summary: 'looking at perf',
        initial_prompt: 'profile the hot path',
      },
      { headers: authHeaders(t.authToken) },
    );
    unsub();
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.thread_id).toBe('string');

    const threadSummary = await (
      await http(t).get(`/api/channels/${conversationId}/threads`)
    ).json() as any;
    expect(threadSummary.threads).toContainEqual({
      thread_id: body.thread_id,
      anchor_message_id: null,
      reply_count: 1,
    });
    expect(events).toContainEqual({
      kind: 'thread_updated',
      payload: {
        parent_conversation_id: conversationId,
        thread_id: body.thread_id,
      },
    });

    const msgs = await (
      await http(t).get(`/api/threads/${body.thread_id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('looking at perf');
    expect(msgs.messages[1].from_kind).toBe('agent');
    expect(msgs.messages[1].from_agent_id).toBe(agentIds.alice);
    expect(msgs.messages[1].content).toBe('profile the hot path');

    expect(t.fake.delivered).toEqual([
      {
        conversationId: body.thread_id,
        agentId: agentIds.alice,
        messageId: msgs.messages[0].id,
      },
      {
        conversationId: body.thread_id,
        agentId: agentIds.bob,
        messageId: msgs.messages[1].id,
      },
    ]);
    expect(t.fake.starts).toEqual([
      { conversationId: body.thread_id, agentId: agentIds.bob },
    ]);

    // Explicit subsets are allowed, but the caller is always included.
    const childAgents = await (
      await http(t).get(`/api/threads/${body.thread_id}/agents`)
    ).json() as any;
    expect(childAgents.agents.map((a: any) => a.agent_id).sort()).toEqual(
      [agentIds.alice, agentIds.bob].sort(),
    );
  });

  it('defaults create_thread members to all current channel members', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const r = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
      {
        title: 'default-members',
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    const childAgents = await (
      await http(t).get(`/api/threads/${body.thread_id}/agents`)
    ).json() as any;
    expect(childAgents.agents.map((a: any) => a.agent_id).sort()).toEqual(
      [agentIds.alice, agentIds.bob].sort(),
    );
  });

  it('surfaces concurrent_limit as 429', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice']);
    t.ctx.serverConfig = {
      ...t.ctx.serverConfig,
      child_sessions: {
        max_concurrent_per_parent: 1,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };

    const ok = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
      {
        title: 'c1',
        members: [agentIds.alice],
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(ok.status).toBe(200);

    const second = await http(t).post(
      `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
      {
        title: 'c2',
        members: [agentIds.alice],
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(second.status).toBe(429);
    const body = await second.json() as any;
    expect(body.code).toBe('concurrent_limit');
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

  it('creates a top-level sibling when invoked from a child session', async () => {
    t = buildTestApp();
    const { conversationId, channelId, agentIds } = await setupSession(t, ['alice']);
    const child = await (
      await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
        {
          title: 'thread',
          members: [agentIds.alice],
          context_summary: 'x',
          initial_prompt: 'go',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;

    const r = await http(t).post(
      `/internal/conversations/${child.thread_id}/agents/${agentIds.alice}/create-channel`,
      {
        title: 'sibling topic',
        context_summary: 'user asked for a separate top-level session',
        initial_prompt: 'Continue this topic in a new session.',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    const created = await (
      await http(t).get(`/api/channels/${body.channel_id}`)
    ).json() as any;
    expect(created.channel.workspace_id).toBe(channelId);
    expect(created.channel.parent_conversation_id).toBeNull();
  });

  it('uses current thread members, not parent channel members, when creating a channel from a thread', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const child = await (
      await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
        {
          title: 'alice-only-thread',
          members: [agentIds.alice],
          context_summary: 'x',
          initial_prompt: 'go',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;

    const created = await (
      await http(t).post(
        `/internal/conversations/${child.thread_id}/agents/${agentIds.alice}/create-channel`,
        {
          title: 'thread-member-snapshot',
          context_summary: 'from thread',
          initial_prompt: 'continue here',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;
    const channelAgents = await (
      await http(t).get(`/api/channels/${created.channel_id}/agents`)
    ).json() as any;
    expect(channelAgents.agents.map((a: any) => a.agent_id)).toEqual([agentIds.alice]);
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

describe('POST /internal/.../close-thread', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('child agent close posts summary to parent + tells ConversationManager.stop for every member', async () => {
    t = buildTestApp();
    const { conversationId, agentIds } = await setupSession(t, ['alice', 'bob']);
    // spawn a child via the internal route
    const child = await (
      await http(t).post(
        `/internal/conversations/${conversationId}/agents/${agentIds.alice}/create-thread`,
        {
          title: 'inv',
          members: [agentIds.bob],
          context_summary: 'x',
          initial_prompt: 'go',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;

    t.fake.stops = [];
    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribe(conversationId, e => events.push(e));

    const close = await http(t).post(
      `/internal/conversations/${child.thread_id}/agents/${agentIds.bob}/close-thread`,
      { summary: 'done' },
      { headers: authHeaders(t.authToken) },
    );
    unsub();
    expect(close.status).toBe(200);

    // Parent got an auto-summary system message
    const parentMsgs = await (
      await http(t).get(`/api/channels/${conversationId}/messages`)
    ).json() as any;
    const summary = parentMsgs.messages.find(
      (m: any) => m.from_kind === 'system' && m.content.includes('inv'),
    );
    expect(summary).toBeDefined();
    expect(summary.content).toContain('done');
    expect(summary.content).toContain('@bob');

    // Every member of the closed session got stop() called
    expect(
      t.fake.stops.some(
        s => s.conversationId === child.thread_id && s.agentId === agentIds.bob,
      ),
    ).toBe(true);

    const threadUpdated = events.find(e => e.kind === 'thread_updated')?.payload as any;
    expect(threadUpdated).toMatchObject({
      parent_conversation_id: conversationId,
      thread_id: child.thread_id,
    });
  });
});
