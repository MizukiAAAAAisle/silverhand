import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
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

  it('404 on unknown session for /messages, /agents, /agent-run-states, /children', async () => {
    t = buildTestApp();
    for (const path of ['messages', 'agents', 'agent-run-states', 'children'] as const) {
      const r = await http(t.app).get(`/api/sessions/unknown/${path}`);
      expect(r.status).toBe(404);
    }
  });

  it('returns the latest message window and pages earlier history', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'history', []);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'long chat',
      })
    ).json() as any;

    for (let i = 1; i <= 205; i++) {
      const res = await http(t.app).post(
        `/api/sessions/${session.session.id}/messages`,
        { content: `m${i}` },
      );
      expect(res.status).toBe(201);
    }

    const latest = await (
      await http(t.app).get(`/api/sessions/${session.session.id}/messages`)
    ).json() as any;
    expect(latest.messages).toHaveLength(200);
    expect(latest.messages[0].content).toBe('m6');
    expect(latest.messages[latest.messages.length - 1].content).toBe('m205');
    expect(latest.has_more_before).toBe(true);

    const earlier = await (
      await http(t.app).get(
        `/api/sessions/${session.session.id}/messages?before_seq=${latest.messages[0].seq}&limit=3`,
      )
    ).json() as any;
    expect(earlier.messages.map((m: any) => m.content)).toEqual([
      'm3',
      'm4',
      'm5',
    ]);
    expect(earlier.has_more_before).toBe(true);

    const oldest = await (
      await http(t.app).get(
        `/api/sessions/${session.session.id}/messages?before_seq=${earlier.messages[0].seq}&limit=3`,
      )
    ).json() as any;
    expect(oldest.messages.map((m: any) => m.content)).toEqual(['m1', 'm2']);
    expect(oldest.has_more_before).toBe(false);
  });

  it('returns current ephemeral agent run states for the session', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'runstate', ['alice']);
    const created = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'work',
        member_agent_ids: agentIds,
      })
    ).json() as any;

    t.fake.agentRunStates = [
      {
        runId: 'run-1',
        agentId: agentIds[0]!,
        sessionId: created.session.id,
        status: 'thinking',
        startedAt: 100,
        updatedAt: 120,
        lastActivityAt: 110,
      },
      {
        runId: 'other',
        agentId: agentIds[0]!,
        sessionId: 'different-session',
        status: 'thinking',
        startedAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      },
    ];

    const body = await (
      await http(t.app).get(
        `/api/sessions/${created.session.id}/agent-run-states`,
      )
    ).json() as any;
    expect(body.states).toEqual([t.fake.agentRunStates[0]]);
  });
});

describe('GET /api/search', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('searches channel names, session titles, regular messages, and DM messages', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'needle_channel', [
      'alice',
    ]);
    const regular = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'needle planning',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    await http(t.app).post(`/api/sessions/${regular.session.id}/messages`, {
      content: 'regular needle message',
    });

    const channels = await (
      await http(t.app).get('/api/channels')
    ).json() as any;
    const dm = channels.channels.find(
      (c: any) => c.kind === 'dm' && c.dm_agent_id === agentIds[0],
    );
    expect(dm).toBeDefined();
    const dmSessions = await (
      await http(t.app).get(`/api/channels/${dm.id}/sessions`)
    ).json() as any;
    await http(t.app).post(`/api/sessions/${dmSessions.sessions[0].id}/messages`, {
      content: 'dm needle message',
    });

    const body = await (
      await http(t.app).get('/api/search?q=needle&limit=20')
    ).json() as any;

    expect(
      body.results.some(
        (r: any) => r.type === 'channel' && r.channel.id === channelId,
      ),
    ).toBe(true);
    expect(
      body.results.some(
        (r: any) => r.type === 'session' && r.session.id === regular.session.id,
      ),
    ).toBe(true);
    expect(
      body.results.some(
        (r: any) =>
          r.type === 'message' &&
          r.channel.kind === 'regular' &&
          r.message.content === 'regular needle message',
      ),
    ).toBe(true);
    expect(
      body.results.some(
        (r: any) =>
          r.type === 'message' &&
          r.channel.kind === 'dm' &&
          r.message.content === 'dm needle message',
      ),
    ).toBe(true);
  });

  it('filters message search by author, channel kind, channel id, and time', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'filter_channel', [
      'alice',
    ]);
    const regular = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'regular',
        member_agent_ids: agentIds,
      })
    ).json() as any;

    const channels = await (
      await http(t.app).get('/api/channels')
    ).json() as any;
    const dm = channels.channels.find(
      (c: any) => c.kind === 'dm' && c.dm_agent_id === agentIds[0],
    );
    const dmSessions = await (
      await http(t.app).get(`/api/channels/${dm.id}/sessions`)
    ).json() as any;

    const messages = new MessageRepo(t.ctx.db);
    const userMsg = messages.insert({
      sessionId: regular.session.id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'filter user target',
    });
    const agentMsg = messages.insert({
      sessionId: regular.session.id,
      fromKind: 'agent',
      fromAgentId: agentIds[0],
      content: 'filter agent target',
    });
    const dmMsg = messages.insert({
      sessionId: dmSessions.sessions[0].id,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'filter dm target',
    });
    t.ctx.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(1_000, userMsg.id);
    t.ctx.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(2_500, agentMsg.id);
    t.ctx.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run(3_000, dmMsg.id);

    const userOnly = await (
      await http(t.app).get('/api/search?q=filter&user_id=local')
    ).json() as any;
    expect(userOnly.results.every((r: any) => r.message.from_kind === 'user')).toBe(
      true,
    );
    expect(userOnly.results.some((r: any) => r.message.id === agentMsg.id)).toBe(
      false,
    );

    const agentOnly = await (
      await http(t.app).get(`/api/search?q=filter&agent_id=${agentIds[0]}`)
    ).json() as any;
    expect(agentOnly.results.map((r: any) => r.message.id)).toEqual([
      agentMsg.id,
    ]);

    const dmOnly = await (
      await http(t.app).get('/api/search?q=filter&scope=dm')
    ).json() as any;
    expect(dmOnly.results.every((r: any) => r.channel.kind === 'dm')).toBe(true);

    const channelOnly = await (
      await http(t.app).get(`/api/search?q=filter&channel_id=${channelId}`)
    ).json() as any;
    expect(
      channelOnly.results
        .filter((r: any) => r.type === 'message')
        .every((r: any) => r.channel.id === channelId),
    ).toBe(true);

    const timeWindow = await (
      await http(t.app).get('/api/search?q=filter&from=2000&to=2600')
    ).json() as any;
    expect(timeWindow.results.map((r: any) => r.message.id)).toEqual([
      agentMsg.id,
    ]);
  });

  it('rejects conflicting user and agent filters', async () => {
    t = buildTestApp();
    const r = await http(t.app).get('/api/search?q=x&user_id=local&agent_id=a1');
    expect(r.status).toBe(400);
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
    const events: { kind: string; payload: unknown }[] = [];
    const unsub = t.ctx.events.subscribe(parent.session.id, e => events.push(e));

    const close = await http(t.app).post(
      `/api/sessions/${child.session.id}/close`,
      { summary: 'fixed in PR #99' },
    );
    unsub();
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

    const threadUpdated = events.find(e => e.kind === 'thread_updated')?.payload as any;
    expect(threadUpdated).toMatchObject({
      parent_session_id: parent.session.id,
      child_session_id: child.session.id,
    });
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

describe('message unread routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('requires viewer identity for unread cursor routes', async () => {
    t = buildTestApp();
    const { channelId } = await setupChannel(t, 'unread-auth', []);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
      })
    ).json() as any;

    expect((await http(t.app).get('/api/message-unread-summary')).status).toBe(400);
    expect(
      (await http(t.app).get(`/api/channels/${channelId}/message-unread`)).status,
    ).toBe(400);
    expect(
      (await http(t.app).post(`/api/sessions/${session.session.id}/mark-read`)).status,
    ).toBe(400);
  });

  it('stores viewer id on user messages and clears unread with mark-read', async () => {
    t = buildTestApp();
    const viewer = http(t.app, { 'x-silverhand-user-id': 'local' });
    const { channelId } = await setupChannel(t, 'unread', []);
    const created = await (
      await viewer.post(`/api/channels/${channelId}/sessions`, {
        title: 's',
      })
    ).json() as any;
    const sessionId = created.session.id;

    const own = await (
      await viewer.post(`/api/sessions/${sessionId}/messages`, {
        content: 'mine',
      })
    ).json() as any;
    expect(own.message.from_user_id).toBe('local');

    const { MessageRepo } = await import('../../src/repos/message-repo.js');
    const messages = new MessageRepo(t.ctx.db);
    messages.insert({ sessionId, fromKind: 'user', content: 'legacy mine' });
    messages.insert({
      sessionId,
      fromKind: 'user',
      fromUserId: 'alice',
      content: 'other human',
    });
    messages.insert({ sessionId, fromKind: 'agent', content: 'agent' });
    messages.insert({ sessionId, fromKind: 'system', content: 'system' });

    let perSession = await (
      await viewer.get(`/api/channels/${channelId}/message-unread`)
    ).json() as any;
    expect(perSession).toEqual({
      by_session: { [sessionId]: 3 },
      total: 3,
    });
    let summary = await (await viewer.get('/api/message-unread-summary')).json() as any;
    expect(summary).toEqual({ by_channel: { [channelId]: 3 } });

    const marked = await (
      await viewer.post(`/api/sessions/${sessionId}/mark-read`)
    ).json() as any;
    expect(marked.last_read_seq).toBe(5);
    perSession = await (
      await viewer.get(`/api/channels/${channelId}/message-unread`)
    ).json() as any;
    expect(perSession).toEqual({ by_session: {}, total: 0 });

    messages.insert({ sessionId, fromKind: 'agent', content: 'new agent' });
    await viewer.post(`/api/sessions/${sessionId}/mark-read`, { seq: 1 });
    perSession = await (
      await viewer.get(`/api/channels/${channelId}/message-unread`)
    ).json() as any;
    expect(perSession).toEqual({
      by_session: { [sessionId]: 1 },
      total: 1,
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

  it('creates message threads with every current parent-session member', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'threads-all', [
      'alice',
      'bob',
    ]);
    const session = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 's',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const viewer = http(t.app, { 'x-silverhand-user-id': 'teammate' });
    const msg = await (
      await viewer.post(`/api/sessions/${session.session.id}/messages`, {
        content: 'topic',
      })
    ).json() as any;

    const created = await (
      await http(t.app).post(`/api/messages/${msg.message.id}/thread`)
    ).json() as any;

    expect(created.child_session_id).toBe(created.session.id);
    expect(created.session.parent_session_id).toBe(session.session.id);

    const childAgents = await (
      await http(t.app).get(`/api/sessions/${created.child_session_id}/agents`)
    ).json() as any;
    expect(childAgents.agents.map((a: any) => a.agent_id).sort()).toEqual(
      [...agentIds].sort(),
    );

    const childMessages = await (
      await http(t.app).get(`/api/sessions/${created.child_session_id}/messages`)
    ).json() as any;
    const anchor = childMessages.messages.find(
      (m: any) => m.metadata?.subtype === 'thread_anchor',
    );
    expect(anchor.metadata).toMatchObject({
      quoted_from_kind: 'user',
      quoted_from_user_id: 'teammate',
    });
    expect(anchor.content).toContain('teammate');
    expect(anchor.content).not.toContain('you');
    const onboarding = childMessages.messages.find(
      (m: any) => m.metadata?.subtype === 'onboarding',
    );
    expect(onboarding.content).toContain('ask the user whether to close it');
    expect(onboarding.content).toContain(
      'Only call `close_session` after the user explicitly confirms',
    );
    expect(onboarding.content).not.toContain('then call `close_session`');
  });

  it('delivers and auto-starts every child-thread member on first user message', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await setupChannel(t, 'threads-start', [
      'alice',
      'bob',
    ]);
    const parent = await (
      await http(t.app).post(`/api/channels/${channelId}/sessions`, {
        title: 'parent',
        member_agent_ids: agentIds,
      })
    ).json() as any;
    const parentMsg = await (
      await http(t.app).post(`/api/sessions/${parent.session.id}/messages`, {
        content: 'topic',
      })
    ).json() as any;
    const created = await (
      await http(t.app).post(`/api/messages/${parentMsg.message.id}/thread`)
    ).json() as any;

    t.fake.delivered = [];
    t.fake.starts = [];

    const res = await http(t.app).post(
      `/api/sessions/${created.child_session_id}/messages`,
      { content: 'continue in child' },
    );
    expect(res.status).toBe(201);

    expect(
      t.fake.delivered.every(d => d.sessionId === created.child_session_id),
    ).toBe(true);
    expect(t.fake.delivered.map(d => d.agentId).sort()).toEqual(
      [...agentIds].sort(),
    );
    expect(
      t.fake.starts.every(s => s.sessionId === created.child_session_id),
    ).toBe(true);
    expect(t.fake.starts.map(s => s.agentId).sort()).toEqual(
      [...agentIds].sort(),
    );
  });
});
