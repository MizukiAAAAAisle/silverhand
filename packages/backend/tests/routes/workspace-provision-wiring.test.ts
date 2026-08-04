/**
 * Workspace-create dispatches NO daemon data-plane traffic.
 *
 * relocation-v1 §3.4 / §7-4 — registry demotion. A regular workspace no longer
 * owns a working directory and has no home computer, so create NO LONGER does
 * provision-at-create: there is no `workspace_provision`, no reconcile barrier
 * (`workspace_registry_ids`), and no eager member-L2 seed (`agent_l2_seed`).
 * Creation is a pure set of DB writes; each agent materializes its own bundle
 * lazily at first spawn.
 *
 * These pins are the INVERSE of the retired D4.e-1 provision wiring: they assert
 * that create talks to no daemon at all and still succeeds. §7-3/§7-4 dropped
 * both columns and §6's atomic epoch cut then dropped the create INPUTS
 * (`workspace_path` / `workspace_host_id`) as well, so the only host axis left
 * in these fixtures is the MEMBER agent's computer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';

const DAEMON_DATA_PLANE_KINDS = ['agent_l2_seed'] as const;

function dataPlaneCalls(t: TestApp): { kind: string }[] {
  return t.fakeHostWs!.calls.filter(c =>
    (DAEMON_DATA_PLANE_KINDS as readonly string[]).includes(c.kind),
  );
}

describe('relocation-v1 §7-4 — workspace-create dispatches no daemon provision', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('no members → 201 with the row inserted and ZERO daemon data-plane traffic', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/workspaces', {
      name: 'pure-db-write',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    // The whole registry data-plane family stays silent.
    expect(dataPlaneCalls(t).map(c => c.kind)).toEqual([]);

    const row = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces WHERE id = ?')
      .get(body.workspace.id) as { n: number };
    expect(row.n).toBe(1);
  });

  it('daemon offline → still 201: create no longer depends on a live daemon', async () => {
    // The old provision wiring returned 503 `host_attach_pending` here. Create
    // is now a pure DB write over the DB-only placement resolver (liveness
    // independent), so an offline daemon is irrelevant.
    t = buildTestApp({ hostWsController: () => null });
    const before = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    const res = await http(t).post('/api/workspaces', {
      name: 'offline-ok',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    const after = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n + 1);
  });

  it('owned REMOTE host + member → 201, ZERO provision, ZERO eager seed, row + member persisted', async () => {
    // relocation-v1 §7-4 completes the provisioning collapse: create-with-members
    // is a pure DB write on any host — no home-computer `workspace_provision`, no
    // member `agent_l2_seed`. Each member's L2 materializes lazily at first spawn.
    t = buildTestApp();
    const db = t.ctx.db;
    const userId = t.viewerUserId;
    const now = Date.now();
    // An owned, active REMOTE host (passes assertOwnedActiveHost; kind!=local) —
    // still resolvable purely as the TRANSIENT NOT-NULL column-filler host.
    db.prepare(
      `INSERT INTO hosts
        (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at, activated_at, finalized_at, provisioning_source)
        VALUES (?, ?, 'remote', ?, ?, ?, NULL, ?, ?, ?, 'user_invite')`,
    ).run('host-remote-1', 'remote-1', userId, 'inst-1', now, now, now, now);
    const agentId = 'agent-on-remote';
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    ).run(agentId, 'remoteagent', 'host-remote-1', userId, now, now);

    const res = await http(t).post('/api/workspaces', {
      name: 'remote-with-member',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    expect(dataPlaneCalls(t).map(c => c.kind)).toEqual([]);

    const row = db
      .prepare('SELECT COUNT(*) as n FROM workspaces WHERE id = ?')
      .get(body.workspace.id) as { n: number };
    expect(row.n).toBe(1);
    const member = db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(body.workspace.id, agentId) as { n: number };
    expect(member.n).toBe(1);
  });

  it('a seed that WOULD fail never fires — membership lands on a pure DB write', async () => {
    // The former "seed failure → no membership row" ordering red line is gone
    // with the eager seed itself: create dispatches no `agent_l2_seed`, so a
    // daemon that WOULD fail a seed is irrelevant and the membership lands.
    t = buildTestApp();
    const db = t.ctx.db;
    const userId = t.viewerUserId;
    const now = Date.now();
    db.prepare(
      `INSERT INTO hosts
        (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at, activated_at, finalized_at, provisioning_source)
        VALUES (?, ?, 'remote', ?, ?, ?, NULL, ?, ?, ?, 'user_invite')`,
    ).run('host-remote-2', 'remote-2', userId, 'inst-2', now, now, now, now);
    const agentId = 'agent-seed-fails';
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    ).run(agentId, 'failagent', 'host-remote-2', userId, now, now);

    // A seed that WOULD fail if dispatched — it must never fire.
    t.fakeHostWs!.agentL2SeedAckOverride = () => {
      throw new HostWsCommandResponseError(
        'fs_unavailable' as never,
        'EROFS: read-only file system',
        { hostId: 'host-remote-2', commandKind: 'agent_l2_seed', requestId: 'r' },
      );
    };

    const res = await http(t).post('/api/workspaces', {
      name: 'seed-fails',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(201);

    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed'),
    ).toHaveLength(0);
    const member = db
      .prepare('SELECT COUNT(*) as n FROM workspace_members WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(member.n).toBe(1);
  });

  it('owned SECOND local host (not co-located) + member → 201, ZERO provision', async () => {
    // D4.e-3 lifted the host-id co-location gate; §7-4 then removed provision +
    // eager seed, so a second owned local host succeeds like any other with a
    // pure-DB membership and no daemon traffic.
    t = buildTestApp();
    const hosts = new HostRepo(t.ctx.db);
    const second = hosts.claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    });
    expect(second.host.kind).toBe('local');
    expect(second.host.id).not.toBe(t.ctx.coLocatedHostId);

    const db = t.ctx.db;
    const now = Date.now();
    const agentId = 'agent-on-second-local';
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    ).run(agentId, 'secondagent', second.host.id, t.viewerUserId, now, now);

    const res = await http(t).post('/api/workspaces', {
      name: 'second-local-with-member',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(dataPlaneCalls(t).map(c => c.kind)).toEqual([]);
    const member = db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(body.workspace.id, agentId) as { n: number };
    expect(member.n).toBe(1);
  });
});
