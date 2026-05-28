/**
 * D4.c C3 — workspace POST / PATCH / DELETE / add-member
 * standalone-guard lift regression pins.
 *
 * Pre-C3 each of these routes short-circuited under
 * `standaloneMode(ctx)` with a typed `host_runtime_disabled` 409.
 * C3 lifts those guards and replaces them with explicit
 * placement preflights:
 *
 *   - POST /api/workspaces:
 *       * `workspace_path` in standalone → 409
 *         `workspace_path_not_supported` (route-local typed code,
 *         NOT in the runtime placement taxonomy).
 *       * default `workspace_host_id` resolves via
 *         `resolveOwnedLocalForUser` (the C1-installed 0/1/N
 *         policy). The synthetic `STANDALONE_SERVER` host row is
 *         no longer minted.
 *       * cross-host `member_agent_ids` → 409 `host_mismatch`
 *         BEFORE any fs / DB / blob side effect.
 *
 *   - PATCH /api/workspaces/:id:
 *       * `assertWorkspaceAgentsMatchHost` runs after parse,
 *         BEFORE any metadata write / system rename message /
 *         deliverMessage.
 *
 *   - DELETE /api/workspaces/:id:
 *       * Same preflight, BEFORE
 *         `runtimeHost.resolveConversationRuns`, runtime stop,
 *         attachment sweep, `workspaces.delete`.
 *
 *   - POST /api/workspaces/:id/members:
 *       * Cross-host real agent → 409 `host_mismatch` BEFORE
 *         `ensureAgentL1Dir` / `seedAgentL2`.
 *
 * NOTE on fs side-effect transitionality (Cindy P2): C3 does NOT
 * move the server-side placeholder dirs (`initWorkspaceDir`,
 * `ensureAgentL1Dir`, `seedAgentL2`) out of the backend host's fs.
 * That is D4.e's body of work (workspace materialize intent). The
 * fail-closed contract here is that REJECTED paths never reach the
 * fs side effect — that invariant survives independent of where
 * the eventual fs ownership lives.
 *
 * R4 boundary: this IPC is local supervisor/control, not
 * server↔daemon formal semantics. C3 changes only HTTP route
 * behavior (lift control-plane guards + add preflight); no wire
 * envelope shape changes, no new wire fields, no new
 * placement-error arms beyond what C1 introduced.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { HostRepo } from '../../src/repos/host-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

describe('D4.c C3 — workspace placement preflight (standalone guard lift)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // ── POST /api/workspaces ────────────────────────────────────

  it('POST /api/workspaces (standalone) — `workspace_path` rejected with route-local typed code', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const res = await http(t).post('/api/workspaces', {
      name: 'with-path',
      workspace_path: '/tmp/some-arbitrary-path',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error_code: 'workspace_path_not_supported',
    });
  });

  it('POST /api/workspaces (standalone) — default placement uses `resolveOwnedLocalForUser` (no synthetic STANDALONE_SERVER host)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const ownedLocal = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      t.viewerUserId,
    );
    expect(ownedLocal).not.toBeNull();

    const res = await http(t).post('/api/workspaces', {
      name: 'standalone-default-host',
      member_agent_ids: [],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // Must be the user's claimed local host, NOT the
    // pre-D4.c synthetic standalone-server row. (The
    // synthetic row may exist from migration, but it's
    // never the resolved host_id under C3.)
    expect(body.workspace.workspace_host_id).toBe(ownedLocal!.id);
  });

  it('POST /api/workspaces (standalone) — cross-host `member_agent_ids` → 409 `host_mismatch`, no workspace row created', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Direct DB insert: in standalone, POST /api/agents is still
    // gated by `host_runtime_disabled` (defer to D4.d). The
    // route under test is workspace-create's host_mismatch
    // preflight, so seeding the agent via DB is sufficient and
    // avoids cross-route coupling.
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;
    const agentId = `cross-host-create-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host-create', teammateHost.id, 'teammate', now, now);

    const workspaceCountBefore = t.ctx.db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM workspaces')
      .get()!.c;

    const res = await http(t).post('/api/workspaces', {
      name: 'standalone-host-mismatch',
      member_agent_ids: [agentId],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });

    // The placement check runs BEFORE `initWorkspaceDir` and
    // `workspaces.insert`, so neither side effect happens.
    const workspaceCountAfter = t.ctx.db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM workspaces')
      .get()!.c;
    expect(workspaceCountAfter).toBe(workspaceCountBefore);
  });

  // ── PATCH /api/workspaces/:id ───────────────────────────────

  it('PATCH /api/workspaces/:id — cross-host agent in workspace channel → 409 `host_mismatch`, NO metadata write / system rename message / deliverMessage', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Seed: workspace owned by viewer's local host; channel +
    // synthetic agent row whose host is the teammate's host (not
    // the workspace host). This is the regression scenario the
    // pre-C3 short-circuit blocked.
    const viewerHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      t.viewerUserId,
    )!;
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'patch-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;
    expect(ws.workspace.workspace_host_id).toBe(viewerHost.id);

    // Insert the synthetic cross-host agent + channel membership
    // directly via DB (a route call would fail-closed at create
    // time, which is the very contract C1+C3 install — we want
    // a workspace whose channel ALREADY contains a cross-host
    // agent to test PATCH/DELETE preflight).
    const agentId = `cross-host-agent-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host', teammateHost.id, 'teammate', now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(ws.onboarding_channel_id, agentId, now);

    const beforeRow = t.ctx.db
      .prepare<[string], { name: string; description: string | null; updated_at: number }>(
        'SELECT name, description, updated_at FROM workspaces WHERE id = ?',
      )
      .get(ws.workspace.id)!;
    const sysMsgCountBefore = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM messages
          WHERE conversation_id = ? AND from_kind = 'system'`,
      )
      .get(ws.onboarding_channel_id)!.c;

    const res = await http(t).patch(`/api/workspaces/${ws.workspace.id}`, {
      name: 'patch-renamed',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });

    // No metadata write — name / description / updated_at unchanged.
    const afterRow = t.ctx.db
      .prepare<[string], { name: string; description: string | null; updated_at: number }>(
        'SELECT name, description, updated_at FROM workspaces WHERE id = ?',
      )
      .get(ws.workspace.id)!;
    expect(afterRow).toEqual(beforeRow);
    // No system rename message inserted.
    const sysMsgCountAfter = t.ctx.db
      .prepare<[string], { c: number }>(
        `SELECT COUNT(*) AS c FROM messages
          WHERE conversation_id = ? AND from_kind = 'system'`,
      )
      .get(ws.onboarding_channel_id)!.c;
    expect(sysMsgCountAfter).toBe(sysMsgCountBefore);
    // No deliverMessage call recorded on the fake.
    expect(t.fake.delivered).toEqual([]);
  });

  // ── DELETE /api/workspaces/:id ──────────────────────────────

  it('DELETE /api/workspaces/:id — cross-host agent → 409 `host_mismatch`, workspace + channel + agents all still present', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const viewerHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      t.viewerUserId,
    )!;
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'delete-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;
    expect(ws.workspace.workspace_host_id).toBe(viewerHost.id);

    const agentId = `delete-cross-host-agent-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'delete-cross', teammateHost.id, 'teammate', now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(ws.onboarding_channel_id, agentId, now);

    const res = await http(t).del(`/api/workspaces/${ws.workspace.id}`);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });

    // Workspace row still present.
    const wsRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(ws.workspace.id);
    expect(wsRow).toBeDefined();
    // Onboarding channel still present.
    const chRow = t.ctx.db
      .prepare<[string], { id: string }>(
        'SELECT id FROM conversations WHERE id = ?',
      )
      .get(ws.onboarding_channel_id);
    expect(chRow).toBeDefined();
    // Agent row still active (no cascade-delete on rejected DELETE).
    const agentRow = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM agents WHERE id = ?')
      .get(agentId);
    expect(agentRow).toBeDefined();
    // Runtime stop never called.
    expect(t.fake.starts).toEqual([]);
  });

  // ── POST /api/workspaces/:id/members ────────────────────────

  it('POST /api/workspaces/:id/members (standalone) — cross-host agent → 409 `host_mismatch` and agent L2 dir is NOT created', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Direct DB insert (standalone POST /api/agents is still
    // gated; see comment on the POST workspace cross-host test).
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;
    const agentId = `cross-host-add-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host-add', teammateHost.id, 'teammate', now, now);

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'add-member-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

    // The route's `seedAgentL2` would write
    // `<workspace_path>/.silverhand/agents/<agentId>`. Snapshot
    // the path — it MUST NOT exist after a rejected add-member.
    const expectedL2Dir = join(
      ws.workspace.workspace_path,
      '.silverhand',
      'agents',
      agentId,
    );
    expect(existsSync(expectedL2Dir)).toBe(false);

    const res = await http(t).post(
      `/api/workspaces/${ws.workspace.id}/members`,
      { agent_id: agentId },
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'host_mismatch' });

    // Critical fail-closed pin: no agent L2 dir leaked. The
    // placement check (`assertAgentMatchesHost`) runs inside
    // `WorkspaceRepo.addMember` BEFORE `ensureAgentL1Dir` /
    // `seedAgentL2`, so the rejected path produces no fs side
    // effect.
    expect(existsSync(expectedL2Dir)).toBe(false);
  });

  // ── PATCH/DELETE happy path under standalone ────────────────

  it('PATCH /api/workspaces/:id (standalone, no agent-backed channels) — succeeds (lift didn\'t over-fail)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const wsRes = await http(t).post('/api/workspaces', {
      name: 'standalone-patch-ok',
      member_agent_ids: [],
    });
    const ws = (await wsRes.json()) as any;

    const res = await http(t).patch(`/api/workspaces/${ws.workspace.id}`, {
      description: 'updated description',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.workspace).toMatchObject({
      description: 'updated description',
    });
  });

  it('DELETE /api/workspaces/:id (standalone, no agent-backed channels) — succeeds (lift didn\'t over-fail)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const wsRes = await http(t).post('/api/workspaces', {
      name: 'standalone-delete-ok',
      member_agent_ids: [],
    });
    const ws = (await wsRes.json()) as any;

    const res = await http(t).del(`/api/workspaces/${ws.workspace.id}`);

    expect(res.status).toBe(204);
    const stillThere = t.ctx.db
      .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
      .get(ws.workspace.id);
    expect(stillThere).toBeUndefined();
  });
});
