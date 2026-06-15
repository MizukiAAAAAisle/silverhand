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
  // (see `docs/remote-backend-architecture-notes.md §3.3` ACL #1 row); the agent-by-id
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

// #task:811 — replacement for the legacy single-shot snapshot above.
// The renderer no longer needs a curated `system_prompt + MEMORY +
// notes/` triple; the new two-column AgentWorkspacePane talks to two
// generic endpoints — `/workspace/tree` for the file list and
// `/workspace/file?path=…` for one file at a time. The daemon owns
// path security.
describe('GET /api/agents/:id/workspace/tree', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('returns the flat tree of every visible entry under the agent home dir', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/tree`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const paths = body.tree.nodes.map((n: any) => `${n.kind}:${n.path}`);
    // Seeded L1 always includes system_prompt.md + MEMORY.md + the
    // notes/ directory. Directories sort before files at the same
    // parent; the tree is flat (the renderer reconstructs the
    // hierarchy off `path`).
    expect(paths).toContain('directory:notes');
    expect(paths).toContain('file:system_prompt.md');
    expect(paths).toContain('file:MEMORY.md');
  });

  it('dispatches agent_workspace_tree with a semantic agent_id only (no path)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.calls.length = 0;
    await http(t).get(`/api/agents/${created.agent.id}/workspace/tree`);
    const calls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'agent_workspace_tree',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({ agent_id: created.agent.id });
  });

  it('404 for an unknown agent', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/aid_missing/workspace/tree');
    expect(res.status).toBe(404);
  });

  it('daemon not attached → 503 host_attach_pending (fail-closed)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
      'transport_no_connection',
      'host local is not connected',
      { hostId: 'local', commandKind: 'agent_workspace_tree', requestId: 'r' },
    );
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/tree`,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('host_attach_pending');
    expect(body.tree).toBeUndefined();
  });

  it('host-local fs failure → 503 fs_unavailable (typed, no fs fallback)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
      'fs_unavailable' as never,
      'EACCES while walking the agent home dir',
      { hostId: 'local', commandKind: 'agent_workspace_tree', requestId: 'r' },
    );
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/tree`,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('fs_unavailable');
  });
});

describe('GET /api/agents/:id/workspace/file', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('reads a top-level file via virtual path', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        'system_prompt.md',
      )}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.file.path).toBe('system_prompt.md');
    expect(body.file.content).toContain('Global role');
    expect(body.file.truncated).toBe(false);
  });

  it('forwards the path query param opaquely to the daemon', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.calls.length = 0;
    // The backend MUST NOT do shape work on the path — it forwards the
    // string verbatim and the daemon enforces every rule. We pin that
    // here by sending a clearly invalid `..`-shape path and asserting
    // the daemon receives it unchanged (the daemon then projects it
    // to forbidden_path; the route surfaces the typed code).
    await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        '../etc/passwd',
      )}`,
    );
    const calls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'agent_workspace_file_read',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({
      agent_id: created.agent.id,
      path: '../etc/passwd',
    });
  });

  it('400 forbidden_path when the path query param is missing', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file`,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('forbidden_path');
    // No daemon round-trip for an obvious typo.
    expect(
      t.fakeHostWs!.calls.some(c => c.kind === 'agent_workspace_file_read'),
    ).toBe(false);
  });

  it('forbidden_path daemon verdict → 400 (UI-level reject, not retry)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
      'forbidden_path' as never,
      'path is not a readable file under the agent home dir',
      {
        hostId: 'local',
        commandKind: 'agent_workspace_file_read',
        requestId: 'r',
      },
    );
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        '../etc/passwd',
      )}`,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('forbidden_path');
    expect(body.file).toBeUndefined();
  });

  it('not_found daemon verdict → 404', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        'notes/missing.md',
      )}`,
    );
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('not_found');
  });

  it('host-local fs failure → 503 fs_unavailable (typed)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
      'fs_unavailable' as never,
      'EACCES while reading the file',
      {
        hostId: 'local',
        commandKind: 'agent_workspace_file_read',
        requestId: 'r',
      },
    );
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        'system_prompt.md',
      )}`,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as any;
    expect(body.code).toBe('fs_unavailable');
  });

  it('relays `truncated:true` from the daemon for a 64KB+ file', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    t.fakeHostWs!.agentWorkspaceFileReadAckOverride = (params): any => ({
      ok: true,
      file: {
        path: params.path,
        content: 'x'.repeat(64 * 1024) + '\n\n… (truncated; …)',
        size: 64 * 1024 + 500,
        mtime: 1_780_000_000_000,
        truncated: true,
      },
    });
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/workspace/file?path=${encodeURIComponent(
        'MEMORY.md',
      )}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.file.truncated).toBe(true);
    expect(body.file.size).toBe(64 * 1024 + 500);
  });
});

// #task:1135 — public mirror the agent pane reads. Its gate is STRICTER than
// agent visibility: raw `mcp.json` can carry secrets (env tokens, HTTP auth
// headers), so `canViewAgent` is necessary but not sufficient — a teammate who
// can see the agent must additionally pass `canEditAgent` (creator/self) to
// read the raw bytes (Cindy #task:1135 review, Blocker 1).
describe('GET /api/agents/:id/profile/mcp', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('creator reads their own profile MCP (200, raw:null when no mcp.json)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/profile/mcp`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.raw).toBeNull();
  });

  it('relays the raw mcp.json bytes from the daemon to the creator', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const raw = JSON.stringify({ mcpServers: { fs: { command: 'npx' } } });
    t.fakeHostWs!.agentProfileMcpReadAckOverride = () =>
      ({ ok: true as const, raw }) as never;
    const res = await http(t).get(
      `/api/agents/${created.agent.id}/profile/mcp`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.raw).toBe(raw);
  });

  it('404 for an unknown agent', async () => {
    t = buildTestApp();
    const res = await http(t).get('/api/agents/aid_missing/profile/mcp');
    expect(res.status).toBe(404);
  });

  it('same-workspace teammate (viewer, non-editor) is 403, NOT given raw secrets', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );
    const teammateHeaders = {
      [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate'),
    };
    // 'teammate' owns the agent; make it workspace-visible to 'local' so
    // `canViewAgent` passes for 'local' but `canEditAgent` does not.
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

    // 'local' (default viewer) can SEE the agent…
    expect((await http(t).get(`/api/agents/${created.agent.id}`)).status).toBe(
      200,
    );
    // …but reading raw profile MCP requires canEditAgent → 403, and the
    // daemon is never even asked.
    t.fakeHostWs!.calls.length = 0;
    const denied = await http(t).get(
      `/api/agents/${created.agent.id}/profile/mcp`,
    );
    expect(denied.status).toBe(403);
    const body = await denied.json() as any;
    expect(body.raw).toBeUndefined();
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'agent_profile_mcp_read'),
    ).toHaveLength(0);
  });
});

// #task:1137 — public probe mirror. Same secret-aware gate as the raw read
// (canViewAgent THEN canEditAgent); a probe connects to the user's endpoint
// with their secrets, so a non-editor viewer must not be able to trigger it.
describe('POST /api/agents/:id/profile/mcp/probe', () => {
  let t: TestApp | null = null;
  afterEach(() => { t?.cleanup(); t = null; });

  it('creator probes a server (200, relays the McpProbeResult)', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    let received: any = null;
    t.fakeHostWs!.mcpProbeAckOverride = p => {
      received = p;
      return {
        ok: true as const,
        phase: 'initialize' as const,
        server_info: { name: 'srv', version: '2' },
      } as never;
    };
    const res = await http(t).post(
      `/api/agents/${created.agent.id}/profile/mcp/probe`,
      { server_name: 'github' },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toEqual({
      ok: true,
      phase: 'initialize',
      server_info: { name: 'srv', version: '2' },
    });
    // The route forwards the scope-keyed source + raw server name.
    expect(received.source).toEqual({ kind: 'profile', agent_id: created.agent.id });
    expect(received.server_name).toBe('github');
  });

  it('forwards include_tools to the daemon', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    let received: any = null;
    t.fakeHostWs!.mcpProbeAckOverride = p => {
      received = p;
      return {
        ok: true as const,
        phase: 'tools' as const,
        tools: [{ name: 'list_channels' }],
      } as never;
    };
    const res = await http(t).post(
      `/api/agents/${created.agent.id}/profile/mcp/probe`,
      { server_name: 'github', include_tools: true },
    );
    expect(res.status).toBe(200);
    expect(received.include_tools).toBe(true);
    const body = await res.json() as any;
    expect(body.tools).toEqual([{ name: 'list_channels' }]);
  });

  it('400 when server_name is missing', async () => {
    t = buildTestApp();
    const created = await (
      await http(t).post('/api/agents', { name: 'alice', runtime: 'claude' })
    ).json() as any;
    const res = await http(t).post(
      `/api/agents/${created.agent.id}/profile/mcp/probe`,
      {},
    );
    expect(res.status).toBe(400);
  });

  it('404 for an unknown agent', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/agents/aid_missing/profile/mcp/probe', {
      server_name: 'x',
    });
    expect(res.status).toBe(404);
  });

  it('same-workspace teammate (viewer, non-editor) is 403; probe never dispatched', async () => {
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

    expect((await http(t).get(`/api/agents/${created.agent.id}`)).status).toBe(
      200,
    );
    t.fakeHostWs!.calls.length = 0;
    const denied = await http(t).post(
      `/api/agents/${created.agent.id}/profile/mcp/probe`,
      { server_name: 'github' },
    );
    expect(denied.status).toBe(403);
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'mcp_probe'),
    ).toHaveLength(0);
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

  it('summarizes DM channel + regular channel membership (no host-local fs paths)', async () => {
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
    // D4.e-4: l1_path / l2_paths are gone from the impact DTO — host-local fs
    // paths are never derived backend-side (I1/I6). The L2-dir count is
    // `regular_memberships.length`.
    expect(res.impact.l1_path).toBeUndefined();
    expect(res.impact.l2_paths).toBeUndefined();
    expect(res.impact.regular_memberships).toHaveLength(1);
    // P1-2: owned_home is a narrow window — it must NOT carry the owned
    // workspace's host-local `workspace_path` (or any other host-resolution
    // field). The daemon owns path resolution (I6).
    expect(res.impact.owned_home.workspace_path).toBeUndefined();
    expect(res.impact.owned_home.workspace_host_id).toBeUndefined();
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
