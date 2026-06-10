import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

// Pre-refactor characterization net for the create-workspace saga (#task:976,
// P7). These pin the LEAST-covered, most load-bearing graded-permission
// semantics of POST /api/workspaces — creator-as-owner, extra-members-as-plain-
// member, and per-member capability default-seed — which the upcoming
// `createWorkspace` use-case extraction relocates out of routes.ts:1688-1727.
// The coverage audit confirmed
// these three were unpinned; everything else (validation / placement /
// provision-no-orphan / L2-seed ordering / onboarding) is already covered.

async function makeLocalAgent(t: TestApp, name: string): Promise<string> {
  const r = await http(t).post('/api/agents', { name, runtime: 'claude' });
  expect(r.status).toBe(201);
  const body = (await r.json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id;
}

describe('POST /api/workspaces — graded-permission characterization (#task:976)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('creator becomes workspace OWNER: workspace_users.role=owner + owner_user_id stamped + reflected in 201 body', async () => {
    t = buildTestApp();
    // Drop the harness auto-seed triggers so the assertion reflects the
    // ROUTE's own membership writes (reproduces production, which has no
    // trigger) — same pattern as workspace-conversation-routes.test.ts.
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );

    const res = await http(t).post('/api/workspaces', {
      name: 'owner-ws',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    // 201 body reflects the owner (handler refetches after setOwnerUserId).
    expect(body.workspace.owner_user_id).toBe('local');

    // Denormalized pointer stamped on the workspaces row.
    const ws = t.ctx.db
      .prepare('SELECT owner_user_id FROM workspaces WHERE id = ?')
      .get(body.workspace.id) as { owner_user_id: string | null };
    expect(ws.owner_user_id).toBe('local');

    // Authoritative role column: the sole member is the creator, as owner.
    const rows = t.ctx.db
      .prepare(
        'SELECT user_id, role FROM workspace_users WHERE workspace_id = ? ORDER BY user_id',
      )
      .all(body.workspace.id) as Array<{ user_id: string; role: string }>;
    expect(rows).toEqual([{ user_id: 'local', role: 'owner' }]);
  });

  it('extra member_user_ids join as plain member (no implicit owner/admin); creator stays owner', async () => {
    t = buildTestApp();
    t.ctx.db.exec(
      `DROP TRIGGER IF EXISTS test_seed_workspace_users;
       DROP TRIGGER IF EXISTS test_seed_conversation_users;`,
    );

    const res = await http(t).post('/api/workspaces', {
      name: 'graded-ws',
      member_agent_ids: [],
      member_user_ids: ['teammate'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    const rows = t.ctx.db
      .prepare(
        'SELECT user_id, role FROM workspace_users WHERE workspace_id = ? ORDER BY user_id',
      )
      .all(body.workspace.id) as Array<{ user_id: string; role: string }>;
    expect(rows).toEqual([
      { user_id: 'local', role: 'owner' },
      { user_id: 'teammate', role: 'member' },
    ]);
  });

  it('each member agent gets the FULL default capability set seeded on create', async () => {
    t = buildTestApp();
    const aliceId = await makeLocalAgent(t, 'alice');

    const res = await http(t).post('/api/workspaces', {
      name: 'cap-ws',
      member_agent_ids: [aliceId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    const caps = t.ctx.db
      .prepare(
        `SELECT capability FROM workspace_agent_capabilities
          WHERE workspace_id = ? AND agent_id = ?
          ORDER BY capability`,
      )
      .all(body.workspace.id, aliceId)
      .map((r: any) => r.capability as string);
    expect(caps).toEqual([...AGENT_CAPABILITIES].sort());
  });

  // Onboarding delivery is NOT best-effort in this saga (unlike create-agent's
  // P5 deliver). `deliverMessage` is `await`ed with NO `.catch` (routes.ts:1750),
  // so a deliver failure propagates → 500 AND truncates the fan-out (the failing
  // agent's `start` never runs). Only `start(...).catch(...)` is fire-and-forget.
  // Pinning both so the use-case extraction does NOT get pulled toward the P5
  // fire-and-forget shape (Cindy P7 review boundary #1).

  it('onboarding deliver failure is NOT best-effort: 500, DB residue persists, and start is not reached', async () => {
    t = buildTestApp();
    const aliceId = await makeLocalAgent(t, 'alice');
    t.fake.deliverError = new Error('deliver boom');

    const res = await http(t).post('/api/workspaces', {
      name: 'deliver-fail-ws',
      member_agent_ids: [aliceId],
    });
    // Uncaught handler throw → Hono default 500 (no app.onError). The response
    // is a hard failure, NOT a 201 — deliver is on the critical path.
    expect(res.status).toBe(500);

    // DB residue persists (no enclosing transaction rolls these back): the
    // workspace row, the agent membership, and the onboarding conversation were
    // all written before the deliver throw.
    const ws = t.ctx.db
      .prepare('SELECT id FROM workspaces WHERE name = ?')
      .get('deliver-fail-ws') as { id: string } | undefined;
    expect(ws).toBeTruthy();
    const memberCount = t.ctx.db
      .prepare(
        'SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws!.id, aliceId) as { n: number };
    expect(memberCount.n).toBe(1);
    const convCount = t.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE workspace_id = ?')
      .get(ws!.id) as { n: number };
    expect(convCount.n).toBe(1);

    // The fan-out was truncated at the throw: `start` was never reached.
    expect(t.fake.starts).toEqual([]);
  });

  it('onboarding start failure IS best-effort: still 201 (start throw is caught)', async () => {
    t = buildTestApp();
    const aliceId = await makeLocalAgent(t, 'alice');
    t.fake.startError = new Error('start boom');

    const res = await http(t).post('/api/workspaces', {
      name: 'start-fail-ws',
      member_agent_ids: [aliceId],
    });
    // start is fire-and-forget (`.catch`) — its failure must not affect the
    // HTTP outcome.
    expect(res.status).toBe(201);
    // Deliver ran (it precedes start in the loop); start threw before the fake
    // recorded it, and the route swallowed the rejection.
    expect(t.fake.delivered.map(d => d.agentId)).toEqual([aliceId]);
    expect(t.fake.starts).toEqual([]);
  });
});
