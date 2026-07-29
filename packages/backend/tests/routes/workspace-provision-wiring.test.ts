/**
 * Workspace-create → `workspace_provision` wiring.
 *
 * Origin: D4.e-1 3b-1. The create route no longer does local fs
 * (validate / mkdir): it dispatches `workspace_provision` to the
 * owning daemon BEFORE inserting the row, and caches the daemon's
 * authoritative `bound_workspace_path` into the legacy
 * `workspace_path` column. Pins:
 *   1. no body path → provision dispatched with NO `requested_path` (daemon
 *      managed default); row caches the daemon-bound path.
 *   2. body `workspace_path` → forwarded verbatim as `requested_path`.
 *   3. daemon offline → 503 `host_attach_pending`, NO row inserted.
 *   4. typed daemon failure (`invalid_path`) → 400, NO row inserted.
 *   5. id agreement: the row id equals the `workspace_id` provisioned.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTestApp, http, type TestApp } from '../utils/app.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../../src/ws/host-ws-server.js';
import { WorkspaceRegistryReconciler } from '../../src/runtime/workspace-registry-reconcile.js';

describe('D4.e-1 3b-1 — workspace-create dispatches workspace_provision', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('no body path → provision with NO requested_path; row caches daemon bound path', async () => {
    t = buildTestApp();
    const res = await http(t).post('/api/workspaces', {
      name: 'managed-default',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    const calls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'workspace_provision',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toMatchObject({ kind: 'regular' });
    expect('requested_path' in calls[0]!.params).toBe(false);
    // Row id == provisioned workspace_id; column caches the bound path.
    expect(calls[0]!.params.workspace_id).toBe(body.workspace.id);
    expect(body.workspace.workspace_path).toContain(body.workspace.id);
  });

  it('body workspace_path → forwarded verbatim as requested_path', async () => {
    t = buildTestApp();
    // The fake daemon mkdir's the bound path (it shares the test fs), so use
    // a real creatable dir.
    const base = mkdtempSync(join(tmpdir(), 'd4e1-custom-'));
    const requested = join(base, 'ws');
    try {
      const res = await http(t).post('/api/workspaces', {
        name: 'custom-path',
        workspace_path: requested,
        member_agent_ids: [],
      });
      expect(res.status).toBe(201);
      const calls = t.fakeHostWs!.calls.filter(
        c => c.kind === 'workspace_provision',
      );
      expect(calls[0]!.params).toMatchObject({
        kind: 'regular',
        requested_path: requested,
      });
      const body = (await res.json()) as any;
      expect(body.workspace.workspace_path).toBe(requested);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('daemon offline → 503 host_attach_pending and NO row inserted', async () => {
    t = buildTestApp({ hostWsController: () => null });
    const before = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    const res = await http(t).post('/api/workspaces', {
      name: 'offline',
      member_agent_ids: [],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('host_attach_pending');
    const after = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('typed daemon failure (invalid_path) → 400 and NO row inserted', async () => {
    t = buildTestApp();
    t.fakeHostWs!.sendCommandErrorKinds = ['workspace_provision'];
    t.fakeHostWs!.sendCommandError = new HostWsCommandResponseError(
      'invalid_path' as never,
      'requested path must be absolute',
      { hostId: 'local', commandKind: 'workspace_provision', requestId: 'r' },
    );
    const before = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    const res = await http(t).post('/api/workspaces', {
      name: 'bad-path',
      workspace_path: 'relative/path',
      member_agent_ids: [],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('invalid_workspace_path');
    const after = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('transport timeout → 504 daemon_timeout (retriable), NO row inserted', async () => {
    t = buildTestApp();
    t.fakeHostWs!.sendCommandErrorKinds = ['workspace_provision'];
    t.fakeHostWs!.sendCommandError = new HostWsCommandTransportError(
      'transport_timeout',
      'timed out',
      { hostId: 'local', commandKind: 'workspace_provision', requestId: 'r' },
    );
    const res = await http(t).post('/api/workspaces', {
      name: 'slow',
      member_agent_ids: [],
    });
    expect(res.status).toBe(504);
    expect(((await res.json()) as any).code).toBe('daemon_timeout');
  });

  it('embedded + owned REMOTE host + member → 201, daemon-mediated provision + agent_l2_seed, row + member persisted (D4.e-3 gate lifted)', async () => {
    // D4.e-3 — the co-location gate is GONE. Pre-D4.e-3 this combo (embedded
    // backend + a member on an owned REMOTE host) was refused 409 because the
    // create route seeded agent L2 on the BACKEND disk, which would have
    // written the remote daemon's path locally (I1 violation). Now L2 seeding
    // is daemon-mediated (`agent_l2_seed`): the owning daemon writes its OWN
    // host-local L2, so create-with-members is supported on every host. Cindy
    // ordering: the membership row lands ONLY AFTER the daemon seed succeeds.
    t = buildTestApp();
    const db = t.ctx.db;
    const userId = t.viewerUserId;
    const now = Date.now();
    // An owned, active REMOTE host (passes assertOwnedActiveHost; kind!=local).
    db.prepare(
      `INSERT INTO hosts
        (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at, activated_at, finalized_at, provisioning_source)
        VALUES (?, ?, 'remote', ?, ?, ?, NULL, ?, ?, ?, 'user_invite')`,
    ).run('host-remote-1', 'remote-1', userId, 'inst-1', now, now, now, now);
    // An agent on that remote host — survives the member filter + host-equality
    // check, so the request reaches the daemon-mediated seed.
    const agentId = 'agent-on-remote';
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    ).run(agentId, 'remoteagent', 'host-remote-1', userId, now, now);

    const res = await http(t).post('/api/workspaces', {
      name: 'remote-with-member',
      workspace_host_id: 'host-remote-1',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    // Provision + seed both dispatched to the owning (remote) host.
    const provisionCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'workspace_provision',
    );
    expect(provisionCalls).toHaveLength(1);
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(1);
    expect(seedCalls[0]!.hostId).toBe('host-remote-1');
    expect(seedCalls[0]!.params).toMatchObject({
      agent_id: agentId,
      workspace_id: body.workspace.id,
    });

    // Row persisted + membership recorded.
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

  it('member-seed failure → error and NO membership row (Cindy ordering red line)', async () => {
    // The membership row must NEVER be inserted when the daemon L2 seed fails —
    // no "member added but L2 not seeded" half-state. The workspace row may
    // remain (no 2PC required), but the member must not.
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

    // Provision succeeds; the L2 seed fails with a typed daemon wire error.
    t.fakeHostWs!.agentL2SeedAckOverride = () => {
      throw new HostWsCommandResponseError(
        'fs_unavailable' as never,
        'EROFS: read-only file system',
        { hostId: 'host-remote-2', commandKind: 'agent_l2_seed', requestId: 'r' },
      );
    };

    const res = await http(t).post('/api/workspaces', {
      name: 'seed-fails',
      workspace_host_id: 'host-remote-2',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('fs_unavailable');

    // No membership row for the agent whose seed failed.
    const member = db
      .prepare('SELECT COUNT(*) as n FROM workspace_members WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(member.n).toBe(0);
  });

  it('embedded + owned SECOND local host (NOT co-located) + member → 201, daemon-mediated (D4.e-3 gate lifted)', async () => {
    // D4.e-3 — pre-D4.e-3 a second owned `kind='local'` host (not the backend's
    // co-located one) was refused 409 by the host-id co-location gate. With
    // daemon-mediated seeding the owning daemon writes its OWN L2, so this now
    // succeeds like any other host.
    t = buildTestApp();
    const hosts = new HostRepo(t.ctx.db);
    // A second active local host owned by the viewer, distinct from the
    // backend's co-located `ensureLocal()` host.
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
      workspace_host_id: second.host.id,
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision'),
    ).toHaveLength(1);
    const seedCalls = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
    expect(seedCalls).toHaveLength(1);
    expect(seedCalls[0]!.hostId).toBe(second.host.id);
    const member = db
      .prepare(
        'SELECT COUNT(*) as n FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(body.workspace.id, agentId) as { n: number };
    expect(member.n).toBe(1);
  });
});

// ── #task:1719 — provision barrier (ready-generation reconcile gate) ──
//
// The create saga awaits `ctx.workspaceProvisionBarrier(host)` (REQUIRED port)
// BEFORE dispatching `workspace_provision`. A failed/pending reconcile maps
// to the SAME retryable 503-class `transportFailed` arm the daemon-offline
// path uses (code `registry_unavailable`, retriable) — no new HTTP wiring.
describe('#task:1719 — workspace-create awaits the registry reconcile barrier', () => {
  let t: TestApp | null = null;
  let reconciler: WorkspaceRegistryReconciler | null = null;
  afterEach(() => {
    reconciler?.close();
    reconciler = null;
    t?.cleanup();
    t = null;
  });

  function wireReconciler(app: TestApp): WorkspaceRegistryReconciler {
    // #task:1719 (Cindy round-2 P1) — the port is REQUIRED on ctx; this
    // helper swaps in a test-owned reconciler instance so the test can
    // close it deterministically. It replaces (never removes) the barrier.
    const built = new WorkspaceRegistryReconciler({
      db: app.ctx.db,
      adapter: () => app.ctx.outboundFrameAdapter?.() ?? null,
      logger: app.ctx.logger,
    });
    app.ctx.workspaceProvisionBarrier = hostId => built.barrier(hostId);
    return built;
  }

  it('reconcile failure → 503 registry_unavailable (retryable arm), NO provision dispatched, NO row inserted', async () => {
    t = buildTestApp();
    reconciler = wireReconciler(t);
    // The reconcile PULL times out on this daemon generation → the barrier
    // rejects with the typed pending error.
    t.fakeHostWs!.workspaceRegistryIdsAckOverride = () => {
      throw new HostWsCommandTransportError(
        'transport_timeout',
        'daemon did not answer the reconcile pull',
        { hostId: 'local' },
      );
    };
    const before = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };

    const res = await http(t).post('/api/workspaces', {
      name: 'barrier-blocked',
      member_agent_ids: [],
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).code).toBe('registry_unavailable');

    // Fail-closed: the provision never raced the pending reconcile and no
    // orphan row exists.
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision'),
    ).toEqual([]);
    const after = t.ctx.db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('reconcile success → provision proceeds (201) after the generation reconciled', async () => {
    t = buildTestApp();
    reconciler = wireReconciler(t);

    const res = await http(t).post('/api/workspaces', {
      name: 'barrier-passed',
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);

    // The barrier ran THIS generation's reconcile pull before provisioning.
    const kinds = t.fakeHostWs!.calls.map(c => c.kind);
    expect(kinds.indexOf('workspace_registry_ids')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('workspace_registry_ids')).toBeLessThan(
      kinds.indexOf('workspace_provision'),
    );
  });
});
