import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../../src/ws/host-ws-server.js';
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
    const ownedLocal = new HostRepo(t.ctx.db).getOwnedLocalForUser(t.viewerUserId);
    const res = await http(t).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.agent.name).toBe('alice');
    expect(body.agent.host_id).toBe(ownedLocal?.id);
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

  it('fails closed when the creator has no owned local host', async () => {
    t = buildTestApp({ ownedLocalHostUserIds: [] });
    const res = await http(t).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'local_host_unbound' });
  });

  it('rejects an explicit host id owned by another user', async () => {
    t = buildTestApp();
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser('teammate');
    expect(teammateHost).not.toBeNull();

    const res = await http(t).post('/api/agents', {
      name: 'alice',
      runtime: 'claude',
      host_id: teammateHost!.id,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'host_not_owned' });
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
    // the old settings viewer pointer instead of the principal that
    // drove the route. With v25 permission tightening, multi-human v2
    // would see the *global* viewer as agent_home owner instead of the
    // human who clicked "create agent". Drop the test-fixture autoseed
    // so we can observe the membership writes deterministically.
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    // Fixture seeds 'local' as global viewer; have 'teammate' (a
    // different fixture user) drive the route via the session subject.
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

  it('filters agent list to owned or workspace-visible agents', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-agent', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;

    let localList = await (await http(t).get('/api/agents')).json() as any;
    expect(localList.agents.map((a: any) => a.id)).not.toContain(created.agent.id);

    const ws = await (
      await http(t).post(
        '/api/workspaces',
        {
          name: 'shared',
        },
        { headers: teammateHeaders },
      )
    ).json() as any;
    // Workspace membership is what makes the agent workspace-visible. Create
    // memberless then attach the member directly: post-D4.e the
    // create-with-members seed path is gated to the backend's co-located host,
    // and teammate's agent lives on teammate's own (non-co-located) local host.
    // The L2 seed is irrelevant to this ACL assertion.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(ws.workspace.id, created.agent.id, Date.now());
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
         VALUES (?, 'local', ?)`,
      )
      .run(ws.workspace.id, Date.now());

    localList = await (await http(t).get('/api/agents')).json() as any;
    expect(localList.agents.map((a: any) => a.id)).toContain(created.agent.id);
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

  // D4.c C9 (G3 ACL #1 anti-enumeration): a known-but-unowned agent
  // returns 404, NOT 403 and NOT 200. The 404 surface must be
  // indistinguishable from "unknown id" so the response cannot be
  // used to enumerate agent ids belonging to other users. The route
  // implementation at `src/routes.ts` `GET /api/agents/:id` runs
  // `canViewAgent` and returns the same 404 body shape for both
  // missing and forbidden cases — this test pins that contract.
  //
  // Coverage gap closed by Cindy `mWQVcAFMbuzFfd3U`: workspace +
  // host + conversation cross-user paths already had explicit pins
  // (see `docs/d4-c-g3-acceptance.md` ACL #1 row); the agent-by-id
  // surface was the missing piece.
  it('cross-user GET returns 404 (not 403) — anti-enumeration (G3 ACL #1)', async () => {
    t = buildTestApp();
    // Drop the test fixture's auto-seed triggers — they normally
    // mirror every user into every new workspace's `workspace_users`,
    // which would make teammate's `agent_home` workspace
    // automatically visible to `local`. Production has no such
    // trigger; cross-user agents are NOT auto-shared.
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );

    // Teammate creates an agent owned only by them. No shared
    // workspace afterwards — `canViewAgent` falls through:
    // `created_by_user_id !== local && no shared workspace` → false
    // → 404.
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'teammate-private', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    expect(created.agent.created_by_user_id).toBe('teammate');

    // Default fixture viewer is `local`. With auto-seed dropped,
    // no teammate-owned agent is visible to `local`.
    const res = await http(t).get(`/api/agents/${created.agent.id}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    // Same body shape as the unknown-id 404 above — no `agent`
    // payload, no row enumeration.
    expect(body.error).toBe('agent not found');
    expect((body as Record<string, unknown>).agent).toBeUndefined();
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
    // `agents.display_name` from the write side. Mirrors the auth signup
    // / PATCH /api/me guards via shared `DisplayNameSchema`.
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

  it('keeps profile mutation owner-only even when the agent is workspace-visible', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'shared-agent', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    const ws = await (
      await http(t).post(
        '/api/workspaces',
        { name: 'visible-ws' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    // Membership (not the create-with-members seed) drives visibility — attach
    // it directly; teammate's agent is on a non-co-located local host so the
    // seed path is gated post-D4.e.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(ws.workspace.id, created.agent.id, Date.now());
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
         VALUES (?, 'local', ?)`,
      )
      .run(ws.workspace.id, Date.now());

    expect((await http(t).get(`/api/agents/${created.agent.id}`)).status).toBe(200);
    const denied = await http(t).patch(`/api/agents/${created.agent.id}`, {
      display_name: 'Nope',
    });
    expect(denied.status).toBe(403);
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

  // D4.e-2 — the host-local read now flows through the daemon
  // (`agent_workspace_read`), not a backend fs read. These pin the three
  // Cindy review focuses: (1) backend dispatches a semantic id only — no
  // path; (2) it works in BOTH modes (the old standalone 503 disable is
  // gone, A6); (3) every daemon-side failure fails closed with a typed
  // code — the backend never falls back to its own disk.
  it('dispatches agent_workspace_read with a semantic agent_id only (no path)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.calls.length = 0;
    await http(t).get(`/api/agents/${created.agent.id}/workspace`);
    const reads = t.fakeHostWs!.calls.filter(
      c => c.kind === 'agent_workspace_read',
    );
    expect(reads).toHaveLength(1);
    // Exactly { agent_id } — no path/workspace_path leaks to the daemon.
    expect(reads[0]!.params).toEqual({ agent_id: created.agent.id });
  });

  it('works in standalone mode — the old standalone 503 disable is gone (A6)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(`/api/agents/${created.agent.id}/workspace`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace.system_prompt.content).toContain('Global role');
    // Proves it went through the daemon read, not a backend fs read.
    expect(
      t.fakeHostWs!.calls.some(c => c.kind === 'agent_workspace_read'),
    ).toBe(true);
  });

  it('daemon not attached → 503 host_attach_pending (fail-closed, no fs fallback)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
      'transport_no_connection',
      'host local is not connected to outbound websocket',
      { hostId: 'local', commandKind: 'agent_workspace_read', requestId: 'r' },
    );
    const res = await http(t).get(`/api/agents/${created.agent.id}/workspace`);
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('host_attach_pending');
    // Fail-closed: no workspace payload was synthesized from server disk.
    expect(body.workspace).toBeUndefined();
  });

  it('host-local fs failure → 503 fs_unavailable (typed, no fs fallback)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
      'fs_unavailable' as never,
      'host-local read failed: EACCES',
      { hostId: 'local', commandKind: 'agent_workspace_read', requestId: 'r' },
    );
    const res = await http(t).get(`/api/agents/${created.agent.id}/workspace`);
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('fs_unavailable');
    expect(body.workspace).toBeUndefined();
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

  it('keeps stop owner-only even when the agent is workspace-visible', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    const created = await (
      await http(t).post(
        '/api/agents',
        { name: 'owned-by-teammate', runtime: 'claude' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    const ws = await (
      await http(t).post(
        '/api/workspaces',
        { name: 'stop-visible' },
        { headers: teammateHeaders },
      )
    ).json() as any;
    // Direct membership = workspace-visible; the create-with-members seed path
    // is gated to the co-located host and teammate's host is separate.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(ws.workspace.id, created.agent.id, Date.now());
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_users (workspace_id, user_id, joined_at)
         VALUES (?, 'local', ?)`,
      )
      .run(ws.workspace.id, Date.now());

    expect((await http(t).get(`/api/agents/${created.agent.id}`)).status).toBe(200);
    const denied = await http(t).post(`/api/agents/${created.agent.id}/stop`);
    expect(denied.status).toBe(403);
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
