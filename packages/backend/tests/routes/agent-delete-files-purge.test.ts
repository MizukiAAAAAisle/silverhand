/**
 * DELETE /api/agents/:id purges the agent's host-local files via the
 * owning daemon (`agent_files_purge`), replacing the backend's direct
 * `fs.rm(l1_path / l2_paths)` block.
 *
 * Origin: D4.e-4. Pins (Cindy review focuses + design §3.3 commit
 * boundary):
 *   - happy: 204; `agent_files_purge` dispatched with `{ agent_id }`; DB rows
 *     gone.
 *   - fail-closed: a typed purge failure returns the code and KEEPS the agent
 *     row + memberships (no DB delete) so a retry's impact still routes.
 *   - daemon offline: 503 host_attach_pending, row preserved.
 *   - no path crosses the wire: params carry only the semantic agent id.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';

describe('D4.e-4 — DELETE agent purges files via daemon agent_files_purge', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function makeActiveAgent(app: TestApp, name: string): Promise<string> {
    const created = (await (
      await http(app).post('/api/agents', { name, runtime: 'claude' })
    ).json()) as any;
    return created.agent.id as string;
  }

  async function delAgent(app: TestApp, id: string) {
    return http(app).del(`/api/agents/${id}`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
  }

  it('happy: 204, agent_files_purge dispatched with { agent_id }, rows gone', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'alice');
    await http(t).post('/api/workspaces', {
      name: 'engineering',
      member_agent_ids: [agentId],
    });

    t.fakeHostWs!.calls = [];
    const del = await delAgent(t, agentId);
    expect(del.status).toBe(204);

    const purgeCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_files_purge');
    expect(purgeCalls).toHaveLength(1);
    expect(purgeCalls[0]!.params).toEqual({ agent_id: agentId });
    // No host-local fs path on the wire — only the semantic agent id.
    expect(JSON.stringify(purgeCalls[0]!.params)).not.toContain('/');

    // Agent row gone; workspace stays (agent removed from it).
    expect((await http(t).get(`/api/agents/${agentId}`)).status).toBe(404);
    const member = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspace_members WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(member.n).toBe(0);
  });

  it('fail-closed: a typed purge failure returns the code and KEEPS the agent + membership rows', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'bob');
    const ws = (await (
      await http(t).post('/api/workspaces', {
        name: 'engineering',
        member_agent_ids: [agentId],
      })
    ).json()) as any;

    t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
      throw new HostWsCommandResponseError(
        'partial_purge' as never,
        'failed to remove 1 target(s): EACCES',
        { hostId: 'local', commandKind: 'agent_files_purge', requestId: 'r' },
      );
    };

    const del = await delAgent(t, agentId);
    expect(del.status).toBe(503);
    expect(((await del.json()) as any).code).toBe('partial_purge');

    // Row + membership preserved (the routing anchor for a retry).
    expect((await http(t).get(`/api/agents/${agentId}`)).status).toBe(200);
    const member = t.ctx.db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(ws.workspace.id, agentId) as { n: number };
    expect(member.n).toBe(1);
  });

  it('daemon offline: 503 host_attach_pending and the agent row is preserved', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'carol');

    // Drop the fake outbound connection so resolveOutboundForHost fails.
    t.fakeHostWs!.connectionIdForHostOverride = () => null;

    const del = await delAgent(t, agentId);
    expect(del.status).toBe(503);
    expect(((await del.json()) as any).code).toBe('host_attach_pending');
    expect((await http(t).get(`/api/agents/${agentId}`)).status).toBe(200);
  });

  // #task:1612 — DELETE performs no pre-purge backfill: L2 materializes
  // lazily from the agent-centric coordinate, so there is nothing to mint
  // before removal. The purge dispatches directly for the whole agent home
  // tree, then the row is deleted.
  it('purges directly, then deletes', async () => {
    t = buildTestApp();
    const agentId = await makeActiveAgent(t, 'dave');
    await http(t).post('/api/workspaces', {
      name: 'engineering',
      member_agent_ids: [agentId],
    });

    t.fakeHostWs!.calls = [];
    const del = await delAgent(t, agentId);
    expect(del.status).toBe(204);

    const kinds = t.fakeHostWs!.calls.map(c => c.kind);
    const purgeIdx = kinds.indexOf('agent_files_purge');
    expect(purgeIdx).toBeGreaterThanOrEqual(0);
    const purgeCall = t.fakeHostWs!.calls[purgeIdx]!;
    expect((purgeCall.params as any).agent_id).toBe(agentId);
  });
});
