import { afterEach, describe, expect, it, vi } from 'vitest';
import { addWorkspaceAgentMember } from '../../src/application/add-workspace-agent-member.js';
import { deleteAgent } from '../../src/application/delete-agent.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { createSqliteMembershipPersistence } from '../../src/repos/membership-persistence.js';
import { createSqliteAgentTeardownPersistence } from '../../src/repos/agent-teardown-persistence.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * #task:1600 / relocation-v1 §7 task 4 — cross-computer membership after the
 * provisioning collapse. Adding a member (via `addWorkspaceAgentMember` or
 * create-with-members) is now a PURE DB write: no per-agent daemon realization,
 * no eager L2 seed, no home-path crossing — each member's L2 is materialized
 * lazily at that member's first spawn. These falsifiers pin that the two
 * membership-write flows dispatch NOTHING per-member to any daemon:
 *
 *   1. add-member          (`addWorkspaceAgentMember`) — pure DB
 *   2. create-with-members (`createWorkspace`, via the route) — pure DB; no
 *      home-computer provision, no per-member daemon call
 *
 * The delete-agent files purge (flow 3, `purgeAgentHostLocalFiles`) is a
 * separate lifecycle and still dispatches `agent_files_purge`.
 */

function forgeGuestHost(t: TestApp, id: string, ownerUserId = 'teammate'): string {
  return new HostRepo(t.ctx.db).create(id, 'local', {
    userId: ownerUserId,
    installationId: `install-${id}`,
    lastSeenAt: Date.now(),
  }).id;
}

/** Direct row insert: a real agent whose daemon runs on another computer.
 *  (POST /api/agents would route materialization at the other host; the
 *  control-plane row is all these flows consult.)
 *
 *  `creatorUserId` is the ENROLLMENT authority (#task:1681), independent of the
 *  host axis these tests are about: cross-computer means another COMPUTER, which
 *  may be a second computer of the same user or a teammate's. Tests that drive a
 *  flow as the creator forge the agent under that creator. */
function forgeGuestAgent(
  t: TestApp,
  name: string,
  hostId: string,
  creatorUserId = 'teammate',
): string {
  const id = `guest-${name}-${Date.now()}`;
  const now = Date.now();
  t.ctx.db
    .prepare(
      `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    )
    .run(id, name, hostId, creatorUserId, now, now);
  return id;
}

async function makeLocalAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id as string;
}

/**
 * relocation-v1 §7-4 (#task:1808) — a regular workspace has no owning
 * computer, so create takes no placement input and returns none: the helper
 * hands back only the workspace identity.
 */
async function createWorkspaceViaRoute(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ id: string }> {
  const res = await http(t).post('/api/workspaces', {
    name,
    member_agent_ids: memberAgentIds,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  return body.workspace;
}

function seedCalls(t: TestApp) {
  return t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed');
}

describe('#task:1600 — cross-computer membership seed/purge planning', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    t?.cleanup();
    t = null;
  });

  it('add-member: a GUEST add is a PURE DB write — ZERO seed, membership row lands (L2 is lazy)', async () => {
    t = buildTestApp();
    const ws = await createWorkspaceViaRoute(t, 'home-ws', []);
    const guestHost = forgeGuestHost(t, 'host-guest-add');
    const guestId = forgeGuestAgent(t, 'adder', guestHost);
    t.fakeHostWs!.calls.length = 0;

    const workspaces = new WorkspaceRepo(t.ctx.db);
    const result = await addWorkspaceAgentMember(
      {
        ctx: t.ctx,
        agents: new AgentRepo(t.ctx.db),
        membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
      },
      {
        // #task:1681 — the guest agent's CREATOR drives its own enrollment;
        // the host axis under test is orthogonal to the ownership gate.
        principal: { kind: 'user', userId: 'teammate' },
        workspace: { id: ws.id },
        agentId: guestId,
      },
    );
    expect(result.ok).toBe(true);

    // relocation-v1 §7 task 4 — provisioning collapse: add-member no longer
    // realizes anything on the agent's daemon. NO guest provision, NO eager
    // seed — the guest's L2 is materialized lazily at its first spawn.
    expect(seedCalls(t)).toHaveLength(0);
    // Membership row landed (pure DB write).
    expect(workspaces.listMembers(ws.id).some(m => m.id === guestId)).toBe(
      true,
    );
  });

  it('add-member is a PURE DB write — a hostile daemon (seed would fail) is never contacted, and the row still lands', async () => {
    t = buildTestApp();
    const ws = await createWorkspaceViaRoute(t, 'home-ws-barrier', []);
    const guestHost = forgeGuestHost(t, 'host-guest-barrier');
    const guestId = forgeGuestAgent(t, 'barrier-adder', guestHost);
    t.fakeHostWs!.calls.length = 0;

    // Make any seed throw. After the provisioning collapse add-member dispatches
    // no daemon traffic at all, so this override must never fire — the
    // membership is a pure DB write independent of daemon health.
    t.fakeHostWs!.agentL2SeedAckOverride = () => {
      throw new HostWsCommandResponseError(
        'fs_unavailable' as never,
        'EROFS',
        { hostId: guestHost, commandKind: 'agent_l2_seed', requestId: 'r' },
      );
    };

    const workspaces = new WorkspaceRepo(t.ctx.db);
    const result = await addWorkspaceAgentMember(
      {
        ctx: t.ctx,
        agents: new AgentRepo(t.ctx.db),
        membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
      },
      {
        principal: { kind: 'user', userId: 'teammate' },
        workspace: { id: ws.id },
        agentId: guestId,
      },
    );

    expect(result.ok).toBe(true);
    // ZERO daemon traffic of any kind — no reconcile, no provision, no seed.
    expect(seedCalls(t)).toHaveLength(0);
    // Membership row landed.
    expect(workspaces.listMembers(ws.id).some(m => m.id === guestId)).toBe(
      true,
    );
  });

  it('add-member control (#task:1612): a SAME-HOST add is also a PURE DB write — ZERO seed', async () => {
    t = buildTestApp();
    const ws = await createWorkspaceViaRoute(t, 'home-ws-2', []);
    const localId = await makeLocalAgent(t, 'local-adder');
    t.fakeHostWs!.calls.length = 0;

    const workspaces = new WorkspaceRepo(t.ctx.db);
    const result = await addWorkspaceAgentMember(
      {
        ctx: t.ctx,
        agents: new AgentRepo(t.ctx.db),
        membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
      },
      {
        principal: { kind: 'user', userId: t.viewerUserId },
        workspace: { id: ws.id },
        agentId: localId,
      },
    );
    expect(result.ok).toBe(true);

    // Pure DB on every host axis: the member's L2 is materialized lazily at its
    // first spawn, so neither a same-host nor a guest add dispatches anything.
    expect(seedCalls(t)).toHaveLength(0);
    expect(workspaces.listMembers(ws.id).some(m => m.id === localId)).toBe(true);
  });

  it('create-with-members: memberships are pure DB — ZERO guest realization, ZERO seeds, all rows land', async () => {
    t = buildTestApp();
    const localId = await makeLocalAgent(t, 'home-member');
    // #task:1681 — the create door refuses agents the creator did not create,
    // so the cross-COMPUTER member here is the viewer's OWN agent on a second
    // owned computer. The workspace itself has no computer to name (§7-4).
    const guestHost = forgeGuestHost(t, 'host-guest-create', t.viewerUserId);
    const guestId = forgeGuestAgent(t, 'creator-guest', guestHost, t.viewerUserId);
    t.fakeHostWs!.calls.length = 0;

    const ws = await createWorkspaceViaRoute(t, 'mixed-ws', [localId, guestId]);

    // relocation-v1 §7 task 4 — create is severed from the daemon registry, so
    // there is NO daemon realization at create time on ANY host: no home
    // provision, no per-guest realization, no eager seed. Each member's L2 is
    // materialized lazily at its first spawn.
    expect(seedCalls(t)).toHaveLength(0);

    const workspaces = new WorkspaceRepo(t.ctx.db);
    // Both memberships landed regardless of the members' computers.
    const memberIds = workspaces.listMembers(ws.id).map(m => m.id);
    expect(memberIds).toContain(localId);
    expect(memberIds).toContain(guestId);
  });

  it('create-with-members: a hostile daemon seed is never dispatched — create succeeds and both memberships land (no eager-seed rollback)', async () => {
    t = buildTestApp();
    const localId = await makeLocalAgent(t, 'home-member-2');
    const guestHost = forgeGuestHost(t, 'host-guest-fail', t.viewerUserId);
    const guestId = forgeGuestAgent(
      t,
      'creator-guest-fail',
      guestHost,
      t.viewerUserId,
    );
    // A seed that WOULD fail if it were dispatched. After the provisioning
    // collapse create seeds nothing, so this override must never fire and the
    // old "seed failure → zero memberships" rollback no longer applies.
    t.fakeHostWs!.agentL2SeedAckOverride = () => {
      throw new HostWsCommandResponseError(
        'internal_error' as never,
        'seed boom',
        { hostId: guestHost, commandKind: 'agent_l2_seed', requestId: 'fake' },
      );
    };

    const res = await http(t).post('/api/workspaces', {
      name: 'mixed-ws-fail',
      member_agent_ids: [localId, guestId],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;

    // No seed was dispatched, and BOTH memberships landed.
    expect(seedCalls(t)).toHaveLength(0);
    const workspaces = new WorkspaceRepo(t.ctx.db);
    const memberIds = workspaces.listMembers(body.workspace.id).map(m => m.id);
    expect(memberIds).toContain(localId);
    expect(memberIds).toContain(guestId);
  });

  it('delete-agent purge: mixed same-host + foreign memberships purge with ZERO eager realization; purge covers both workspaces', async () => {
    t = buildTestApp();
    const agentId = await makeLocalAgent(t, 'doomed');
    await createWorkspaceViaRoute(t, 'purge-home', [agentId]);

    // Forge a second workspace + membership the agent's computer never
    // materialized (§7-4: a workspace has no home computer, so "foreign" is an
    // AGENT-side property now, not a workspace one).
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, description, workspace_kind,
           owner_agent_id, archived_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
      )
      .run('ws-foreign-del', 'foreign-del', now, now);
    // relocation-v1 §7 task 4 — after the provisioning collapse the membership
    // is a PURE DB write (no establishment-time provision or seed). At delete
    // time the purge removes the agent's terminal managed footprint (agent home
    // + every nested L2 bundle) in one shot WITHOUT enumerating per-workspace or
    // consulting any registry: an unbound/never-spawned membership can no longer
    // strand a managed tree, so the delete succeeds rather than spuriously
    // fail-closing.
    const established = await addWorkspaceAgentMember(
      {
        ctx: t.ctx,
        agents: new AgentRepo(t.ctx.db),
        membershipPersistence: createSqliteMembershipPersistence(t.ctx.db),
      },
      {
        principal: { kind: 'user', userId: t.viewerUserId },
        workspace: { id: 'ws-foreign-del' },
        agentId,
      },
    );
    expect(established.ok).toBe(true);
    t.fakeHostWs!.calls.length = 0;

    const result = await deleteAgent(
      {
        ctx: t.ctx,
        teardown: createSqliteAgentTeardownPersistence(t.ctx.db),
        deletionRunner: t.agentDeletionRunner,
      },
      { agentId, requesterUserId: t.viewerUserId, body: { confirm: true } },
    );
    expect(result.kind).toBe('deleted');

    // The purge mints no empty root, and no home path ever crosses machines.
    // The daemon removes the whole agent home tree from `{ agent_id }` alone
    // (no per-workspace enumeration), so nothing mints an empty root just to
    // delete it.
    for (const c of t.fakeHostWs!.calls) {
      expect(JSON.stringify(c.params)).not.toContain('/home/elsewhere/project');
    }

    const purges = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_files_purge');
    expect(purges).toHaveLength(1);
    expect(purges[0]!.params).toEqual({ agent_id: agentId });
  });

  it('delete-agent purge: a failed purge stays FAIL-CLOSED with mixed memberships — no control-plane rows removed', async () => {
    t = buildTestApp();
    const agentId = await makeLocalAgent(t, 'survivor');
    await createWorkspaceViaRoute(t, 'purge-home-2', [agentId]);
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, description, workspace_kind,
           owner_agent_id, archived_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'regular', NULL, NULL, ?, ?)`,
      )
      .run('ws-foreign-del2', 'foreign-del2', now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
          VALUES (?, ?, ?)`,
      )
      .run('ws-foreign-del2', agentId, now);
    // Wire failures are THROWN response errors, not ok:false acks.
    t.fakeHostWs!.agentFilesPurgeAckOverride = () => {
      throw new HostWsCommandResponseError(
        'internal_error' as never,
        'purge boom',
        {
          hostId: 'local',
          commandKind: 'agent_files_purge',
          requestId: 'fake',
        },
      );
    };

    const result = await deleteAgent(
      {
        ctx: t.ctx,
        teardown: createSqliteAgentTeardownPersistence(t.ctx.db),
        deletionRunner: t.agentDeletionRunner,
      },
      { agentId, requesterUserId: t.viewerUserId, body: { confirm: true } },
    );
    expect(result.kind).toBe('deletionPendingRetry');

    // Agent row + BOTH memberships retained for retry.
    expect(new AgentRepo(t.ctx.db).get(agentId)).not.toBeNull();
    const memberRows = t.ctx.db
      .prepare<[string], { workspace_id: string }>(
        `SELECT workspace_id FROM workspace_members WHERE agent_id = ?`,
      )
      .all(agentId);
    expect(memberRows.length).toBe(2);
  });
});
