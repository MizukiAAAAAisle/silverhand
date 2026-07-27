/**
 * Workspace POST / PATCH / DELETE / add-member placement preflight
 * regression pins.
 *
 * Origin: D4.c C3 — pre-C3 each of these routes short-circuited under
 * `standaloneMode(ctx)` with a typed `host_runtime_disabled` 409.
 * C3 lifts those guards and replaces them with explicit
 * placement preflights:
 *
 *   - POST /api/workspaces:
 *       * `workspace_path` in standalone → originally 409
 *         `workspace_path_not_supported`; **D4.e-1 3b lifted this** —
 *         the path is now forwarded to the owning daemon as
 *         `requested_path` (server does not interpret host paths).
 *       * default `workspace_host_id` resolves via
 *         `resolveOwnedLocalForUser` (the C1-installed 0/1/N
 *         policy). The synthetic `STANDALONE_SERVER` host row is
 *         no longer minted.
 *       * cross-host `member_agent_ids` are ACCEPTED (#task:1600 —
 *         both entry gates lifted); guest members pathless-provision
 *         + seed on their own daemons before any membership row.
 *
 *   - PATCH /api/workspaces/:id and DELETE /api/workspaces/:id:
 *       * Cross-computer slice 2 (#task:1600) REMOVED the old
 *         `assertWorkspaceAgentsMatchHost` preflight — a member agent
 *         on another computer is a legal state, so metadata writes and
 *         the delete cascade proceed regardless of member hosts
 *         (runtime stops route per agent; no daemon-side files are
 *         removed, guest local roots stay behind as locally-retained
 *         orphans awaiting future explicit local cleanup).
 *
 *   - POST /api/workspaces and POST /api/workspaces/:id/members:
 *       * #task:1600 final piece LIFTED both cross-computer product
 *         entry gates: members on other computers are accepted; their
 *         L2 seeds plan pathless ensures on the member's own daemon
 *         (`cross-computer-membership.test.ts` pins the data paths).
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

  it('POST /api/workspaces (standalone) — `workspace_path` is forwarded to the daemon as `requested_path` (D4.e-1: server no longer rejects it)', async () => {
    // D4.e-1 3b lifted the standalone `workspace_path_not_supported` 409.
    // Path authority moved to the owning daemon: the server does not
    // interpret the path, it forwards it as `requested_path` to
    // `workspace_provision` and the daemon re-validates + binds it. So a
    // caller path is legitimate in standalone too.
    t = buildTestApp({ deploymentMode: 'standalone' });
    const res = await http(t).post('/api/workspaces', {
      name: 'with-path',
      workspace_path: '/tmp/some-arbitrary-path',
    });

    expect(res.status).toBe(201);
    // The daemon received the caller path verbatim as `requested_path`.
    const provisionCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'workspace_provision',
    );
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]!.params).toMatchObject({
      kind: 'regular',
      requested_path: '/tmp/some-arbitrary-path',
    });
    // The persisted row caches the daemon's authoritative bound path.
    const body = (await res.json()) as any;
    expect(body.workspace.workspace_path).toBe('/tmp/some-arbitrary-path');
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

  it('POST /api/workspaces — omitted workspace_host_id fails closed when the creator has ≥2 active local hosts (#task:1221)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    new HostRepo(t.ctx.db).claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    });

    const res = await http(t).post('/api/workspaces', {
      name: 'workspace-host-ambiguous',
      member_agent_ids: [],
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'local_host_ambiguous' });
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision'),
    ).toHaveLength(0);
  });

  it('POST /api/workspaces — explicit owned+active workspace_host_id disambiguates placement (#task:1221)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const hosts = new HostRepo(t.ctx.db);
    const target = hosts.getOwnedLocalForUser(t.viewerUserId);
    expect(target).not.toBeNull();
    hosts.claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    });

    const res = await http(t).post('/api/workspaces', {
      name: 'workspace-explicit-host',
      workspace_host_id: target!.id,
      member_agent_ids: [],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.workspace.workspace_host_id).toBe(target!.id);
    const provisionCalls = t.fakeHostWs!.calls.filter(
      c => c.kind === 'workspace_provision',
    );
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]!.hostId).toBe(target!.id);
  });

  it('POST /api/workspaces (standalone) — cross-host `member_agent_ids` are ACCEPTED (#task:1600 gate lifted): membership lands, guest ensure is pathless', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Direct DB insert: in standalone, POST /api/agents is still
    // gated by `host_runtime_disabled` (defer to D4.d). Seeding the
    // cross-computer agent via DB is sufficient and avoids
    // cross-route coupling.
    //
    // #task:1681 — the guest agent is the CREATOR's OWN, on a second computer
    // they own: enrollment authority is the creator (a teammate's agent is
    // refused regardless of host, pinned in
    // tests/routes/workspace-agent-enrollment.test.ts), while the axis under
    // test here is the HOST. Two ready owned computers make placement
    // ambiguous, so the home one is named explicitly.
    const hosts = new HostRepo(t.ctx.db);
    const homeHost = hosts.getOwnedLocalForUser(t.viewerUserId)!;
    const guestHost = hosts.claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    }).host;
    const agentId = `cross-host-create-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host-create', guestHost.id, t.viewerUserId, now, now);

    const res = await http(t).post('/api/workspaces', {
      name: 'standalone-cross-host-ok',
      workspace_host_id: homeHost.id,
      member_agent_ids: [agentId],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    // Membership landed for the guest agent.
    const memberRow = t.ctx.db
      .prepare<[string, string], { agent_id: string }>(
        'SELECT agent_id FROM workspace_members WHERE workspace_id = ? AND agent_id = ?',
      )
      .get(body.workspace.id, agentId);
    expect(memberRow).toBeDefined();
    // The guest ensure ran on the AGENT's daemon WITHOUT the home path.
    const guestProvisions = t.fakeHostWs!.calls.filter(
      c =>
        c.kind === 'workspace_provision' &&
        c.hostId === guestHost.id &&
        c.params.workspace_id === body.workspace.id,
    );
    expect(guestProvisions).toHaveLength(1);
    expect('requested_path' in guestProvisions[0]!.params).toBe(false);
  });

  // ── PATCH /api/workspaces/:id ───────────────────────────────

  it('PATCH /api/workspaces/:id — cross-computer member agent is LEGAL: metadata write proceeds (#task:1600 reclassification)', async () => {
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
    // directly via DB (the add-member PRODUCT ENTRY GATE is still
    // closed, so this state is forged the way a post-gate-lift
    // deployment would produce it legitimately).
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

    const res = await http(t).patch(`/api/workspaces/${ws.workspace.id}`, {
      name: 'patch-renamed',
    });

    // #task:1600: the old preflight 409 is gone — the rename succeeds
    // even though a member agent lives on another computer.
    expect(res.status).toBe(200);
    const afterRow = t.ctx.db
      .prepare<[string], { name: string }>(
        'SELECT name FROM workspaces WHERE id = ?',
      )
      .get(ws.workspace.id)!;
    expect(afterRow.name).toBe('patch-renamed');
  });

  // ── DELETE /api/workspaces/:id ──────────────────────────────
  it('DELETE /api/workspaces/:id — cross-computer member agent is LEGAL: delete cascade proceeds (#task:1600 reclassification)', async () => {
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

    // #task:1600: the old preflight 409 is gone — delete proceeds; rows
    // cascade; the agent row itself survives (agents are not workspace
    // property). No daemon-side files are touched by delete, so a guest
    // computer's local root stays behind as a locally-retained orphan
    // awaiting future explicit local cleanup on that computer.
    expect(res.status).toBe(204);
    expect(
      t.ctx.db
        .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
        .get(ws.workspace.id),
    ).toBeUndefined();
    expect(
      t.ctx.db
        .prepare<[string], { id: string }>('SELECT id FROM agents WHERE id = ?')
        .get(agentId),
    ).toBeDefined();
  });

  // #task:1600 reclassification of the old Cindy round-1 P1 pin: a
  // cross-host agent attached to a NON-channel conversation kind
  // (dm_channel) is exactly as legal as one on a channel — PATCH and
  // DELETE both proceed. The kind-coverage concern the old preflight
  // pin protected is preserved in inverted form: no conversation kind
  // may smuggle a host-equality assumption back in.
  it('PATCH/DELETE — cross-host agent attached to a DM_CHANNEL is legal too (#task:1600, ex-Cindy round-1 P1)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    const viewerHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      t.viewerUserId,
    )!;
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'thread-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;
    expect(ws.workspace.workspace_host_id).toBe(viewerHost.id);

    // Direct-INSERT a dm_channel row (dm_channels have no parent
    // conversation). A non-channel conversation kind is what the
    // preflight must also cover; a raw INSERT gives us the row.
    const dmId = `cross-host-dm-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO conversations
          (id, workspace_id, workspace_path, kind,
title, status, spawned_by_agent_id, closed_at, close_summary,
           pinned_at, created_at, updated_at)
         VALUES (?, ?, ?, 'dm_channel', ?, 'idle', NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        dmId,
        ws.workspace.id,
        ws.workspace.workspace_path,
        'dm under workspace',
        now,
        now,
      );

    // Insert cross-host agent + attach to the dm_channel (NOT the
    // onboarding channel). The pre-fix helper scanned channels
    // only and would miss this row.
    const agentId = `cross-host-thread-agent-${Date.now()}`;
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host-th', teammateHost.id, 'teammate', now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, status, joined_at)
         VALUES (?, ?, 'idle', ?)`,
      )
      .run(dmId, agentId, now);

    // PATCH proceeds despite the cross-host dm_channel member.
    const patchRes = await http(t).patch(`/api/workspaces/${ws.workspace.id}`, {
      name: 'thread-rename-ok',
    });
    expect(patchRes.status).toBe(200);
    expect(
      t.ctx.db
        .prepare<[string], { name: string }>(
          'SELECT name FROM workspaces WHERE id = ?',
        )
        .get(ws.workspace.id)!.name,
    ).toBe('thread-rename-ok');

    // DELETE proceeds too; the workspace and its dm_channel cascade away,
    // the agent row survives.
    const delRes = await http(t).del(`/api/workspaces/${ws.workspace.id}`);
    expect(delRes.status).toBe(204);
    expect(
      t.ctx.db
        .prepare<[string], { id: string }>('SELECT id FROM workspaces WHERE id = ?')
        .get(ws.workspace.id),
    ).toBeUndefined();
    expect(
      t.ctx.db
        .prepare<[string], { id: string }>(
          'SELECT id FROM conversations WHERE id = ?',
        )
        .get(dmId),
    ).toBeUndefined();
    expect(
      t.ctx.db
        .prepare<[string], { id: string }>('SELECT id FROM agents WHERE id = ?')
        .get(agentId),
    ).toBeDefined();
  });

  // ── POST /api/workspaces/:id/members ────────────────────────

  it('POST /api/workspaces/:id/members — cross-host agent is ACCEPTED (#task:1600 gate lifted); the HOME-path L2 dir is never created server-side', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Direct DB insert (standalone POST /api/agents is still
    // gated; see comment on the POST workspace cross-host test).
    // #task:1681 — own agent on a second owned computer: creator = enrollment
    // authority, host = the axis under test. Home computer named explicitly
    // because two ready owned computers are ambiguous for placement.
    const hosts = new HostRepo(t.ctx.db);
    const homeHost = hosts.getOwnedLocalForUser(t.viewerUserId)!;
    const guestHost = hosts.claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    }).host;
    const agentId = `cross-host-add-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, 'cross-host-add', guestHost.id, t.viewerUserId, now, now);

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'add-member-cross-host',
      workspace_host_id: homeHost.id,
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

    // D4.e-3: L2 seeding is daemon-mediated; the would-be L2 dir lives at
    // `<workspace_path>/.silverhand/agents/<agentId>`. Snapshot the path — it
    // MUST NOT exist after a rejected add-member.
    const expectedL2Dir = join(
      ws.workspace.workspace_path,
      '.silverhand',
      'agents',
      agentId,
    );
    expect(existsSync(expectedL2Dir)).toBe(false);

    t.fakeHostWs!.calls.length = 0;
    // Pure ack for the guest seed: the shared embedded test fs conflates
    // "both computers" onto one disk, so the default fake seed would write
    // under the same path a real guest daemon would keep on ITS machine.
    // What this pin protects is that the SERVER writes nothing.
    t.fakeHostWs!.agentL2SeedAckOverride = () =>
      ({ ok: true as const, seeded: true }) as any;
    const res = await http(t).post(
      `/api/workspaces/${ws.workspace.id}/members`,
      { agent_id: agentId },
    );

    expect(res.status).toBe(201);
    // The seed went to the GUEST daemon (agent's own computer), pathless
    // ensure first; the HOME computer's workspace path gains no L2 dir —
    // the guest L2 lives under the guest daemon's managed root.
    const seed = t.fakeHostWs!.calls.find(c => c.kind === 'agent_l2_seed');
    expect(seed).toBeDefined();
    expect(seed!.hostId).toBe(guestHost.id);
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
