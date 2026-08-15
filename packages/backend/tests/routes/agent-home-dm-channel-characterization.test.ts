import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Pre-refactor characterization net for the agent_home DM-channel branch of
// POST /api/workspaces/:id/channels (#task:977, P8). That branch is the last
// route-level `db.transaction` in routes.ts (insertDmChannel + addAgent +
// addUser) followed by a `workspace_channels_changed` publish; it is being
// extracted into `ChannelService.createAgentHomeDmChannel`.
//
// Existing route coverage (workspace-conversation-routes.test.ts) only pins the
// happy path + the human-membership row. These tests pin the UNCOVERED, load-
// bearing arms so the extraction is provably behavior-preserving:
//   - member-list rejection 400 (agent ids OR user ids) with its exact body,
//   - owner-unset 500 / owner-not-found 404 with their exact `{ error }`-only
//     bodies (no `code` field — the agent_home arm must NOT be routed through
//     the regular branch's `channelServiceErrorResponse`, which adds `code`),
//   - the explicit `workspace_channels_changed` publish, and
//   - single-transaction atomicity: if the 3rd write fails, ALL THREE writes
//     (conversation row, conversation_agents owner row, conversation_users row)
//     roll back — the only value of this branch being a single tx.

async function createHomeWorkspace(
  t: TestApp,
  name: string,
): Promise<{ agentId: string; homeId: string }> {
  const agentRes = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(agentRes.status).toBe(201);
  const agentId = ((await agentRes.json()) as any).agent.id;
  const wsList = (await (await http(t).get('/api/workspaces')).json()) as any;
  const home = wsList.workspaces.find(
    (w: any) => w.workspace_kind === 'agent_home' && w.owner_agent_id === agentId,
  );
  expect(home).toBeDefined();
  return { agentId, homeId: home.id };
}

describe('POST /api/workspaces/:id/channels — agent_home DM branch characterization (#task:977)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('rejects a non-empty member_agent_ids on an agent_home DM create with 400', async () => {
    t = buildTestApp();
    const { agentId, homeId } = await createHomeWorkspace(t, 'alice');

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'Bad',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'agent_home channels always use the home owner/current user as members',
    });
  });

  it('rejects a non-empty member_user_ids on an agent_home DM create with 400', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'Bad',
      member_agent_ids: [],
      member_user_ids: ['teammate'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'agent_home channels always use the home owner/current user as members',
    });
  });

  it('rejects visibility=public on an agent_home DM create with 400 and no row', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');

    const before = (
      t.ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?')
        .get(homeId) as { n: number }
    ).n;

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'PublicDM',
      member_agent_ids: [],
      visibility: 'public',
    });
    // `public` is regular-channel-only; the agent_home path mints a dm_channel,
    // so this must fail closed (4xx) rather than silently create a private DM.
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'agent_home DM channels cannot be public',
    });

    // No row leaked — the guard runs before createAgentHomeDmChannel.
    const after = (
      t.ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?')
        .get(homeId) as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  it('allows explicit visibility=private on an agent_home DM create (201, unchanged)', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'PrivateDM',
      member_agent_ids: [],
      visibility: 'private',
    });
    // Omitted / explicit `private` pass through — only `public` is rejected.
    expect(res.status).toBe(201);
    const channel = ((await res.json()) as any).channel;
    expect(channel).toMatchObject({ placement_kind: 'workspace', roster_policy: 'fixed' });
    expect(channel.visibility).toBe('private');
  });

  // The owner-unset 500 and owner-not-found 404 arms are DEFENSIVE guards
  // against a state the schema forbids: a CHECK constraint enforces
  // `agent_home ⇒ owner_agent_id IS NOT NULL`, and a FK enforces
  // `owner_agent_id ⇒ a real agents row`. Neither state is reachable through
  // the public API. To pin the exact responses these guards produce we
  // simulate the corrupted row by briefly relaxing the relevant enforcement
  // pragma for the UPDATE only, then restoring it. (Governance is user-role
  // based — workspace_users — not owner_agent_id, so the 403 gate still passes
  // and the handler reaches these branches.)

  it('returns 500 (body has no `code`) when an agent_home workspace has no owner_agent_id', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');
    t.ctx.db.pragma('ignore_check_constraints = ON');
    t.ctx.db
      .prepare('UPDATE workspaces SET owner_agent_id = NULL WHERE id = ?')
      .run(homeId);
    t.ctx.db.pragma('ignore_check_constraints = OFF');

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'X',
      member_agent_ids: [],
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'agent_home workspace missing owner' });
  });

  it('returns 404 (body has no `code`) when the agent_home owner agent does not exist', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');
    t.ctx.db.pragma('foreign_keys = OFF');
    t.ctx.db
      .prepare('UPDATE workspaces SET owner_agent_id = ? WHERE id = ?')
      .run('ghost-agent-id', homeId);
    t.ctx.db.pragma('foreign_keys = ON');

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'X',
      member_agent_ids: [],
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'agent_home owner not found' });
  });

  it('publishes workspace_channels_changed for the freshly-created DM (happy path)', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');

    const published: Array<{ scope: string; kind: string; payload: unknown }> = [];
    const orig = t.ctx.events.publishToScope.bind(t.ctx.events);
    t.ctx.events.publishToScope = ((scope: string, kind: string, payload: unknown) => {
      published.push({ scope, kind, payload });
      return orig(scope, kind, payload);
    }) as typeof t.ctx.events.publishToScope;

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'Mentions',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    const channel = ((await res.json()) as any).channel;

    expect(
      published.filter(
        e => e.kind === 'workspace_channels_changed' && e.scope === `workspace:${homeId}`,
      ),
    ).toEqual([
      {
        scope: `workspace:${homeId}`,
        kind: 'workspace_channels_changed',
        payload: { workspace_id: homeId, channel_id: channel.id },
      },
    ]);
  });

  it('rolls back ALL THREE writes atomically when the final write fails (single tx)', async () => {
    t = buildTestApp();
    const { homeId } = await createHomeWorkspace(t, 'alice');

    // Drop the harness auto-seed triggers so the route's OWN addUser is the
    // write that lands in conversation_users (and so insertDmChannel does not
    // trip the abort trigger via an auto-seed insert). Then force the 3rd write
    // (conversation_users) to abort, exercising the route-level tx rollback.
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;
       CREATE TEMP TRIGGER force_fail_conversation_users
         BEFORE INSERT ON conversation_users
         BEGIN SELECT RAISE(ABORT, 'forced atomicity failure'); END;`,
    );

    const convBefore = (
      t.ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?')
        .get(homeId) as { n: number }
    ).n;
    const agentsBefore = (
      t.ctx.db.prepare('SELECT COUNT(*) AS n FROM conversation_agents').get() as {
        n: number;
      }
    ).n;
    const usersBefore = (
      t.ctx.db.prepare('SELECT COUNT(*) AS n FROM conversation_users').get() as {
        n: number;
      }
    ).n;

    const res = await http(t).post(`/api/workspaces/${homeId}/channels`, {
      title: 'Doomed',
      member_agent_ids: [],
    });
    // Uncaught SqliteError (RAISE ABORT) → Hono default 500 (no app.onError).
    expect(res.status).toBe(500);

    // Zero residue: no new conversation row, no new conversation_agents row, no
    // new conversation_users row — the whole tx rolled back together.
    const convAfter = (
      t.ctx.db
        .prepare('SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?')
        .get(homeId) as { n: number }
    ).n;
    const agentsAfter = (
      t.ctx.db.prepare('SELECT COUNT(*) AS n FROM conversation_agents').get() as {
        n: number;
      }
    ).n;
    const usersAfter = (
      t.ctx.db.prepare('SELECT COUNT(*) AS n FROM conversation_users').get() as {
        n: number;
      }
    ).n;
    expect(convAfter).toBe(convBefore);
    expect(agentsAfter).toBe(agentsBefore);
    expect(usersAfter).toBe(usersBefore);
    const doomed = t.ctx.db
      .prepare('SELECT id FROM conversations WHERE workspace_id = ? AND title = ?')
      .get(homeId, 'Doomed');
    expect(doomed).toBeUndefined();
  });
});
