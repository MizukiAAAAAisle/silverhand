/**
 * D4.e-1 3b-1 — workspace-create → `workspace_provision` wiring.
 *
 * The create route no longer does local fs (validate / mkdir): it dispatches
 * `workspace_provision` to the owning daemon BEFORE inserting the row, and
 * caches the daemon's authoritative `bound_workspace_path` into the legacy
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

  it('embedded + owned REMOTE host + member → 409 workspace_member_seed_unsupported, NO provision, NO row (P1-1 co-location gate)', async () => {
    // D4.e-1 3b P1-1 (Cindy) — the initial-member seed gate is about
    // CO-LOCATION (embedded backend + local host), not deployment mode alone.
    // `assertOwnedActiveHost` accepts an owned `kind='remote'` host, so an
    // embedded caller passing `workspace_host_id=<owned remote>` + a member on
    // that remote host would otherwise reach the server-side `seedAgentL2`,
    // writing the remote daemon's path on the embedded box (I1 violation). The
    // gate must refuse it BEFORE provision — no orphan registry bind, no row.
    t = buildTestApp();
    const db = t.ctx.db;
    const userId = t.viewerUserId;
    const now = Date.now();
    // An owned, active REMOTE host (passes assertOwnedActiveHost; kind!=local).
    db.prepare(
      `INSERT INTO hosts
        (id, name, kind, user_id, installation_id, last_seen_at, revoked_at, created_at)
        VALUES (?, ?, 'remote', ?, ?, ?, NULL, ?)`,
    ).run('host-remote-1', 'remote-1', userId, 'inst-1', now, now);
    // An agent on that remote host — survives the member filter + host-equality
    // check, so the request reaches the co-location gate.
    const agentId = 'agent-on-remote';
    db.prepare(
      `INSERT INTO agents
        (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    ).run(agentId, 'remoteagent', 'host-remote-1', userId, now, now);

    const before = db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    const res = await http(t).post('/api/workspaces', {
      name: 'remote-with-member',
      workspace_host_id: 'host-remote-1',
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe(
      'workspace_member_seed_unsupported',
    );
    // No provision dispatched (refused before the daemon round-trip).
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision'),
    ).toHaveLength(0);
    const after = db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('embedded + owned SECOND local host (NOT co-located) + member → 409, NO provision, NO row (P1-2 co-location is host-id, not kind)', async () => {
    // D4.e-1 3b P1-2 (Cindy) — gating on `host.kind === 'local'` is not enough:
    // a user can own MULTIPLE active local hosts (a sandbox daemon, a second
    // desktop). Only the backend's OWN host (`ctx.coLocatedHostId`) shares its
    // disk. A second owned `kind='local'` host is NOT co-located, so seeding
    // its path locally would still be the I1 violation — the gate must refuse
    // it by exact host id, not kind.
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

    const before = db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    const res = await http(t).post('/api/workspaces', {
      name: 'second-local-with-member',
      workspace_host_id: second.host.id,
      member_agent_ids: [agentId],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).code).toBe(
      'workspace_member_seed_unsupported',
    );
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision'),
    ).toHaveLength(0);
    const after = db
      .prepare('SELECT COUNT(*) as n FROM workspaces')
      .get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
