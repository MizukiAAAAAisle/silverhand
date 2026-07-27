/**
 * #task:1681 — ENROLLMENT authority: only an agent's creator may place it in a
 * workspace. Workspace-admin role governs the ROSTER; it does not grant the
 * right to commit someone else's agent to it.
 *
 * Product rule (shiki 2026-07-27): another user's agents are not draggable into
 * your workspace — you invite the HUMAN, and they bring their own agents. The
 * renderer narrows its candidate list to `/api/agents?scope=owned`, but that is
 * a convenience, not the boundary (CLAUDE.md invariant #4), so every door that
 * writes agent workspace membership is pinned here against a HAND-ROLLED request
 * carrying a teammate's agent id:
 *
 *   1. POST /api/workspaces/:id/members            (both input shapes)
 *   2. POST /api/workspaces                        (initial `member_agent_ids`)
 *   3. POST /api/conversations/:id/members          (auto-provisions workspace
 *                                                    membership for a channel add)
 *
 * The rejected population is specifically the VISIBLE one: an agent that shares
 * a workspace with the caller is legitimately readable (`GET /api/agents` lists
 * it for @-mention / member lists) and still not enrollable. Each test proves
 * that precondition instead of assuming it.
 *
 * `seedAllFixtureMemberships: false` — these are permission-boundary tests, so
 * membership rows come only from the production surfaces (the permissive fixture
 * triggers would hand every user membership in every workspace).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { canEnrollAgent } from '../../src/permissions.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

const TEAMMATE = 'teammate';
const teammateHeaders = {
  [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(TEAMMATE),
};

async function makeAgent(
  t: TestApp,
  name: string,
  headers?: Record<string, string>,
): Promise<string> {
  const res = await http(t).post(
    '/api/agents',
    { name, runtime: 'claude' },
    headers ? { headers } : undefined,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return body.agent.id as string;
}

async function createWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[] = [],
  headers?: Record<string, string>,
): Promise<{ id: string; workspace_path: string }> {
  const res = await http(t).post(
    '/api/workspaces',
    { name, member_agent_ids: memberAgentIds },
    headers ? { headers } : undefined,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as any).workspace;
}

/**
 * Make `agentId` ACL-visible to `local` WITHOUT enrolling it in any workspace
 * `local` governs: it joins a workspace of its own creator, and `local` is added
 * as a human member there. That co-membership is exactly the branch
 * `canViewAgent` grants and `?scope=owned` drops — the population these gates
 * must still refuse.
 */
function shareAgentIntoTeammateWorkspace(
  t: TestApp,
  workspaceId: string,
  agentId: string,
): void {
  const now = Date.now();
  t.ctx.db
    .prepare(
      `INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES (?, ?, ?)`,
    )
    .run(workspaceId, agentId, now);
  t.ctx.db
    .prepare(
      `INSERT INTO workspace_users (workspace_id, user_id, joined_at) VALUES (?, 'local', ?)`,
    )
    .run(workspaceId, now);
}

async function visibleAgentIds(t: TestApp, query = ''): Promise<string[]> {
  const res = await http(t).get(`/api/agents${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as any).agents.map((a: any) => a.id as string);
}

function memberAgentIds(t: TestApp, workspaceId: string): string[] {
  return t.ctx.db
    .prepare<[string], { agent_id: string }>(
      `SELECT agent_id FROM workspace_members WHERE workspace_id = ?`,
    )
    .all(workspaceId)
    .map(r => r.agent_id);
}

/**
 * Set up the shared cross-user fixture: `local` owns `ws`, `teammate` owns
 * `theirAgent`, and `theirAgent` is ACL-visible to `local` via a shared
 * workspace. Asserts the visibility precondition so a later 403 cannot be
 * explained by "local could not see it anyway".
 */
async function crossUserFixture(
  t: TestApp,
  name: string,
): Promise<{ ws: { id: string; workspace_path: string }; theirAgent: string }> {
  const theirAgent = await makeAgent(t, `${name}-theirs`, teammateHeaders);
  const theirWs = await createWorkspace(t, `${name}-their-ws`, [], teammateHeaders);
  shareAgentIntoTeammateWorkspace(t, theirWs.id, theirAgent);
  const ws = await createWorkspace(t, `${name}-mine`);

  expect(await visibleAgentIds(t)).toContain(theirAgent);
  expect(await visibleAgentIds(t, '?scope=owned')).not.toContain(theirAgent);

  return { ws, theirAgent };
}

describe('#task:1681 — POST /api/workspaces/:id/members enrollment authority', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('enrolls an agent the caller created (untagged legacy input shape)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makeAgent(t, 'mine-untagged');
    const ws = await createWorkspace(t, 'own-agent-untagged');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: mine,
    });

    expect(res.status).toBe(201);
    expect(memberAgentIds(t, ws.id)).toEqual([mine]);
  });

  it('enrolls an agent the caller created (tagged input shape)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makeAgent(t, 'mine-tagged');
    const ws = await createWorkspace(t, 'own-agent-tagged');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      kind: 'agent',
      agent_id: mine,
    });

    expect(res.status).toBe(201);
    expect(memberAgentIds(t, ws.id)).toEqual([mine]);
  });

  it("refuses another user's agent even though it is ACL-visible, with NO row and NO L2 seed", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, theirAgent } = await crossUserFixture(t, 'gate');
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: theirAgent,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    // The gate runs BEFORE the daemon seed, so there is no fs residue to
    // reconcile and no membership row.
    expect(memberAgentIds(t, ws.id)).toEqual([]);
    expect(t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed')).toEqual([]);
  });

  it('refuses the same agent for the tagged input shape too (one gate, both shapes)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, theirAgent } = await crossUserFixture(t, 'gate-tagged');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      kind: 'agent',
      agent_id: theirAgent,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(memberAgentIds(t, ws.id)).toEqual([]);
  });

  it('leaves human enrollment untouched — adding a human is still admin-gated only', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await createWorkspace(t, 'human-add');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      kind: 'human',
      user_id: TEAMMATE,
    });

    expect(res.status).toBe(201);
    const humans = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
      )
      .all(ws.id)
      .map(r => r.user_id);
    expect(humans).toEqual(expect.arrayContaining(['local', TEAMMATE]));
  });

  it('still 404s an unknown agent id (not-found is not reported as not-owned)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await createWorkspace(t, 'unknown-agent');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: 'no-such-agent',
    });

    expect(res.status).toBe(404);
  });
});

/**
 * The DELEGATION half of the product rule (shiki 2026-07-27, ruling on Cindy's
 * blocker): "invite the human, they bring their own agents" only works if a
 * plain `member` — the role every invitee joins with — can enroll their own
 * agents. So the workspace-side rank required for a roster write follows the
 * DATA: `member` for your own agent, `admin` for a human.
 */
describe('#task:1681 — a plain workspace member may bring their OWN agents', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /**
   * `teammate` owns a workspace and invites `local` — who lands as plain
   * `member` (the invite route's only outcome; role promotion is a separate
   * owner-only route). Asserts that role so the tests below cannot be explained
   * by an accidental admin.
   */
  async function invitedMemberFixture(
    t: TestApp,
    name: string,
  ): Promise<{ id: string }> {
    const ws = await createWorkspace(t, `${name}-theirs`, [], teammateHeaders);
    const invite = await http(t).post(
      `/api/workspaces/${ws.id}/members`,
      { kind: 'human', user_id: 'local' },
      { headers: teammateHeaders },
    );
    expect(invite.status).toBe(201);
    expect(t.ctx.db
      .prepare<[string, string], { role: string }>(
        `SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(ws.id, 'local')!.role).toBe('member');
    return ws;
  }

  it('enrolls the member’s own agent (no admin promotion needed)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberFixture(t, 'delegation');
    const mine = await makeAgent(t, 'invitee-own-agent');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: mine,
    });

    expect(res.status).toBe(201);
    expect(memberAgentIds(t, ws.id)).toEqual([mine]);
  });

  it('still refuses the workspace OWNER’s agent — no role widens the ownership factor', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberFixture(t, 'delegation-foreign');
    const theirs = await makeAgent(t, 'owners-agent', teammateHeaders);

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: theirs,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(memberAgentIds(t, ws.id)).toEqual([]);
  });

  it('does NOT let a member invite a human — the people roster stays admin-gated', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberFixture(t, 'delegation-human');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      kind: 'human',
      user_id: 'other',
    });

    expect(res.status).toBe(403);
    const humans = t.ctx.db
      .prepare<[string], { user_id: string }>(
        `SELECT user_id FROM workspace_users WHERE workspace_id = ?`,
      )
      .all(ws.id)
      .map(r => r.user_id);
    expect(humans).not.toContain('other');
  });

  it('refuses a NON-member outright, before the body is even parsed', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    // `teammate`'s workspace, `local` never invited.
    const ws = await createWorkspace(t, 'stranger-theirs', [], teammateHeaders);
    const mine = await makeAgent(t, 'stranger-own-agent');

    const res = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      agent_id: mine,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ error: 'forbidden' });
    expect(memberAgentIds(t, ws.id)).toEqual([]);

    // A malformed body from the same stranger is still 403, not 400: the
    // membership floor answers before input validity is revealed.
    const garbage = await http(t).post(`/api/workspaces/${ws.id}/members`, {
      nonsense: true,
    });
    expect(garbage.status).toBe(403);
  });
});

describe('#task:1681 — POST /api/workspaces initial members', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it("refuses a create whose member_agent_ids include another user's agent, leaving NO workspace", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makeAgent(t, 'create-mine');
    const theirAgent = await makeAgent(t, 'create-theirs', teammateHeaders);
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).post('/api/workspaces', {
      name: 'create-gate',
      member_agent_ids: [mine, theirAgent],
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ code: 'agent_not_owned' });
    // The offender is named, so a surface can point at the right row.
    expect(body.agent_ids).toEqual([theirAgent]);
    // Rejected before the daemon provision: no workspace row, no fs bind.
    const rows = t.ctx.db
      .prepare<[], { n: number }>(`SELECT COUNT(*) as n FROM workspaces WHERE name = 'create-gate'`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
    expect(t.fakeHostWs!.calls.filter(c => c.kind === 'workspace_provision')).toEqual([]);
  });

  it('creates normally when every initial member is the creator’s own agent', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makeAgent(t, 'create-ok');

    const ws = await createWorkspace(t, 'create-ok-ws', [mine]);

    expect(memberAgentIds(t, ws.id)).toEqual([mine]);
  });
});

describe('#task:1681 — POST /api/conversations/:id/members auto-provision door', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  async function createChannel(
    t: TestApp,
    workspaceId: string,
    title: string,
  ): Promise<string> {
    const res = await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: [],
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).channel.id as string;
  }

  it("refuses a channel add that would enroll another user's agent into the workspace", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, theirAgent } = await crossUserFixture(t, 'conv-gate');
    const channelId = await createChannel(t, ws.id, 'room');

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: theirAgent,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(memberAgentIds(t, ws.id)).toEqual([]);
    const convAgents = t.ctx.db
      .prepare<[string], { agent_id: string }>(
        `SELECT agent_id FROM conversation_agents WHERE conversation_id = ?`,
      )
      .all(channelId)
      .map(r => r.agent_id);
    expect(convAgents).toEqual([]);
  });

  it("control: an already-enrolled foreign agent is still addable to a channel (channel roster ≠ enrollment)", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, theirAgent } = await crossUserFixture(t, 'conv-control');
    // Pre-existing enrollment (however it got there — e.g. its creator added it
    // while an admin). The gate only guards the auto-provision branch, so the
    // channel add is a pure roster move and must still work.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES (?, ?, ?)`,
      )
      .run(ws.id, theirAgent, Date.now());
    const channelId = await createChannel(t, ws.id, 'room');

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: theirAgent,
    });

    expect(res.status).toBe(200);
  });
});

describe('#task:1681 — canEnrollAgent (the authority itself)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is true only for the creator and system; never for an agent principal', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const mine = await makeAgent(t, 'authority-mine');

    expect(canEnrollAgent(t.ctx, { kind: 'user', userId: 'local' }, mine)).toBe(true);
    expect(canEnrollAgent(t.ctx, { kind: 'user', userId: TEAMMATE }, mine)).toBe(false);
    expect(canEnrollAgent(t.ctx, { kind: 'system' }, mine)).toBe(true);
    // An agent may not place ITSELF: being put in a workspace is its owner's
    // call, which is why this is not an alias of `canEditAgent`.
    expect(
      canEnrollAgent(t.ctx, { kind: 'agent', agentId: mine, conversationId: 'c1' }, mine),
    ).toBe(false);
    expect(canEnrollAgent(t.ctx, { kind: 'user', userId: 'local' }, 'no-such-agent')).toBe(
      false,
    );
  });
});
