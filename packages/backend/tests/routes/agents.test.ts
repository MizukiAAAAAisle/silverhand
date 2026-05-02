import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('POST /api/agents', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects invalid name (returns 400 with zod issues)', async () => {
    t = buildTestApp();
    const res = await http(t.app).post('/api/agents', {
      name: 'has spaces',
      runtime: 'claude',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('creates an agent + auto-DM channel + onboarding session, fans out to SessionManager', async () => {
    t = buildTestApp();
    const res = await http(t.app).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.agent.name).toBe('alice');
    expect(body.agent.host_id).toBeTypeOf('string');
    expect(typeof body.dm_channel_id).toBe('string');

    // auto-DM channel exists with kind=dm
    const channels = await (await http(t.app).get('/api/channels')).json() as any;
    const dm = channels.channels.find((c: any) => c.id === body.dm_channel_id);
    expect(dm.kind).toBe('dm');
    expect(dm.dm_agent_id).toBe(body.agent.id);
    expect(dm.name).toBe('dm-alice');

    // provision should have spawned the onboarding session for the DM
    expect(t.fake.starts).toHaveLength(1);
    expect(t.fake.starts[0]!.agentId).toBe(body.agent.id);
    expect(t.fake.delivered).toHaveLength(1);
    expect(t.fake.delivered[0]!.agentId).toBe(body.agent.id);
  });

  it('returns 409 on duplicate name', async () => {
    t = buildTestApp();
    await http(t.app).post('/api/agents', { name: 'bob', runtime: 'claude' });
    const dup = await http(t.app).post('/api/agents', {
      name: 'bob',
      runtime: 'claude',
    });
    expect(dup.status).toBe(409);
  });
});

describe('GET/DELETE /api/agents', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('GET lists agents in created_at order', async () => {
    t = buildTestApp();
    await http(t.app).post('/api/agents', { name: 'a', runtime: 'claude' });
    await http(t.app).post('/api/agents', { name: 'b', runtime: 'claude' });
    const list = await (await http(t.app).get('/api/agents')).json() as any;
    expect(list.agents.map((a: any) => a.name)).toEqual(['a', 'b']);
  });

  it('DELETE without confirm flag is rejected (400)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'tmp', runtime: 'claude' })
    ).json() as any;
    const del = await http(t.app).del(`/api/agents/${created.agent.id}`);
    expect(del.status).toBe(400);
    // agent still present
    const get = await http(t.app).get(`/api/agents/${created.agent.id}`);
    expect(get.status).toBe(200);
  });

  it('DELETE on unknown id returns 204 (idempotent)', async () => {
    t = buildTestApp();
    const del = await http(t.app).del(`/api/agents/does-not-exist`);
    expect(del.status).toBe(204);
  });
});

describe('GET /api/agents/:id', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('returns the full DTO including display_name + reasoning_effort defaults', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'codex' })
    ).json() as any;
    const got = await (await http(t.app).get(`/api/agents/${created.agent.id}`)).json() as any;
    expect(got.agent.display_name).toBe('alice');
    expect(got.agent.reasoning_effort).toBeNull();
    expect(got.agent.runtime).toBe('codex');
  });

  it('404 on unknown id', async () => {
    t = buildTestApp();
    const res = await http(t.app).get('/api/agents/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/agents/:id', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('updates display_name + model; leaves untouched fields alone', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', {
        name: 'alice',
        runtime: 'claude',
        model: 'sonnet',
      })
    ).json() as any;
    const patched = await (
      await http(t.app).patch(`/api/agents/${created.agent.id}`, {
        display_name: 'Alice (reviewer)',
        model: 'opus',
      })
    ).json() as any;
    expect(patched.agent.display_name).toBe('Alice (reviewer)');
    expect(patched.agent.model).toBe('opus');
    expect(patched.agent.runtime).toBe('claude');
    expect(patched.agent.name).toBe('alice'); // immutable
  });

  it('400 on empty body (refines noop)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t.app).patch(`/api/agents/${created.agent.id}`, {});
    expect(res.status).toBe(400);
  });

  it('rejects runtime change while a session_agent is starting/active (409)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // Provisioning auto-starts the DM onboarding session — force a
    // running status row by writing to session_agents directly so the
    // test doesn't depend on a real spawn.
    const dmId = created.dm_channel_id;
    const dmSessions = t.ctx.db
      .prepare(`SELECT id FROM sessions WHERE channel_id = ?`)
      .all(dmId) as { id: string }[];
    expect(dmSessions.length).toBe(1);
    t.ctx.db
      .prepare(
        `UPDATE session_agents SET status = 'active'
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(dmSessions[0]!.id, created.agent.id);

    const res = await http(t.app).patch(`/api/agents/${created.agent.id}`, {
      runtime: 'codex',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('agent_busy_change_runtime');
  });

  it('allows runtime change when nothing is running', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t.app).patch(`/api/agents/${created.agent.id}`, {
      runtime: 'codex',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agent.runtime).toBe('codex');
  });
});

describe('GET /api/agents/:id/workspace', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('returns L1 path + seeded system_prompt + memory previews', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await (
      await http(t.app).get(`/api/agents/${created.agent.id}/workspace`)
    ).json() as any;
    expect(res.workspace.l1_path).toContain(created.agent.id);
    expect(res.workspace.system_prompt).not.toBeNull();
    expect(res.workspace.memory).not.toBeNull();
    expect(res.workspace.system_prompt.content).toContain('Global role');
    expect(res.workspace.memory.content).toContain('Global memory');
    expect(Array.isArray(res.workspace.notes)).toBe(true);
  });
});

describe('GET /api/agents/:id/runtime-state', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('lists every session_agent for the agent with channel/session names denormalized', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await (
      await http(t.app).get(`/api/agents/${created.agent.id}/runtime-state`)
    ).json() as any;
    expect(Array.isArray(res.session_agents)).toBe(true);
    expect(res.session_agents.length).toBeGreaterThan(0);
    const dm = res.session_agents.find((s: any) => s.channel_kind === 'dm');
    expect(dm.channel_name).toBe('dm-alice');
    expect(dm.session_title).toBe('Onboarding');
    expect(dm.status).toBe('idle'); // FakeSessionManager doesn't flip status
  });
});

describe('POST /api/agents/:id/stop', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('hard-stops every running session_agent for this agent', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // mark the onboarding session_agent as active
    const dmSessions = t.ctx.db
      .prepare(`SELECT id FROM sessions WHERE channel_id = ?`)
      .all(created.dm_channel_id) as { id: string }[];
    t.ctx.db
      .prepare(
        `UPDATE session_agents SET status = 'active'
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(dmSessions[0]!.id, created.agent.id);

    t.fake.stops = [];
    const res = await http(t.app).post(`/api/agents/${created.agent.id}/stop`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.stopped).toBe(1);
    expect(t.fake.stops).toHaveLength(1);
    expect(t.fake.stops[0]!.mode).toBe('hard');
  });

  it('no-op (200, stopped:0) when nothing is running', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fake.stops = [];
    const res = await http(t.app).post(`/api/agents/${created.agent.id}/stop`);
    const body = await res.json() as any;
    expect(body.stopped).toBe(0);
    expect(t.fake.stops).toHaveLength(0);
  });
});

describe('GET /api/agents/:id/delete-impact', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('summarizes DM channel + regular channel membership + l1/l2 paths', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // join alice to a regular channel
    const ch = await (
      await http(t.app).post('/api/channels', {
        name: 'engineering',
        member_agent_ids: [created.agent.id],
      })
    ).json() as any;

    const res = await (
      await http(t.app).get(`/api/agents/${created.agent.id}/delete-impact`)
    ).json() as any;
    expect(res.impact.agent_name).toBe('alice');
    expect(res.impact.dm_channel.name).toBe('dm-alice');
    expect(res.impact.dm_channel.session_count).toBe(1);
    expect(res.impact.regular_channels).toEqual([{ id: ch.channel.id, name: 'engineering' }]);
    expect(res.impact.l1_path).toContain(created.agent.id);
    expect(res.impact.l2_paths).toHaveLength(1);
    expect(res.impact.l2_paths[0]).toContain(created.agent.id);
  });
});

describe('DELETE /api/agents/:id (full flow)', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('hard-stops running, leaves regular channels (broadcast + wipe L2), drops DM, removes agent', async () => {
    t = buildTestApp();
    const created = await (
      await http(t.app).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    await http(t.app).post('/api/channels', {
      name: 'engineering',
      member_agent_ids: [created.agent.id],
    });

    // mark DM session_agent as active so the stop path is exercised
    const dmSessions = t.ctx.db
      .prepare(`SELECT id FROM sessions WHERE channel_id = ?`)
      .all(created.dm_channel_id) as { id: string }[];
    t.ctx.db
      .prepare(
        `UPDATE session_agents SET status = 'active'
         WHERE session_id = ? AND agent_id = ?`,
      )
      .run(dmSessions[0]!.id, created.agent.id);

    t.fake.stops = [];
    const del = await http(t.app).del(
      `/api/agents/${created.agent.id}`,
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) },
    );
    expect(del.status).toBe(204);

    // agent gone
    const get = await http(t.app).get(`/api/agents/${created.agent.id}`);
    expect(get.status).toBe(404);

    // DM channel gone
    const channels = await (await http(t.app).get('/api/channels')).json() as any;
    expect(channels.channels.find((c: any) => c.id === created.dm_channel_id)).toBeUndefined();
    // engineering channel still exists (agent was leaved out, channel stays)
    expect(channels.channels.find((c: any) => c.name === 'engineering')).toBeDefined();

    // running session_agent was stopped (hard) — at least one stop call
    expect(t.fake.stops.some(s => s.agentId === created.agent.id && s.mode === 'hard')).toBe(true);
  });
});
