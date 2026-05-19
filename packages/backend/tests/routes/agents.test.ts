import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('POST /api/agents', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects invalid name (returns 400 with zod issues)', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/agents', {
      name: 'has spaces',
      runtime: 'claude',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid input');
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('creates an agent + auto-DM channel + onboarding session, fans out to ConversationManager', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.agent.name).toBe('alice');
    expect(body.agent.host_id).toBeTypeOf('string');
    expect(typeof body.dm_channel_id).toBe('string');

    // auto-DM channel exists as a canonical dm_channel conversation.
    const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
    const home = workspaces.workspaces.find(
      (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === body.agent.id,
    );
    expect(home).toBeDefined();
    expect(home.dm_channel_id).toBe(body.dm_channel_id);
    const channels = await (
      await http(t).get(`/api/workspaces/${home.id}/channels`)
    ).json() as any;
    const dm = channels.channels.find((c: any) => c.id === body.dm_channel_id);
    expect(dm.kind).toBe('dm_channel');
    expect(dm.title).toBe('Onboarding');
    expect(dm.workspace_path).toContain(body.agent.id);

    // provision should have spawned the onboarding session for the DM
    expect(t.fake.starts).toHaveLength(1);
    expect(t.fake.starts[0]!.agentId).toBe(body.agent.id);
    expect(t.fake.delivered).toHaveLength(1);
    expect(t.fake.delivered[0]!.agentId).toBe(body.agent.id);

    const msgs = await (
      await http(t).get(`/api/channels/${body.dm_channel_id}/messages`)
    ).json() as any;
    const onboarding = msgs.messages.find((m: any) => m.metadata?.subtype === 'onboarding');
    // DM onboarding: we now teach the agent that this DM is the only place
    // where its global identity (L1 system_prompt.md) lives, and that role
    // updates here propagate to every workspace.
    expect(onboarding.content).toContain('your personal DM');
    expect(onboarding.content).toContain('global identity');
    expect(onboarding.content).toContain('L1 `system_prompt.md`');
    expect(onboarding.content).toContain('Do not mention internal file paths');
  });

  it('returns 409 on duplicate name', async () => {
    t = buildTestApp();
    await http(t).post('/api/agents', { name: 'bob', runtime: 'claude' });
    const dup = await http(t).post('/api/agents', {
      name: 'bob',
      runtime: 'claude',
    });
    expect(dup.status).toBe(409);
  });

  it('writes human membership for the creator (not the global viewer) on agent_home + DM (v25 PR-A blocker fix)', async () => {
    // Regression for PR-A blocker #4: createAgentWithHome used
    // settings.getViewerUserId() instead of the principal that drove
    // the route. With v25 permission tightening, multi-human v2 would
    // see the *global* viewer as agent_home owner instead of the human
    // who clicked "create agent". Drop the test-fixture autoseed so
    // we can observe the membership writes deterministically.
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    // Fixture seeds 'local' as global viewer; have 'teammate' (a
    // different fixture user) drive the route via principal header.
    const created = await http(t).post('/api/agents', { name: 'creator-test', runtime: 'claude' }, {
      headers: {
        [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
      },
    });
    expect(created.status).toBe(201);
    const body = await created.json() as any;

    // workspace_users for the new agent_home should contain
    // 'teammate' (the creator), not 'local' (the global viewer).
    const homeMembers = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM workspace_users
           WHERE workspace_id = (
             SELECT id FROM workspaces WHERE owner_agent_id = ?
           )`,
      )
      .all(body.agent.id)
      .map(r => r.user_id);
    expect(homeMembers).toEqual(['teammate']);

    // conversation_users for the onboarding DM should also contain
    // only the creator.
    const dmMembers = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
      )
      .all(body.dm_channel_id)
      .map(r => r.user_id);
    expect(dmMembers).toEqual(['teammate']);
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
    await http(t).post('/api/agents', { name: 'a', runtime: 'claude' });
    await http(t).post('/api/agents', { name: 'b', runtime: 'claude' });
    const list = await (await http(t).get('/api/agents')).json() as any;
    expect(list.agents.map((a: any) => a.name)).toEqual(['a', 'b']);
  });

  it('DELETE without confirm flag is rejected (400)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'tmp', runtime: 'claude' })
    ).json() as any;
    const del = await http(t).del(`/api/agents/${created.agent.id}`);
    expect(del.status).toBe(400);
    // agent still present
    const get = await http(t).get(`/api/agents/${created.agent.id}`);
    expect(get.status).toBe(200);
  });

  it('DELETE on unknown id returns 204 (idempotent)', async () => {
    t = buildTestApp();
    const del = await http(t).del(`/api/agents/does-not-exist`);
    expect(del.status).toBe(204);
  });
});

describe('GET /api/agents/:id', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('returns the full DTO including display_name + reasoning_effort defaults', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'codex' })
    ).json() as any;
    const got = await (await http(t).get(`/api/agents/${created.agent.id}`)).json() as any;
    expect(got.agent.display_name).toBe('alice');
    expect(got.agent.reasoning_effort).toBeNull();
    expect(got.agent.runtime).toBe('codex');
  });

  it('404 on unknown id', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/does-not-exist');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/agents/:id', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('updates display_name + model; leaves untouched fields alone', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', {
        name: 'alice',
        runtime: 'claude',
        model: 'sonnet',
      })
    ).json() as any;
    const patched = await (
      await http(t).patch(`/api/agents/${created.agent.id}`, {
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
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).patch(`/api/agents/${created.agent.id}`, {});
    expect(res.status).toBe(400);
  });

  it('rejects runtime change while a conversation_agent is starting/active (409)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // Provisioning auto-starts the DM onboarding channel — force a
    // running status row by writing to conversation_agents directly so the
    // test doesn't depend on a real spawn.
    const dmConversations = t.ctx.db
      .prepare(
        `SELECT conversation_id AS id
           FROM conversation_agents ca
           JOIN conversations c ON c.id = ca.conversation_id
          WHERE ca.agent_id = ? AND c.kind = 'dm_channel'`,
      )
      .all(created.agent.id) as { id: string }[];
    expect(dmConversations.length).toBe(1);
    t.ctx.db
      .prepare(
        `UPDATE conversation_agents SET status = 'active'
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(dmConversations[0]!.id, created.agent.id);

    const res = await http(t).patch(`/api/agents/${created.agent.id}`, {
      runtime: 'codex',
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('agent_busy_change_runtime');
  });

  it('allows runtime change when nothing is running', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).patch(`/api/agents/${created.agent.id}`, {
      runtime: 'codex',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.agent.runtime).toBe('codex');
  });

  it('rejects display_name with control chars or Unicode line separators (400)', async () => {
    // Defense-in-depth: keep prompt-injection-shaped values out of
    // `agents.display_name` from the write side. Mirrors the
    // register / PATCH /api/me guards via shared `DisplayNameSchema`.
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const cases = [
      'first\nsecond',
      'tab\there',
      'cr\rhere',
      'null\x00here',
      'del\x7Fhere',
      'nel\u0085here',
      'c1\u009Fhere',
      'ls\u2028here',
      'ps\u2029here',
    ];
    for (const display_name of cases) {
      const res = await http(t).patch(`/api/agents/${created.agent.id}`, {
        display_name,
      });
      expect(res.status, `display_name=${JSON.stringify(display_name)}`).toBe(
        400,
      );
    }
  });

  it('403s when the registered viewer is not the creator (v26 canEditAgent gate)', async () => {
    // 'teammate' creates the agent; 'local' (the default test viewer)
    // tries to PATCH it. The v26 gate must reject by creator mismatch.
    t = buildTestApp();
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'alice', runtime: 'claude' },
        {
          headers: {
            [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
          },
        },
      )
    ).json() as any;
    expect(created.agent.created_by_user_id).toBe('teammate');

    const denied = await http(t).patch(`/api/agents/${created.agent.id}`, {
      display_name: 'Hijacked',
    });
    expect(denied.status).toBe(403);
    const body = await denied.json() as any;
    expect(body.error).toBe('forbidden');

    // The creator can still PATCH their own agent.
    const allowed = await http(t).patch(
      `/api/agents/${created.agent.id}`,
      { display_name: 'Alice (renamed)' },
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
        },
      },
    );
    expect(allowed.status).toBe(200);
  });
});

describe('GET /api/agents/:id/workspace', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('returns L1 path + seeded system_prompt + memory previews', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await (
      await http(t).get(`/api/agents/${created.agent.id}/workspace`)
    ).json() as any;
    expect(res.workspace.l1_path).toContain(created.agent.id);
    expect(res.workspace.system_prompt).not.toBeNull();
    expect(res.workspace.memory).not.toBeNull();
    expect(res.workspace.system_prompt.content).toContain('Global role');
    expect(res.workspace.memory.content).toContain('Key Knowledge');
    expect(res.workspace.memory.content).toContain('notes/work-log.md');
    expect(Array.isArray(res.workspace.notes)).toBe(true);
    expect(res.workspace.notes.map((n: any) => n.name)).toContain('work-log.md');
  });
});

describe('GET /api/agents/:id/runtime-state', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('lists every conversation_agent for the agent with workspace/channel/thread names denormalized', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await (
      await http(t).get(`/api/agents/${created.agent.id}/runtime-state`)
    ).json() as any;
    expect(Array.isArray(res.conversation_agents)).toBe(true);
    expect(res.conversation_agents.length).toBeGreaterThan(0);
    const dm = res.conversation_agents.find(
      (s: any) => s.conversation_kind === 'dm_channel',
    );
    expect(dm.workspace_kind).toBe('agent_home');
    expect(dm.channel_title).toBe('Onboarding');
    expect(dm.thread_title).toBeNull();
    expect(dm.status).toBe('idle'); // FakeConversationManager doesn't flip status
  });
});

describe('POST /api/agents/:id/stop', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('hard-stops every running conversation_agent for this agent', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // mark the onboarding conversation_agent as active
    const dmConversations = t.ctx.db
      .prepare(
        `SELECT conversation_id AS id
           FROM conversation_agents ca
           JOIN conversations c ON c.id = ca.conversation_id
          WHERE ca.agent_id = ? AND c.kind = 'dm_channel'`,
      )
      .all(created.agent.id) as { id: string }[];
    t.ctx.db
      .prepare(
        `UPDATE conversation_agents SET status = 'active'
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(dmConversations[0]!.id, created.agent.id);

    t.fake.stops = [];
    const res = await http(t).post(`/api/agents/${created.agent.id}/stop`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.stopped).toBe(1);
    expect(t.fake.stops).toHaveLength(1);
    expect(t.fake.stops[0]!.mode).toBe('hard');
  });

  it('no-op (200, stopped:0) when nothing is running', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fake.stops = [];
    const res = await http(t).post(`/api/agents/${created.agent.id}/stop`);
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
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    // join alice to a regular workspace
    const ws = await (
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [created.agent.id],
      })
    ).json() as any;

    const res = await (
      await http(t).get(`/api/agents/${created.agent.id}/delete-impact`)
    ).json() as any;
    expect(res.impact.agent_name).toBe('alice');
    expect(res.impact.dm_channel.name).toBe('Onboarding');
    expect(res.impact.dm_channel.conversation_count).toBe(1);
    expect(res.impact.owned_home.workspace_kind).toBe('agent_home');
    expect(res.impact.owned_home.owner_agent_id).toBe(created.agent.id);
    expect(res.impact.regular_workspaces).toEqual([{ id: ws.workspace.id, name: 'engineering' }]);
    expect(res.impact.regular_memberships).toEqual([{ id: ws.workspace.id, name: 'engineering' }]);
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
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    await http(t).post('/api/workspaces', {
      name: 'engineering',
      member_agent_ids: [created.agent.id],
    });

    // mark DM conversation_agent as active so the stop path is exercised
    const dmConversations = t.ctx.db
      .prepare(
        `SELECT conversation_id AS id
           FROM conversation_agents ca
           JOIN conversations c ON c.id = ca.conversation_id
          WHERE ca.agent_id = ? AND c.kind = 'dm_channel'`,
      )
      .all(created.agent.id) as { id: string }[];
    t.ctx.db
      .prepare(
        `UPDATE conversation_agents SET status = 'active'
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .run(dmConversations[0]!.id, created.agent.id);

    t.fake.stops = [];
    const del = await http(t).del(
      `/api/agents/${created.agent.id}`,
      { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) },
    );
    expect(del.status).toBe(204);

    // agent gone
    const get = await http(t).get(`/api/agents/${created.agent.id}`);
    expect(get.status).toBe(404);

    // DM channel gone
    expect((await http(t).get(`/api/channels/${created.dm_channel_id}`)).status)
      .toBe(404);
    // engineering workspace still exists (agent was removed, workspace stays)
    const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
    expect(workspaces.workspaces.find((w: any) => w.name === 'engineering')).toBeDefined();

    // running conversation_agent was stopped (hard) — at least one stop call
    expect(t.fake.stops.some(s => s.agentId === created.agent.id && s.mode === 'hard')).toBe(true);
  });
});
