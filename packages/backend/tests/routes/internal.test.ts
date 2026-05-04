import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function setupSession(
  t: TestApp,
  members: string[] = ['alice', 'bob'],
): Promise<{
  sessionId: string;
  channelId: string;
  agentIds: Record<string, string>;
}> {
  const agentIds: Record<string, string> = {};
  for (const name of members) {
    const r = await (
      await http(t.app).post('/api/agents', { name, runtime: 'claude' })
    ).json() as any;
    agentIds[name] = r.agent.id;
  }
  const ch = await (
    await http(t.app).post('/api/channels', {
      name: 'eng',
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  const session = await (
    await http(t.app).post(`/api/channels/${ch.channel.id}/sessions`, {
      title: 's',
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  // reset spawn sinks
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return {
    sessionId: session.session.id,
    channelId: ch.channel.id,
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
    const { sessionId, agentIds } = await setupSession(t);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
    );
    expect(r.status).toBe(401);
  });

  it('rejects request with wrong bearer token (401)', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
      { headers: authHeaders('wrong') },
    );
    expect(r.status).toBe(401);
  });

  it('accepts the configured token', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      { content: 'hi' },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
  });
});

describe('POST /internal/.../send-message', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('writes the message to self target + distributes to other agents (not the sender)', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      { content: 'hello team' },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.message_id).toBe('string');

    // Sender (alice) is excluded; bob gets the delivery.
    expect(t.fake.delivered.map(d => d.agentId)).toEqual([agentIds.bob]);
    expect(t.fake.delivered[0]!.sessionId).toBe(sessionId);

    const msgs = await (
      await http(t.app).get(`/api/sessions/${sessionId}/messages`)
    ).json() as any;
    const inserted = msgs.messages.find((m: any) => m.id === body.message_id);
    expect(inserted.from_kind).toBe('agent');
    expect(inserted.from_agent_id).toBe(agentIds.alice);
    expect(inserted.content).toBe('hello team');
  });

  it('rejects parent target when current session has no parent', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      { content: 'up', target: 'parent' },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.code).toBe('target_unreachable');
  });

  it('rejects child target that is not a direct child', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice']);
    // Make a sibling (not a child) session
    const sibling = await (
      await http(t.app).post(`/api/channels/${(await getChannelOf(t, sessionId))}/sessions`, {
        title: 'sibling',
      })
    ).json() as any;
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      {
        content: 'down',
        target: { child_session_id: sibling.session.id },
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
  });

  it('writes to a real child session via { child_session_id }', async () => {
    t = buildTestApp();
    const { sessionId, agentIds, channelId } = await setupSession(t, ['alice']);
    const child = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'child',
        parent_session_id: sessionId,
        context_summary: 'x',
      })
    ).json() as any;
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/send-message`,
      {
        content: 'down to child',
        target: { child_session_id: child.session.id },
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const childMsgs = await (
      await http(t.app).get(`/api/sessions/${child.session.id}/messages`)
    ).json() as any;
    expect(
      childMsgs.messages.some(
        (m: any) => m.from_kind === 'agent' && m.content === 'down to child',
      ),
    ).toBe(true);
  });
});

describe('POST /internal/.../spawn-child', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects members that are not in the parent channel (400)', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice']);
    const outsider = await (
      await http(t.app).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
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

  it('creates a child session, seeds 2 messages (system + agent prompt)', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
      {
        title: 'investigate',
        members: [agentIds.bob],
        context_summary: 'looking at perf',
        initial_prompt: 'profile the hot path',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.child_session_id).toBe('string');

    const msgs = await (
      await http(t.app).get(`/api/sessions/${body.child_session_id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('looking at perf');
    expect(msgs.messages[1].from_kind).toBe('agent');
    expect(msgs.messages[1].from_agent_id).toBe(agentIds.alice);
    expect(msgs.messages[1].content).toBe('profile the hot path');

    // bob is the only member
    const childAgents = await (
      await http(t.app).get(`/api/sessions/${body.child_session_id}/agents`)
    ).json() as any;
    expect(childAgents.agents.map((a: any) => a.agent_id)).toEqual([agentIds.bob]);
  });

  it('surfaces concurrent_limit as 429', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice']);
    t.ctx.serverConfig = {
      ...t.ctx.serverConfig,
      child_sessions: {
        max_concurrent_per_parent: 1,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };

    const ok = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
      {
        title: 'c1',
        members: [agentIds.alice],
        context_summary: 'x',
        initial_prompt: 'go',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(ok.status).toBe(200);

    const second = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
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

describe('POST /internal/.../create-session', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creates a top-level session in the current channel with all channel members', async () => {
    t = buildTestApp();
    const { sessionId, channelId, agentIds } = await setupSession(t, ['alice', 'bob']);
    const outsider = await (
      await http(t.app).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    t.fake.starts = [];
    t.fake.delivered = [];

    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/create-session`,
      {
        title: 'release signing',
        context_summary: 'user explicitly asked to split release signing out',
        initial_prompt: 'Discuss release signing separately.',
        channel_id: 'other-channel',
        members: [outsider.agent.id],
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(typeof body.session_id).toBe('string');
    expect(Object.keys(body)).toEqual(['session_id']);

    const created = await (
      await http(t.app).get(`/api/sessions/${body.session_id}`)
    ).json() as any;
    expect(created.session.parent_session_id).toBeNull();
    expect(created.session.channel_id).toBe(channelId);
    expect(created.session.spawned_by_agent_id).toBe(agentIds.alice);

    const sessionAgents = await (
      await http(t.app).get(`/api/sessions/${body.session_id}/agents`)
    ).json() as any;
    expect(sessionAgents.agents.map((a: any) => a.agent_id).sort()).toEqual([
      agentIds.alice,
      agentIds.bob,
    ].sort());
    expect(
      sessionAgents.agents.map((a: any) => a.agent_id),
    ).not.toContain(outsider.agent.id);

    const msgs = await (
      await http(t.app).get(`/api/sessions/${body.session_id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(2);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('release signing out');
    expect(msgs.messages[1].from_kind).toBe('agent');
    expect(msgs.messages[1].from_agent_id).toBe(agentIds.alice);
    expect(msgs.messages[1].content).toBe('Discuss release signing separately.');

    expect(t.fake.delivered).toEqual([
      {
        sessionId: body.session_id,
        agentId: agentIds.bob,
        messageId: msgs.messages[1].id,
      },
    ]);
    expect(t.fake.starts).toEqual([
      { sessionId: body.session_id, agentId: agentIds.bob },
    ]);
  });

  it('creates a top-level sibling when invoked from a child session', async () => {
    t = buildTestApp();
    const { sessionId, channelId, agentIds } = await setupSession(t, ['alice']);
    const child = await (
      await http(t.app).post(
        `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
        {
          title: 'thread',
          members: [agentIds.alice],
          context_summary: 'x',
          initial_prompt: 'go',
        },
        { headers: authHeaders(t.authToken) },
      )
    ).json() as any;

    const r = await http(t.app).post(
      `/internal/sessions/${child.child_session_id}/agents/${agentIds.alice}/create-session`,
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
      await http(t.app).get(`/api/sessions/${body.session_id}`)
    ).json() as any;
    expect(created.session.channel_id).toBe(channelId);
    expect(created.session.parent_session_id).toBeNull();
  });

  it('requires an initial_prompt', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice']);
    const r = await http(t.app).post(
      `/internal/sessions/${sessionId}/agents/${agentIds.alice}/create-session`,
      {
        title: 'missing prompt',
        context_summary: 'x',
      },
      { headers: authHeaders(t.authToken) },
    );
    expect(r.status).toBe(400);
  });
});

describe('POST /internal/.../close', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('child agent close posts summary to parent + tells SessionManager.stop for every member', async () => {
    t = buildTestApp();
    const { sessionId, agentIds } = await setupSession(t, ['alice', 'bob']);
    // spawn a child via the internal route
    const child = await (
      await http(t.app).post(
        `/internal/sessions/${sessionId}/agents/${agentIds.alice}/spawn-child`,
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
    const unsub = t.ctx.events.subscribe(sessionId, e => events.push(e));

    const close = await http(t.app).post(
      `/internal/sessions/${child.child_session_id}/agents/${agentIds.bob}/close`,
      { summary: 'done' },
      { headers: authHeaders(t.authToken) },
    );
    unsub();
    expect(close.status).toBe(200);

    // Parent got an auto-summary system message
    const parentMsgs = await (
      await http(t.app).get(`/api/sessions/${sessionId}/messages`)
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
        s => s.sessionId === child.child_session_id && s.agentId === agentIds.bob,
      ),
    ).toBe(true);

    const threadUpdated = events.find(e => e.kind === 'thread_updated')?.payload as any;
    expect(threadUpdated).toMatchObject({
      parent_session_id: sessionId,
      child_session_id: child.child_session_id,
    });
  });
});

async function getChannelOf(t: TestApp, sessionId: string): Promise<string> {
  const s = await (await http(t.app).get(`/api/sessions/${sessionId}`)).json() as any;
  return s.session.channel_id;
}
