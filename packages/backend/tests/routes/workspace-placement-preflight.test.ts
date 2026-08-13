/**
 * Workspace POST / PATCH / DELETE / add-member preflight regression pins.
 *
 * Origin: D4.c C3 — pre-C3 each of these routes short-circuited under
 * `standaloneMode(ctx)` with a typed `host_runtime_disabled` 409.
 * C3 lifted those guards and replaced them with explicit placement
 * preflights. relocation-v1 §7-4 (#task:1808) then retired PLACEMENT
 * ITSELF: a regular workspace has no owning computer, so create resolves
 * no host, writes no host column, and can no longer return a placement
 * error. What this file still pins:
 *
 *   - POST /api/workspaces:
 *       * create resolves NO host: no 409 in standalone, no host
 *         resolution, no owning-computer pointer on the response — and
 *         specifically NO `local_host_ambiguous`, however many owned local
 *         computers the creator has: there is nothing left to disambiguate.
 *         (§6's atomic epoch cut removed the `workspace_path` /
 *         `workspace_host_id` create INPUTS from the contract outright, so
 *         there is no accepted-but-ignored input left to pin either.)
 *       * cross-host `member_agent_ids` are ACCEPTED (#task:1600 —
 *         both entry gates lifted); membership is a pure DB write and each
 *         member's L2 materializes lazily at its own first spawn.
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
 *         entry gates: members on other computers are accepted; after the
 *         §7-4 provisioning collapse neither door seeds anything
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

describe('D4.c C3 — workspace route preflights (standalone guard lift)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  // ── POST /api/workspaces ────────────────────────────────────

  it('POST /api/workspaces (standalone) — create resolves NO placement: the response carries no owning computer (§7-4)', async () => {
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
    // relocation-v1 §7-4 — placement is retired, not merely defaulted: the
    // workspace has no owning computer, so the DTO exposes no host pointer at
    // all (the pre-C3 synthetic `STANDALONE_SERVER` row, the C1
    // `resolveOwnedLocalForUser` default and the `workspace_host_id` field
    // itself are all gone).
    expect(body.workspace.workspace_host_id).toBeUndefined();
  });

  it('POST /api/workspaces — ≥2 active local hosts is NOT ambiguous any more: create succeeds (§7-4 retires placement)', async () => {
    // Inverted #task:1221 pin: the old 409 `local_host_ambiguous` defended a
    // placement decision create no longer makes. With two owned ready
    // computers and no `workspace_host_id` there is nothing to disambiguate,
    // so the create must succeed rather than fail closed. (The same typed code
    // still guards AGENT placement, which really does pick a computer —
    // `tests/routes/agent-placement*.test.ts`.)
    t = buildTestApp({ deploymentMode: 'standalone' });
    new HostRepo(t.ctx.db).claimOrCreateLocal({
      userId: t.viewerUserId,
      installationId: 'second-desktop',
    });

    const res = await http(t).post('/api/workspaces', {
      name: 'workspace-host-ambiguous',
      member_agent_ids: [],
    });

    expect(res.status).toBe(201);
  });

  it('POST /api/workspaces (standalone) — cross-host `member_agent_ids` are ACCEPTED (#task:1600 gate lifted): membership lands, no seed', async () => {
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
    // test here is the member's HOST. The workspace itself has no computer to
    // name (§7-4), so nothing is passed for placement.
    const hosts = new HostRepo(t.ctx.db);
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
    // relocation-v1 §7 task 4 — the provisioning collapse: create-with-members
    // does NO realization on ANY host — no provision, no per-guest realization,
    // no eager seed. Each member's L2 is materialized lazily at its first spawn.
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed'),
    ).toHaveLength(0);
  });

  // ── PATCH /api/workspaces/:id ───────────────────────────────

  it('PATCH /api/workspaces/:id — cross-computer member agent is LEGAL: metadata write proceeds (#task:1600 reclassification)', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Seed: workspace owned by viewer's local host; channel +
    // synthetic agent row whose host is the teammate's host (not
    // the workspace host). This is the regression scenario the
    // pre-C3 short-circuit blocked.
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'patch-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

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
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'delete-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

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
    const teammateHost = new HostRepo(t.ctx.db).getOwnedLocalForUser(
      'teammate',
    )!;

    const wsRes = await http(t).post('/api/workspaces', {
      name: 'thread-cross-host',
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

    // Direct-INSERT a dm_channel row (dm_channels have no parent
    // conversation). A non-channel conversation kind is what the
    // preflight must also cover; a raw INSERT gives us the row.
    const dmId = `cross-host-dm-${Date.now()}`;
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO conversations
          (id, workspace_id, placement_kind, roster_policy,
title, status, spawned_by_agent_id, closed_at, close_summary,
           pinned_at, created_at, updated_at)
         VALUES (?, ?, 'workspace', 'fixed', ?, 'idle', NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        dmId,
        ws.workspace.id,
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

  it('POST /api/workspaces/:id/members — cross-host agent is ACCEPTED (#task:1600 gate lifted); pure DB write, NO seed, HOME-path L2 dir never created server-side', async () => {
    t = buildTestApp({ deploymentMode: 'standalone' });
    // Direct DB insert (standalone POST /api/agents is still
    // gated; see comment on the POST workspace cross-host test).
    // #task:1681 — own agent on a second owned computer: creator = enrollment
    // authority, the member's host = the axis under test. The workspace itself
    // has no computer to name (§7-4), so nothing is passed for placement.
    const hosts = new HostRepo(t.ctx.db);
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
      member_agent_ids: [],
    });
    expect(wsRes.status).toBe(201);
    const ws = (await wsRes.json()) as any;

    // D4.e-3: L2 seeding is daemon-mediated. This is the LEGACY bound-path
    // shape (`<workspace path>/.silverhand/agents/<agentId>`) under the test
    // `.silverhand` root: §7-3/§7-4 retired both the `workspace_path` DTO field
    // and the registry that bound it, so nothing derives this path any more.
    // It is kept as a negative pin that member-add writes NO server-side bytes
    // at all — neither here nor at the agent-centric bundle coordinate, which
    // only the member's own daemon may create at first spawn.
    const expectedL2Dir = join(
      t.silverhandDir,
      'workspaces',
      ws.workspace.id,
      '.silverhand',
      'agents',
      agentId,
    );
    expect(existsSync(expectedL2Dir)).toBe(false);

    t.fakeHostWs!.calls.length = 0;
    // A seed that WOULD fire if member-add still dispatched one — after the
    // relocation-v1 §7 task 4 provisioning collapse it must never fire: the
    // guest's L2 is materialized lazily at its first spawn, not here.
    t.fakeHostWs!.agentL2SeedAckOverride = () =>
      ({ ok: true as const, seeded: true }) as any;
    const res = await http(t).post(
      `/api/workspaces/${ws.workspace.id}/members`,
      { agent_id: agentId },
    );

    expect(res.status).toBe(201);
    // Pure DB write: no seed of any kind crossed to any daemon, and the HOME
    // computer's workspace path gains no L2 dir.
    expect(
      t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed'),
    ).toHaveLength(0);
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
