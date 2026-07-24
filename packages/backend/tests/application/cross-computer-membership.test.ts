import { afterEach, describe, expect, it, vi } from 'vitest';
import { addWorkspaceAgentMember } from '../../src/application/add-workspace-agent-member.js';
import { deleteAgent } from '../../src/application/delete-agent.js';
import { AgentRepo } from '../../src/repos/agent-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationInboxRepo } from '../../src/repos/conversation-inbox-repo.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { WorkspaceRepo } from '../../src/repos/workspace-repo.js';
import { HostWsCommandResponseError } from '../../src/ws/host-ws-server.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * #task:1600 — cross-computer membership falsifiers for the pathless-guest
 * contract (#task:1596): a workspace's HOME-computer `workspace_path` must
 * NEVER cross machines as a guest daemon's `requested_path`, in any of the
 * three flows that plan registry-ensure rows per agent:
 *
 *   1. add-member L2 seed        (`addWorkspaceAgentMember`)
 *   2. create-with-members seeds (`createWorkspace`, via the route)
 *   3. delete-agent files purge  (`purgeAgentHostLocalFiles`)
 *
 * The two membership PRODUCT ENTRY GATES were lifted by the final slice-2
 * piece (these started as Cindy's "gate-lifted preview" tests with a
 * no-oped placement assert; the real lift made them plain end-to-end
 * tests over the open product paths). Flow 3 never had a gate.
 */

function forgeGuestHost(t: TestApp, id: string): string {
  return new HostRepo(t.ctx.db).create(id, 'local', {
    userId: 'teammate',
    installationId: `install-${id}`,
    lastSeenAt: Date.now(),
  }).id;
}

/** Direct row insert: a real agent whose daemon runs on another computer.
 *  (POST /api/agents would route materialization at the other host; the
 *  control-plane row is all these flows consult.) */
function forgeGuestAgent(t: TestApp, name: string, hostId: string): string {
  const id = `guest-${name}-${Date.now()}`;
  const now = Date.now();
  t.ctx.db
    .prepare(
      `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'claude', ?, ?, ?, ?)`,
    )
    .run(id, name, hostId, 'teammate', now, now);
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

async function createWorkspaceViaRoute(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ id: string; workspace_path: string; workspace_host_id: string }> {
  const res = await http(t).post('/api/workspaces', {
    name,
    member_agent_ids: memberAgentIds,
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  return body.workspace;
}

function provisionCalls(t: TestApp) {
  return t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision');
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

  it('add-member: a GUEST add ensures PATHLESS on the agent daemon, seeds after, and never rewrites the home path cache', async () => {
    t = buildTestApp();
    const ws = await createWorkspaceViaRoute(t, 'home-ws', []);
    const guestHost = forgeGuestHost(t, 'host-guest-add');
    const guestId = forgeGuestAgent(t, 'adder', guestHost);
    t.fakeHostWs!.calls.length = 0;

    const workspaces = new WorkspaceRepo(t.ctx.db);
    const result = await addWorkspaceAgentMember(
      { ctx: t.ctx, agents: new AgentRepo(t.ctx.db), workspaces },
      {
        workspace: {
          id: ws.id,
          workspace_path: ws.workspace_path,
          workspace_host_id: ws.workspace_host_id,
        },
        agentId: guestId,
      },
    );
    expect(result.ok).toBe(true);

    // Exactly one guest ensure, PATHLESS, on the AGENT's computer.
    const provisions = provisionCalls(t);
    expect(provisions).toHaveLength(1);
    expect(provisions[0]!.hostId).toBe(guestHost);
    expect('requested_path' in provisions[0]!.params).toBe(false);
    // Seed follows the provision, on the same guest daemon.
    const seeds = seedCalls(t);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.hostId).toBe(guestHost);
    expect(
      t.fakeHostWs!.calls.indexOf(seeds[0]!),
    ).toBeGreaterThan(t.fakeHostWs!.calls.indexOf(provisions[0]!));
    // The guest bind's ack must NOT overwrite the home computer's path.
    expect(workspaces.get(ws.id)!.workspace_path).toBe(ws.workspace_path);
    // Membership row landed.
    expect(workspaces.listMembers(ws.id).some(m => m.id === guestId)).toBe(
      true,
    );
  });

  it('add-member control: a SAME-HOST add re-binds with the legacy home path', async () => {
    t = buildTestApp();
    const ws = await createWorkspaceViaRoute(t, 'home-ws-2', []);
    const localId = await makeLocalAgent(t, 'local-adder');
    t.fakeHostWs!.calls.length = 0;

    const workspaces = new WorkspaceRepo(t.ctx.db);
    const result = await addWorkspaceAgentMember(
      { ctx: t.ctx, agents: new AgentRepo(t.ctx.db), workspaces },
      {
        workspace: {
          id: ws.id,
          workspace_path: ws.workspace_path,
          workspace_host_id: ws.workspace_host_id,
        },
        agentId: localId,
      },
    );
    expect(result.ok).toBe(true);

    const provisions = provisionCalls(t);
    expect(provisions).toHaveLength(1);
    expect(provisions[0]!.hostId).toBe(ws.workspace_host_id);
    expect(provisions[0]!.params.requested_path).toBe(ws.workspace_path);
  });

  it('create-with-members: mixed members seed on their OWN daemons — guest pathless, home path never crosses', async () => {
    t = buildTestApp();
    const localId = await makeLocalAgent(t, 'home-member');
    const guestHost = forgeGuestHost(t, 'host-guest-create');
    const guestId = forgeGuestAgent(t, 'creator-guest', guestHost);
    t.fakeHostWs!.calls.length = 0;

    const ws = await createWorkspaceViaRoute(t, 'mixed-ws', [
      localId,
      guestId,
    ]);

    const provisions = provisionCalls(t);
    // Home computer: exactly ONE provision (the create itself); same-host
    // member seeds reuse it (ensureProvisioned:false) — no re-ensure.
    const homeProvisions = provisions.filter(
      c => c.hostId === ws.workspace_host_id,
    );
    expect(homeProvisions).toHaveLength(1);
    // Guest computer: exactly ONE pathless ensure before its seed.
    const guestProvisions = provisions.filter(c => c.hostId === guestHost);
    expect(guestProvisions).toHaveLength(1);
    expect('requested_path' in guestProvisions[0]!.params).toBe(false);

    const seeds = seedCalls(t);
    const seedHostByAgent = new Map(
      seeds.map(c => [c.params.agent_id as string, c.hostId]),
    );
    expect(seedHostByAgent.get(localId)).toBe(ws.workspace_host_id);
    expect(seedHostByAgent.get(guestId)).toBe(guestHost);
    expect(
      t.fakeHostWs!.calls.indexOf(seeds.find(s => s.params.agent_id === guestId)!),
    ).toBeGreaterThan(t.fakeHostWs!.calls.indexOf(guestProvisions[0]!));

    // Home path cache untouched by the guest bind.
    const workspaces = new WorkspaceRepo(t.ctx.db);
    expect(workspaces.get(ws.id)!.workspace_path).toBe(ws.workspace_path);
    // Both memberships landed.
    const memberIds = workspaces.listMembers(ws.id).map(m => m.id);
    expect(memberIds).toContain(localId);
    expect(memberIds).toContain(guestId);
  });

  it('create-with-members: a failed GUEST seed leaves ZERO agent memberships (all-or-nothing invariant survives the axis change)', async () => {
    t = buildTestApp();
    const localId = await makeLocalAgent(t, 'home-member-2');
    const guestHost = forgeGuestHost(t, 'host-guest-fail');
    const guestId = forgeGuestAgent(t, 'creator-guest-fail', guestHost);
    // Wire failures are THROWN response errors, not ok:false acks.
    t.fakeHostWs!.agentL2SeedAckOverride = params => {
      if (params.agent_id === guestId) {
        throw new HostWsCommandResponseError(
          'internal_error' as never,
          'seed boom',
          { hostId: guestHost, commandKind: 'agent_l2_seed', requestId: 'fake' },
        );
      }
      return { ok: true as const, seeded: true } as any;
    };

    const res = await http(t).post('/api/workspaces', {
      name: 'mixed-ws-fail',
      member_agent_ids: [localId, guestId],
    });
    expect(res.status).toBeGreaterThanOrEqual(500);

    // No PARTIAL set: neither the local nor the guest membership landed.
    const workspaces = new WorkspaceRepo(t.ctx.db);
    const created = t.ctx.db
      .prepare<[], { id: string }[] | undefined>(
        `SELECT id FROM workspaces WHERE name = 'mixed-ws-fail'`,
      )
      .get() as { id: string } | undefined;
    if (created) {
      expect(workspaces.listMembers(created.id)).toEqual([]);
    }
  });

  it('delete-agent purge: mixed memberships plan same-host WITH the home path and foreign PATHLESS; purge covers both workspaces', async () => {
    t = buildTestApp();
    const agentId = await makeLocalAgent(t, 'doomed');
    const homeWs = await createWorkspaceViaRoute(t, 'purge-home', [agentId]);

    // Forge a FOREIGN workspace + membership (legal cross-computer state).
    const guestHost = forgeGuestHost(t, 'host-guest-del');
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path,
           workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run('ws-foreign-del', 'foreign-del', '/home/elsewhere/project', guestHost, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
          VALUES (?, ?, ?)`,
      )
      .run('ws-foreign-del', agentId, now);
    t.fakeHostWs!.calls.length = 0;

    const result = await deleteAgent(
      {
        ctx: t.ctx,
        agents: new AgentRepo(t.ctx.db),
        workspaces: new WorkspaceRepo(t.ctx.db),
        conversations: new ConversationRepo(t.ctx.db),
        conversationInboxes: new ConversationInboxRepo(t.ctx.db),
      },
      { agentId, requesterUserId: t.viewerUserId, body: { confirm: true } },
    );
    expect(result.kind).toBe('deleted');

    // Purge runs on the AGENT's computer only; both ensure rows are planned
    // there: home ws with its legacy path, foreign ws PATHLESS — the foreign
    // home path (`/home/elsewhere/project`) must never appear.
    const provisions = provisionCalls(t);
    const byWorkspace = new Map(
      provisions.map(c => [c.params.workspace_id as string, c]),
    );
    const homeCall = byWorkspace.get(homeWs.id);
    expect(homeCall).toBeDefined();
    expect(homeCall!.params.requested_path).toBe(homeWs.workspace_path);
    const foreignCall = byWorkspace.get('ws-foreign-del');
    expect(foreignCall).toBeDefined();
    expect('requested_path' in foreignCall!.params).toBe(false);
    for (const c of provisions) {
      expect(JSON.stringify(c.params)).not.toContain('/home/elsewhere/project');
    }

    const purges = t.fakeHostWs!.calls.filter(c => c.kind === 'agent_files_purge');
    expect(purges).toHaveLength(1);
    expect(purges[0]!.params.workspace_ids).toEqual(
      expect.arrayContaining([homeWs.id, 'ws-foreign-del']),
    );
  });

  it('delete-agent purge: a failed purge stays FAIL-CLOSED with mixed memberships — no control-plane rows removed', async () => {
    t = buildTestApp();
    const agentId = await makeLocalAgent(t, 'survivor');
    await createWorkspaceViaRoute(t, 'purge-home-2', [agentId]);
    const guestHost = forgeGuestHost(t, 'host-guest-del2');
    const now = Date.now();
    t.ctx.db
      .prepare(
        `INSERT INTO workspaces
          (id, name, description, workspace_kind, workspace_path,
           workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
          VALUES (?, ?, NULL, 'regular', ?, ?, NULL, NULL, ?, ?)`,
      )
      .run('ws-foreign-del2', 'foreign-del2', '/home/elsewhere/p2', guestHost, now, now);
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
        agents: new AgentRepo(t.ctx.db),
        workspaces: new WorkspaceRepo(t.ctx.db),
        conversations: new ConversationRepo(t.ctx.db),
        conversationInboxes: new ConversationInboxRepo(t.ctx.db),
      },
      { agentId, requesterUserId: t.viewerUserId, body: { confirm: true } },
    );
    expect(result.kind).toBe('failClosed');

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
