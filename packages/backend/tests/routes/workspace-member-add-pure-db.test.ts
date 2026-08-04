/**
 * POST /api/workspaces/:id/members is a PURE DB write after the relocation-v1
 * §7 task 4 provisioning collapse.
 *
 * The former D4.e-3 behavior — member-add eagerly seeds the member agent's L2
 * via the owning daemon (`agent_l2_seed`) before inserting the row — is GONE.
 * Each member's L2 (`MEMORY.md` / `notes/`) is now materialized LAZILY at that
 * member's first spawn by the `AgentL2SeedEnsurer`, against the deterministic
 * agent-centric bundle coordinate. So this door:
 *   - persists the membership row with NO daemon dispatch (pure DB);
 *   - lands the row regardless of daemon reachability (a member added but never
 *     spawned is a legal no-dir/no-L2 state — no "seed-before-row" red line);
 *   - never dispatches `agent_l2_seed` (the U2 falsifier).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';

describe('member-add is a pure DB write (relocation-v1 §7 task 4 provisioning collapse)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  function makeLocalAgent(app: TestApp, id: string): void {
    const now = Date.now();
    app.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(id, id, app.ctx.coLocatedHostId, app.viewerUserId, now, now);
  }

  async function createEmptyWorkspace(app: TestApp, name: string): Promise<any> {
    const res = await http(app).post('/api/workspaces', {
      name,
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).workspace;
  }

  it('happy: 201, membership row persisted, and ZERO agent_l2_seed dispatched (L2 is lazy)', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-1');
    const ws = await createEmptyWorkspace(t, 'member-add-pure-db');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-1',
    });
    expect(res.status).toBe(201);

    // Falsifier: member-add no longer dispatches ANY daemon seed — L2 is
    // materialized lazily at first spawn, not eagerly here.
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(0);

    const member = t.ctx.db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws.id, 'aid-mem-1') as { n: number };
    expect(member.n).toBe(1);
  });

  it('membership lands regardless of daemon state — no seed-before-row red line', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-2');
    const ws = await createEmptyWorkspace(t, 'member-add-no-daemon');

    // A seed that WOULD fail if it were dispatched. Member-add is a pure DB
    // write, so this override must never fire and the old fail-closed "no
    // membership row on seed failure" behavior no longer applies.
    t.fakeHostWs!.agentL2SeedAckOverride = () => {
      throw new HostWsCommandResponseError(
        'fs_unavailable' as never,
        'EROFS: read-only file system',
        { hostId: 'local', commandKind: 'agent_l2_seed', requestId: 'r' },
      );
    };

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-2',
    });
    expect(res.status).toBe(201);

    const member = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspace_members WHERE agent_id = ?')
      .get('aid-mem-2') as { n: number };
    expect(member.n).toBe(1);
    // And no seed was dispatched.
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(0);
  });

  it('re-add after remove is idempotent at the row level — still pure DB, no seed', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-3');
    const ws = await createEmptyWorkspace(t, 'member-add-readd');

    const add1 = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-3',
    });
    expect(add1.status).toBe(201);

    const del = await http(t).del(`/api/workspaces/${ws.id}/members/aid-mem-3`);
    expect(del.status).toBe(204);

    const add2 = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-3',
    });
    expect(add2.status).toBe(201);

    const member = t.ctx.db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws.id, 'aid-mem-3') as { n: number };
    expect(member.n).toBe(1);
    // No seed dispatched across either add.
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(0);
  });
});
