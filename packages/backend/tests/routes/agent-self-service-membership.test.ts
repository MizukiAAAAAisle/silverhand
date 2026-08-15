/**
 * #task:1683 — the SELF-SERVICE half of agent placement (shiki 2026-07-28,
 * accepting both of Cindy's minimal-permission proposals). #task:1681 let any
 * workspace member bring their OWN agents in; the two asymmetries it left are
 * closed here:
 *
 *   1. Workspace REMOVE — whoever may enroll their own agent may take it back
 *      out. `admin` keeps governance over the whole agent roster, so the gate is
 *      `admin ∨ own`, not a replacement.
 *   2. CHANNEL add — a plain member of the target channel may add their own
 *      agents to it (auto-provisioning workspace membership if needed). Adding a
 *      human, or someone else's agent, stays `admin`.
 *
 * The load-bearing separation these tests pin: channel-roster authority and
 * agent-enrollment ownership are TWO independent factors. Ownership never
 * substitutes for the roster floor — a workspace member who is NOT in a private
 * channel cannot use their own agent as a way in (or a relay out) — and no role
 * substitutes for ownership.
 *
 * `seedAllFixtureMemberships: false` throughout: these are permission-boundary
 * tests, so every membership row comes from a production surface (the permissive
 * fixture triggers would hand every user membership everywhere).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeUserPrincipalHeader,
  fixedConversationTitle,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

const OWNER = 'teammate';
const STRANGER = 'other';
const ownerHeaders = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(OWNER) };
const strangerHeaders = {
  [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader(STRANGER),
};

async function makeAgent(
  t: TestApp,
  name: string,
  headers?: Record<string, string>,
  sessionScope: 'conversation' | 'agent' = 'conversation',
): Promise<string> {
  const res = await http(t).post(
    '/api/agents',
    { name, runtime: 'claude', session_scope: sessionScope },
    headers ? { headers } : undefined,
  );
  expect(res.status).toBe(201);
  const id = ((await res.json()) as any).agent.id as string;
  t.fake.starts = [];
  t.fake.delivered = [];
  return id;
}

function workspaceAgentIds(t: TestApp, workspaceId: string): string[] {
  return t.ctx.db
    .prepare<[string], { agent_id: string }>(
      `SELECT agent_id FROM workspace_members WHERE workspace_id = ?`,
    )
    .all(workspaceId)
    .map(r => r.agent_id);
}

function channelAgentIds(t: TestApp, conversationId: string): string[] {
  return t.ctx.db
    .prepare<[string], { agent_id: string }>(
      `SELECT agent_id FROM conversation_agents WHERE conversation_id = ?`,
    )
    .all(conversationId)
    .map(r => r.agent_id);
}

function channelUserIds(t: TestApp, conversationId: string): string[] {
  return t.ctx.db
    .prepare<[string], { user_id: string }>(
      `SELECT user_id FROM conversation_users WHERE conversation_id = ?`,
    )
    .all(conversationId)
    .map(r => r.user_id);
}

/**
 * `teammate` owns the workspace; `local` is invited and lands as plain `member`
 * (the invite route's only outcome). Every test below asserts that role via this
 * helper, so no result can be explained by an accidental admin.
 */
async function invitedMemberWorkspace(t: TestApp, name: string): Promise<string> {
  const created = await http(t).post(
    '/api/workspaces',
    { name, member_agent_ids: [] },
    { headers: ownerHeaders },
  );
  expect(created.status).toBe(201);
  const workspaceId = ((await created.json()) as any).workspace.id as string;
  const invite = await http(t).post(
    `/api/workspaces/${workspaceId}/members`,
    { kind: 'human', user_id: 'local' },
    { headers: ownerHeaders },
  );
  expect(invite.status).toBe(201);
  expect(
    t.ctx.db
      .prepare<[string, string], { role: string }>(
        `SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(workspaceId, 'local')!.role,
  ).toBe('member');
  return workspaceId;
}

/** Enroll `agentId` through the production route, as `headers`' identity. */
async function enroll(
  t: TestApp,
  workspaceId: string,
  agentId: string,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await http(t).post(
    `/api/workspaces/${workspaceId}/members`,
    { agent_id: agentId },
    headers ? { headers } : undefined,
  );
  expect(res.status).toBe(201);
}

describe('#task:1683 — DELETE /api/workspaces/:id/members/:agentId', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('lets a plain member remove the agent they enrolled themselves', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-own');
    const mine = await makeAgent(t, 'remove-own-agent');
    await enroll(t, ws, mine);

    const res = await http(t).del(`/api/workspaces/${ws}/members/${mine}`);

    expect(res.status).toBe(204);
    expect(workspaceAgentIds(t, ws)).toEqual([]);
  });

  it('removes an AgentSlot target without stopping the aggregate-owned runtime', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-agent-slot-target');
    const mine = await makeAgent(
      t,
      'remove-agent-slot-target-agent',
      undefined,
      'agent',
    );
    await enroll(t, ws, mine);
    const channel = new ConversationRepo(t.ctx.db).insertChannel({
      workspaceId: ws,
      title: fixedConversationTitle('AgentSlot target'),
    });
    new ConversationRepo(t.ctx.db).addAgent(channel.id, mine);

    const res = await http(t).del(`/api/workspaces/${ws}/members/${mine}`);

    expect(res.status).toBe(204);
    expect(workspaceAgentIds(t, ws)).toEqual([]);
    expect(channelAgentIds(t, channel.id)).toEqual([]);
    expect(t.fake.stops).toEqual([]);
  });

  it("refuses a plain member removing someone else's agent, leaving the row", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-foreign');
    const theirs = await makeAgent(t, 'remove-foreign-agent', ownerHeaders);
    await enroll(t, ws, theirs, ownerHeaders);

    const res = await http(t).del(`/api/workspaces/${ws}/members/${theirs}`);

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(workspaceAgentIds(t, ws)).toEqual([theirs]);
  });

  it("still lets an admin remove a member's agent — role governs the whole roster", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-by-admin');
    const mine = await makeAgent(t, 'remove-by-admin-agent');
    await enroll(t, ws, mine);

    const res = await http(t).del(`/api/workspaces/${ws}/members/${mine}`, {
      headers: ownerHeaders,
    });

    expect(res.status).toBe(204);
    expect(workspaceAgentIds(t, ws)).toEqual([]);
  });

  it('refuses a non-member outright, even for an agent they created', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-stranger');
    const strangersAgent = await makeAgent(t, 'stranger-agent', strangerHeaders);
    // Enrolled by SYSTEM-independent means: its creator is not a member, so the
    // only production door is an admin add… which #1681 forbids. Insert the row
    // directly to construct the state, then prove the membership FLOOR answers
    // first — ownership does not get a non-member into the roster surface.
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at) VALUES (?, ?, 1)`,
      )
      .run(ws, strangersAgent);

    const res = await http(t).del(`/api/workspaces/${ws}/members/${strangersAgent}`, {
      headers: strangerHeaders,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ error: 'forbidden' });
    expect(workspaceAgentIds(t, ws)).toEqual([strangersAgent]);
  });

  it('fails closed for a plain member on an unknown agent id, where an admin gets the idempotent no-op', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const ws = await invitedMemberWorkspace(t, 'remove-unknown');

    // Ownership of a non-existent agent is unprovable, so a plain member cannot
    // reach the route's cleanup branch — it stays admin-only, which is the
    // fail-closed answer rather than the 204 an admin would get.
    const member = await http(t).del(`/api/workspaces/${ws}/members/ghost-agent`);
    expect(member.status).toBe(403);
    expect((await member.json()) as any).toMatchObject({ code: 'agent_not_owned' });

    // Admin behaviour is unchanged: unknown id is an idempotent no-op.
    const admin = await http(t).del(`/api/workspaces/${ws}/members/ghost-agent`, {
      headers: ownerHeaders,
    });
    expect(admin.status).toBe(204);
    expect(workspaceAgentIds(t, ws)).toEqual([]);
  });
});

describe('#task:1683 — POST /api/conversations/:id/members (channel self-service)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  /** A private channel in `workspaceId`, created by the owner/admin. */
  async function createChannel(
    t: TestApp,
    workspaceId: string,
    title: string,
    memberUserIds: string[],
  ): Promise<string> {
    const res = await http(t).post(
      `/api/workspaces/${workspaceId}/channels`,
      { title, member_agent_ids: [], member_user_ids: memberUserIds },
      { headers: ownerHeaders },
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as any).channel.id as string;
  }

  /**
   * The recurring shape: `local` is a plain workspace member AND a member of the
   * private channel `channelId`; `outsideChannelId` is a private channel in the
   * same workspace that `local` was never added to.
   */
  async function fixture(
    t: TestApp,
    name: string,
  ): Promise<{ ws: string; channelId: string; outsideChannelId: string }> {
    const ws = await invitedMemberWorkspace(t, name);
    const channelId = await createChannel(t, ws, `${name}-room`, ['local']);
    const outsideChannelId = await createChannel(t, ws, `${name}-private`, []);
    expect(channelUserIds(t, channelId)).toEqual(expect.arrayContaining(['local', OWNER]));
    expect(channelUserIds(t, outsideChannelId)).not.toContain('local');
    return { ws, channelId, outsideChannelId };
  }

  it('lets a plain channel member add their own agent that is already in the workspace', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-own-enrolled');
    const mine = await makeAgent(t, 'ch-own-enrolled-agent');
    await enroll(t, ws, mine);

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: mine,
    });

    expect(res.status).toBe(200);
    expect(channelAgentIds(t, channelId)).toEqual([mine]);
  });

  it('auto-provisions workspace membership for their own not-yet-enrolled agent', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-own-autoprovision');
    const mine = await makeAgent(t, 'ch-own-autoprovision-agent');
    expect(workspaceAgentIds(t, ws)).toEqual([]);

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: mine,
    });

    expect(res.status).toBe(200);
    expect(workspaceAgentIds(t, ws)).toEqual([mine]);
    expect(channelAgentIds(t, channelId)).toEqual([mine]);
  });

  it('accepts the handle input shape for their own not-yet-enrolled agent', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-own-handle');
    const mine = await makeAgent(t, 'ch-own-handle-agent');

    // The candidate-eligibility filter is per-candidate: a non-workspace agent is
    // eligible exactly when THIS caller could enroll it.
    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      handle: '@ch-own-handle-agent',
    });

    expect(res.status).toBe(200);
    expect(workspaceAgentIds(t, ws)).toEqual([mine]);
    expect(channelAgentIds(t, channelId)).toEqual([mine]);
  });

  it("refuses someone else's agent that is already in the workspace (ownership, not enrollment)", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-foreign-enrolled');
    const theirs = await makeAgent(t, 'ch-foreign-enrolled-agent', ownerHeaders);
    await enroll(t, ws, theirs, ownerHeaders);

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: theirs,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(channelAgentIds(t, channelId)).toEqual([]);
    // The pre-existing enrollment is untouched: the refusal is about the channel
    // roster write, not a rollback of someone else's workspace membership.
    expect(workspaceAgentIds(t, ws)).toEqual([theirs]);
  });

  it("refuses someone else's agent that is NOT in the workspace, with no enrollment residue", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-foreign-outside');
    const theirs = await makeAgent(t, 'ch-foreign-outside-agent', ownerHeaders);
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'agent',
      agent_id: theirs,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(workspaceAgentIds(t, ws)).toEqual([]);
    expect(channelAgentIds(t, channelId)).toEqual([]);
    // Refused before the data plane: no L2 seed to reconcile.
    expect(t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed')).toEqual([]);
  });

  /**
   * The role axis buys NO enrollment authority (Cindy, #task:1683 review — the
   * matrix had merged foreign add with foreign remove and handed owner/admin an
   * enroll power that does not exist). #task:1681 is creator-only in one
   * direction: an admin governs the whole workspace roster for REMOVAL, but the
   * way a teammate's agent gets IN is the teammate. Same route, same target,
   * opposite answers by verb — so the admin arm of channel add is an exit only
   * when the agent is ALREADY a workspace member (the test above).
   */
  it('refuses an ADMIN too when the foreign agent is not a workspace member yet (no role enrolls for you)', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-admin-foreign-outside');
    // Created by `local` (a plain member), never enrolled; the caller below is
    // the workspace OWNER — the highest role there is.
    const theirs = await makeAgent(t, 'ch-admin-foreign-outside-agent');
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).post(
      `/api/conversations/${channelId}/members`,
      { kind: 'agent', agent_id: theirs },
      { headers: ownerHeaders },
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(workspaceAgentIds(t, ws)).toEqual([]);
    expect(channelAgentIds(t, channelId)).toEqual([]);
    expect(t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed')).toEqual([]);
  });

  /**
   * The INPUT SHAPE must not pick the typed contract (Cindy, #task:1683 review).
   * Handle resolution narrows an ambiguous handle to the candidates this caller
   * could place, but when nothing is placeable it hands the full candidate set
   * to the single authorization path — otherwise the very same target answers
   * `agent_not_owned` by id and `workspace_membership_required` by handle, and a
   * CLI/API caller would get two different remedies ("ask the owner" vs "enroll
   * it first") for one situation.
   */
  it("answers the same for a foreign non-workspace agent by HANDLE as by id (no contract fork)", async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-foreign-handle');
    await makeAgent(t, 'ch-foreign-handle-agent', ownerHeaders);
    t.fakeHostWs!.calls.length = 0;

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      handle: '@ch-foreign-handle-agent',
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ code: 'agent_not_owned' });
    expect(workspaceAgentIds(t, ws)).toEqual([]);
    expect(channelAgentIds(t, channelId)).toEqual([]);
    expect(t.fakeHostWs!.calls.filter(c => c.kind === 'agent_l2_seed')).toEqual([]);
  });

  it('answers the same for a non-workspace HUMAN by HANDLE as by id — the ROLE refusal', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-human-handle');

    // `carol-test` (user id `carol`) exists but is in no workspace here. A plain
    // member may not add people at all, so the truthful answer is the role
    // refusal, exactly as for `{ kind: 'human', user_id: 'carol' }`.
    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      handle: '@carol-test',
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ error: 'forbidden' });
    expect(channelUserIds(t, channelId)).not.toContain('carol');
    expect(
      t.ctx.db
        .prepare<[string, string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
        )
        .get(ws, 'carol'),
    ).toBeUndefined();
  });

  it('does NOT let a plain channel member add a HUMAN, even a fellow workspace member', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-human');
    const invite = await http(t).post(
      `/api/workspaces/${ws}/members`,
      { kind: 'human', user_id: 'bob' },
      { headers: ownerHeaders },
    );
    expect(invite.status).toBe(201);

    const res = await http(t).post(`/api/conversations/${channelId}/members`, {
      kind: 'human',
      user_id: 'bob',
    });

    // `forbidden`, not `workspace_membership_required`: the refusal is the ROLE,
    // and the people roster carries no ownership factor that could stand in.
    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ error: 'forbidden' });
    expect(channelUserIds(t, channelId)).not.toContain('bob');
  });

  it('refuses a workspace member who is NOT in the target channel — own agent is no way in', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, outsideChannelId } = await fixture(t, 'ch-outsider');
    const mine = await makeAgent(t, 'ch-outsider-agent');
    await enroll(t, ws, mine);

    const res = await http(t).post(`/api/conversations/${outsideChannelId}/members`, {
      kind: 'agent',
      agent_id: mine,
    });

    expect(res.status).toBe(403);
    expect((await res.json()) as any).toMatchObject({ error: 'forbidden' });
    expect(channelAgentIds(t, outsideChannelId)).toEqual([]);
    expect(channelUserIds(t, outsideChannelId)).not.toContain('local');
  });

  it('keeps the admin paths working: add a human, and add a member’s already-enrolled agent', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { ws, channelId } = await fixture(t, 'ch-admin');
    const mine = await makeAgent(t, 'ch-admin-member-agent');
    await enroll(t, ws, mine);

    // A member's agent is a plain roster move for an admin (no enrollment).
    const agentAdd = await http(t).post(
      `/api/conversations/${channelId}/members`,
      { kind: 'agent', agent_id: mine },
      { headers: ownerHeaders },
    );
    expect(agentAdd.status).toBe(200);
    expect(channelAgentIds(t, channelId)).toEqual([mine]);

    // Adding a human who is not even a workspace member still auto-provisions.
    const humanAdd = await http(t).post(
      `/api/conversations/${channelId}/members`,
      { kind: 'human', user_id: 'alice' },
      { headers: ownerHeaders },
    );
    expect(humanAdd.status).toBe(200);
    expect(channelUserIds(t, channelId)).toContain('alice');
    expect(
      t.ctx.db
        .prepare<[string, string], { user_id: string }>(
          `SELECT user_id FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
        )
        .get(ws, 'alice'),
    ).toBeTruthy();
  });
});
