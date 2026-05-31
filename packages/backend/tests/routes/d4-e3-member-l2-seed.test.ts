/**
 * D4.e-3 — POST /api/workspaces/:id/members seeds the member agent's L2 via
 * the owning daemon (`agent_l2_seed`), replacing the backend's direct
 * `seedAgentL2` fs write.
 *
 * Pins (Cindy `-IsT5ltMW2s2uuu8` review focuses):
 *   - happy: 201; `agent_l2_seed` dispatched with `{agent_id, workspace_id,
 *     template_choice}`; L2 carries MEMORY.md + notes/ but NEVER L1
 *     `system_prompt.md`; membership row persisted.
 *   - ordering red line: a daemon seed failure returns the typed error and
 *     inserts NO membership row (no "member added but L2 not seeded" half-state).
 *   - idempotent: re-adding after an edit does not clobber the agent's L2.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';

describe('D4.e-3 — member-add seeds L2 via daemon agent_l2_seed', () => {
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

  it('happy: 201, agent_l2_seed dispatched, L2 has MEMORY.md + notes/, NO system_prompt.md, member persisted', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-1');
    const ws = await createEmptyWorkspace(t, 'l2-seed-happy');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-1',
    });
    expect(res.status).toBe(201);

    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(1);
    expect(seedCalls[0]!.params).toMatchObject({
      agent_id: 'aid-mem-1',
      workspace_id: ws.id,
      template_choice: 'default',
    });

    // The owning daemon (fake) seeds the L2 dir under the bound workspace path.
    const l2 = join(ws.workspace_path, '.silverhand', 'agents', 'aid-mem-1');
    expect(existsSync(join(l2, 'MEMORY.md'))).toBe(true);
    expect(existsSync(join(l2, 'system_prompt.md'))).toBe(false); // L1-only
    expect(readdirSync(join(l2, 'notes')).length).toBeGreaterThan(0);

    const member = t.ctx.db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws.id, 'aid-mem-1') as { n: number };
    expect(member.n).toBe(1);
  });

  it('fail-closed: a daemon seed error returns the typed code and inserts NO membership row', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-2');
    const ws = await createEmptyWorkspace(t, 'l2-seed-fail');

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
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('fs_unavailable');

    const member = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspace_members WHERE agent_id = ?')
      .get('aid-mem-2') as { n: number };
    expect(member.n).toBe(0);
  });

  it('create-with-members partial-failure: 2nd member seed fails → BOTH agents have 0 membership rows and no onboarding conversation', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-cwm-1');
    makeLocalAgent(t, 'aid-cwm-2');

    // Second member's seed throws; the first member's seed succeeds. The
    // route must run ALL seeds before inserting ANY membership row, so a
    // late seed failure leaves agent membership at 0 — never a partial set
    // (a1 added, a2 failed). Workspace row residue is accepted (no 2PC).
    t.fakeHostWs!.agentL2SeedAckOverride = params => {
      if (params.agent_id === 'aid-cwm-2') {
        throw new HostWsCommandResponseError(
          'fs_unavailable' as never,
          'EROFS: read-only file system',
          { hostId: 'local', commandKind: 'agent_l2_seed', requestId: 'r' },
        );
      }
      // First member seeds successfully.
      return { ok: true as const, seeded: true, l2_present: true };
    };

    const res = await http(t).post('/api/workspaces', {
      name: 'cwm-partial-fail',
      member_agent_ids: ['aid-cwm-1', 'aid-cwm-2'],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('fs_unavailable');

    // No agent membership rows for EITHER member (not even the one whose
    // seed succeeded) — the membership loop never ran.
    const members = t.ctx.db
      .prepare(
        "SELECT COUNT(*) as n FROM workspace_members WHERE agent_id IN ('aid-cwm-1','aid-cwm-2')",
      )
      .get() as { n: number };
    expect(members.n).toBe(0);

    // No onboarding conversation was created (the onboarding block sits
    // after the membership loop, so it never ran).
    const convs = t.ctx.db
      .prepare(
        `SELECT COUNT(*) as n FROM conversations c
           JOIN workspaces w ON w.id = c.workspace_id
          WHERE w.name = 'cwm-partial-fail'`,
      )
      .get() as { n: number };
    expect(convs.n).toBe(0);
  });

  it('idempotent: re-adding after an L2 edit does not clobber the agent content', async () => {
    t = buildTestApp();
    makeLocalAgent(t, 'aid-mem-3');
    const ws = await createEmptyWorkspace(t, 'l2-seed-idempotent');

    const add1 = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-3',
    });
    expect(add1.status).toBe(201);

    // The agent edits its L2 MEMORY.md after the first seed.
    const memPath = join(
      ws.workspace_path,
      '.silverhand',
      'agents',
      'aid-mem-3',
      'MEMORY.md',
    );
    writeFileSync(memPath, '# edited by the agent\n', 'utf-8');

    // Remove then re-add the member: the re-seed must preserve the edit.
    const del = await http(t).del(
      `/api/workspaces/${ws.id}/members/aid-mem-3`,
    );
    expect(del.status).toBe(204);
    const add2 = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'aid-mem-3',
    });
    expect(add2.status).toBe(201);
    expect(readFileSync(memPath, 'utf-8')).toBe('# edited by the agent\n');
  });
});
