import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function setupChannel(
  t: TestApp,
  channelName = 'eng',
  memberNames: string[] = ['alice', 'bob'],
): Promise<{ channelId: string; agentIds: string[] }> {
  const agentIds: string[] = [];
  for (const name of memberNames) {
    const r = await http(t.app).post('/api/agents', { name, runtime: 'claude' });
    const body = await r.json() as any;
    agentIds.push(body.agent.id);
  }
  const ch = await (
    await http(t.app).post('/api/channels', {
      name: channelName,
      member_agent_ids: agentIds,
    })
  ).json() as any;
  // Reset spawn sinks so per-test assertions only see session-level work.
  t.fake.starts = [];
  t.fake.delivered = [];
  t.fake.stops = [];
  return { channelId: ch.channel.id, agentIds };
}

describe('POST /api/channels/:id/sessions', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns 404 for unknown channel', async () => {
    t = buildTestApp();
    const r = await http(t.app).post('/api/channels/unknown/sessions', {
      title: 'x',
    });
    expect(r.status).toBe(404);
  });

  it('rejects member_agent_ids that are not channel members (400)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'a', ['alice']);
    // create a second agent NOT in the channel
    const outsider = await (
      await http(t.app).post('/api/agents', { name: 'outsider', runtime: 'claude' })
    ).json() as any;
    const r = await http(t.app).post(`/api/channels/${channelId}/sessions`, {
      title: 'no-go',
      member_agent_ids: [outsider.agent.id],
    });
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.error).toMatch(/not a member/);
  });

  it('requires context_summary when parent_session_id is set', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'b');
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'parent',
      })
    ).json() as any;
    const r = await http(t.app).post(`/api/channels/${channelId}/sessions`, {
      title: 'child',
      parent_session_id: parent.session.id,
    });
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.error).toMatch(/context_summary is required/);
  });

  it('writes a parent-context system message into the new child session', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'c');
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'parent',
      })
    ).json() as any;
    const child = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'child',
        parent_session_id: parent.session.id,
        context_summary: 'inherited:foo',
      })
    ).json() as any;
    const msgs = await (
      await http(t.app).get(`/api/sessions/${child.session.id}/messages`)
    ).json() as any;
    expect(msgs.messages).toHaveLength(1);
    expect(msgs.messages[0].from_kind).toBe('system');
    expect(msgs.messages[0].content).toContain('inherited:foo');
    expect(msgs.messages[0].content).toContain("'parent'");
  });

  it('child-session limits surface as 429 (concurrent_limit)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'd');
    // Override config: max 1 concurrent child per parent
    t.ctx.serverConfig = {
      ...t.ctx.serverConfig,
      child_sessions: {
        max_concurrent_per_parent: 1,
        spawn_cooldown_seconds: null,
        max_depth: 1,
      },
    };

    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'p',
      })
    ).json() as any;
    const c1 = await http(t.app).post(`/api/channels/${channelId}/sessions`, {
      title: 'c1',
      parent_session_id: parent.session.id,
      context_summary: 'x',
    });
    expect(c1.status).toBe(201);
    const c2 = await http(t.app).post(`/api/channels/${channelId}/sessions`, {
      title: 'c2',
      parent_session_id: parent.session.id,
      context_summary: 'x',
    });
    expect(c2.status).toBe(429);
    const body = await c2.json() as any;
    expect(body.code).toBe('concurrent_limit');
  });
});

describe('GET /api/sessions/:id/...', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('404 on unknown session for /messages, /agents, /children', async () => {
    t = buildTestApp();
    for (const path of ['messages', 'agents', 'children'] as const) {
      const r = await http(t.app).get(`/api/sessions/unknown/${path}`);
      expect(r.status).toBe(404);
    }
  });
});

describe('POST /api/sessions/:id/close', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('409 when session has active children', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'e');
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'p',
      })
    ).json() as any;
    await http(t.app).post(`/api/channels/${channelId}/sessions`, {
      title: 'c',
      parent_session_id: parent.session.id,
      context_summary: 'x',
    });
    const r = await http(t.app).post(`/api/sessions/${parent.session.id}/close`, {
      summary: 'wrap',
    });
    expect(r.status).toBe(409);
    const body = await r.json() as any;
    expect(body.code).toBe('has_active_children');
  });

  it('closes idempotently — second call → 409 already closed', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'f');
    const s = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'top',
      })
    ).json() as any;

    const close1 = await http(t.app).post(
      `/api/sessions/${s.session.id}/close`,
      { summary: 'done' },
    );
    expect(close1.status).toBe(200);
    const body = await close1.json() as any;
    expect(body.session.status).toBe('archived');
    expect(body.session.close_summary).toBe('done');

    const close2 = await http(t.app).post(
      `/api/sessions/${s.session.id}/close`,
      { summary: 'redo' },
    );
    expect(close2.status).toBe(409);
  });

  it('child close auto-posts a summary system message into parent (when posted_to_parent omitted)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'g');
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'p',
      })
    ).json() as any;
    const child = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'investigate-bug',
        parent_session_id: parent.session.id,
        context_summary: 'looking at bug 42',
      })
    ).json() as any;

    const close = await http(t.app).post(
      `/api/sessions/${child.session.id}/close`,
      { summary: 'fixed in PR #99' },
    );
    expect(close.status).toBe(200);

    const parentMsgs = await (
      await http(t.app).get(`/api/sessions/${parent.session.id}/messages`)
    ).json() as any;
    const summaryMsg = parentMsgs.messages.find(
      (m: any) =>
        m.from_kind === 'system' && m.content.includes('investigate-bug'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg.content).toContain('fixed in PR #99');
  });

  it('does NOT post to parent when posted_to_parent=true (agent already did)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'h');
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'p',
      })
    ).json() as any;
    const child = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'c',
        parent_session_id: parent.session.id,
        context_summary: 'x',
      })
    ).json() as any;

    const before = await (
      await http(t.app).get(`/api/sessions/${parent.session.id}/messages`)
    ).json() as any;
    await http(t.app).post(`/api/sessions/${child.session.id}/close`, {
      summary: 's',
      posted_to_parent: true,
    });
    const after = await (
      await http(t.app).get(`/api/sessions/${parent.session.id}/messages`)
    ).json() as any;
    expect(after.messages.length).toBe(before.messages.length);
  });
});

describe('POST /api/sessions/:id/messages (human compose)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('inserts a user message + distributes to every session agent', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'm', ['alice', 'bob']);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    t.fake.delivered = [];
    t.fake.starts = [];

    const res = await http(t.app).post(
      `/api/sessions/${session.session.id}/messages`,
      { content: 'hi from human' },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.message.from_kind).toBe('user');
    expect(body.message.content).toBe('hi from human');

    // delivered to every member, no excludeAgent (sender is human)
    expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
      [...agentIds].sort(),
    );

    // every idle agent was auto-started before delivery (so the message
    // doesn't sit in the inbox until someone manually clicks Play).
    expect(t.fake.starts.map(s => s.agentId).sort()).toEqual(
      [...agentIds].sort(),
    );

    const list = await (
      await http(t.app).get(`/api/sessions/${session.session.id}/messages`)
    ).json() as any;
    expect(list.messages.some((m: any) => m.id === body.message.id)).toBe(true);
  });

  it('rejects empty content (400)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'mm');
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
      })
    ).json() as any;
    const r = await http(t.app).post(
      `/api/sessions/${session.session.id}/messages`,
      { content: '' },
    );
    expect(r.status).toBe(400);
  });

  it('rejects post to closed session (409)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'mmm');
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
      })
    ).json() as any;
    await http(t.app).post(`/api/sessions/${session.session.id}/close`, {
      summary: 'done',
    });
    const r = await http(t.app).post(
      `/api/sessions/${session.session.id}/messages`,
      { content: 'too late' },
    );
    expect(r.status).toBe(409);
  });

  it('404 for unknown session', async () => {
    t = buildTestApp();
    const r = await http(t.app).post(
      `/api/sessions/unknown/messages`,
      { content: 'x' },
    );
    expect(r.status).toBe(404);
  });
});

describe('POST /api/sessions/:id/agents/:aid/start', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects an agent that is not a channel member (400)', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'i', ['alice']);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
      })
    ).json() as any;
    const outsider = await (
      await http(t.app).post('/api/agents', { name: 'mallory', runtime: 'claude' })
    ).json() as any;
    const r = await http(t.app).post(
      `/api/sessions/${session.session.id}/agents/${outsider.agent.id}/start`,
    );
    expect(r.status).toBe(400);
  });

  it('delegates to SessionManager.start when valid', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'j', ['alice']);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const r = await http(t.app).post(
      `/api/sessions/${session.session.id}/agents/${agentIds[0]}/start`,
    );
    expect(r.status).toBe(200);
    expect(t.fake.starts.find(s => s.agentId === agentIds[0])).toBeDefined();
  });

  it('surfaces SessionManager errors as 400', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'k', ['alice']);
    t.fake.startError = new Error('runtime claude not installed');
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const r = await http(t.app).post(
      `/api/sessions/${session.session.id}/agents/${agentIds[0]}/start`,
    );
    expect(r.status).toBe(400);
    const body = await r.json() as any;
    expect(body.error).toMatch(/runtime claude not installed/);
  });
});

describe('POST /api/sessions/:id/agents/:aid/stop', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('defaults to hard mode; passes soft + directive through', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'l', ['alice']);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;

    await http(t.app).post(
      `/api/sessions/${session.session.id}/agents/${agentIds[0]}/stop`,
    );
    expect(t.fake.stops.at(-1)).toMatchObject({
      sessionId: session.session.id,
      agentId: agentIds[0],
      mode: 'hard',
    });

    await http(t.app).post(
      `/api/sessions/${session.session.id}/agents/${agentIds[0]}/stop`,
      { mode: 'soft', directive: 'pause please' },
    );
    expect(t.fake.stops.at(-1)).toMatchObject({
      mode: 'soft',
      directive: 'pause please',
    });
  });
});

describe('GET /api/sessions/:id/threads', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns 404 for unknown session', async () => {
    t = buildTestApp();
    const r = await http(t.app).get('/api/sessions/nope/threads');
    expect(r.status).toBe(404);
  });

  it('returns one entry per open thread with anchor + reply count', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'eng', ['alice']);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const sessionId = session.session.id;

    // Empty parent → empty threads
    let r = await http(t.app).get(`/api/sessions/${sessionId}/threads`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).threads).toEqual([]);

    // Post two parent messages, start a thread on the first
    const m1 = await (
      await http(t.app).post(`/api/sessions/${sessionId}/messages`, {
        content: 'topic A',
      })
    ).json() as any;
    const m2 = await (
      await http(t.app).post(`/api/sessions/${sessionId}/messages`, {
        content: 'topic B',
      })
    ).json() as any;

    const thread = await (
      await http(t.app).post(`/api/messages/${m1.message.id}/thread`)
    ).json() as any;
    const childId = thread.child_session_id;

    // Thread exists but has 0 user/agent replies (only seed system msgs)
    r = await http(t.app).get(`/api/sessions/${sessionId}/threads`);
    let body = (await r.json()) as any;
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]).toMatchObject({
      child_session_id: childId,
      anchor_message_id: m1.message.id,
      reply_count: 0,
    });

    // Two replies (user messages count, system messages don't)
    await http(t.app).post(`/api/sessions/${childId}/messages`, { content: 'x' });
    await http(t.app).post(`/api/sessions/${childId}/messages`, { content: 'y' });
    r = await http(t.app).get(`/api/sessions/${sessionId}/threads`);
    body = (await r.json()) as any;
    expect(body.threads[0].reply_count).toBe(2);

    // Second parent message has no thread → still one entry total
    expect(body.threads.find((s: any) => s.anchor_message_id === m2.message.id)).toBeUndefined();
  });
});
