import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  conversationSideScope,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * `POST /api/workspaces/:id/leave` (#task:1930) — a human ends their OWN
 * workspace membership. Self-service, so there is no governance role to hold:
 * the only gate is "you are a member and you are not the owner".
 *
 * The cascade is the owner-driven human-removal cascade reused verbatim, so the
 * cases here pin what is SPECIFIC to self-leave rather than re-testing that
 * path: the existential bypass of the per-channel exit guard, the untouched
 * agents, the two refusals, and containment to the one workspace.
 *
 * `seedAllFixtureMemberships: false` throughout — the permissive fixture trigger
 * seats the viewer as `owner` of every workspace, which would silently turn the
 * member cases into the owner refusal.
 */

const OWNER = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('teammate') };
const ADMIN = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('alice') };
const OUTSIDER = { [X_SILVERHAND_PRINCIPAL_HEADER]: encodeUserPrincipalHeader('other') };
// The default identity of `http(t)` with no headers is `local` — the leaver
// throughout this file, a plain member unless a case says otherwise.
const LEAVER = 'local';

type Scenario = {
  workspaceId: string;
  /** Public channel holding owner + admin + leaver. */
  roomId: string;
  /** Private channel whose ONLY human is the leaver. */
  secretId: string;
};

async function json(res: Response): Promise<any> {
  return await res.json() as any;
}

/**
 * A workspace owned by `teammate`, `alice` promoted to `admin`, `local` a plain
 * member; one public channel with all three, plus a private channel whose only
 * remaining human is the leaver — the state a channel-level leave refuses with
 * `last_human_member`.
 */
async function seedScenario(t: TestApp): Promise<Scenario> {
  const workspaceId = (await json(
    await http(t).post(
      '/api/workspaces',
      { name: 'leavable', member_agent_ids: [] },
      { headers: OWNER },
    ),
  )).workspace.id as string;

  for (const userId of ['alice', LEAVER]) {
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(workspaceId),
        { kind: 'human', user_id: userId },
        { headers: OWNER },
      )).status,
    ).toBe(201);
  }
  expect(
    (await http(t).patch(
      apiPaths.workspaceHumanMemberRole(workspaceId, 'alice'),
      { role: 'admin' },
      { headers: OWNER },
    )).status,
  ).toBe(200);

  const roomId = (await json(
    await http(t).post(
      apiPaths.workspaceChannels(workspaceId),
      {
        title: 'room',
        member_agent_ids: [],
        member_user_ids: ['alice', LEAVER],
        visibility: 'public',
      },
      { headers: OWNER },
    ),
  )).channel.id as string;

  // Channel creation is admin-gated, so the private channel is minted by the
  // admin with the leaver added, then the admin leaves it: the surviving human
  // set is exactly {local}, reached entirely through production routes.
  const secretId = (await json(
    await http(t).post(
      apiPaths.workspaceChannels(workspaceId),
      {
        title: 'secret',
        member_agent_ids: [],
        member_user_ids: [LEAVER],
        visibility: 'private',
      },
      { headers: ADMIN },
    ),
  )).channel.id as string;
  expect(
    (await http(t).post(apiPaths.channelLeave(secretId), {}, { headers: ADMIN })).status,
  ).toBe(200);

  return { workspaceId, roomId, secretId };
}

function workspaceUserRows(t: TestApp, workspaceId: string, userId: string): number {
  return t.ctx.db
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM workspace_users
        WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(workspaceId, userId)!.c;
}

function conversationUserRows(t: TestApp, workspaceId: string, userId: string): number {
  return t.ctx.db
    .prepare<[string, string], { c: number }>(
      `SELECT COUNT(*) AS c FROM conversation_users cu
         JOIN conversations c ON c.id = cu.conversation_id
        WHERE c.workspace_id = ? AND cu.user_id = ?`,
    )
    .get(workspaceId, userId)!.c;
}

describe('workspace self-leave (#task:1930)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('removes the leaver from the workspace and from every channel of it, announcing the departure', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, roomId, secretId } = await seedScenario(t);
    expect(conversationUserRows(t, workspaceId, LEAVER)).toBe(2);

    // A SECOND workspace the leaver also belongs to: leaving one workspace must
    // not touch memberships anywhere else.
    const otherWorkspaceId = (await json(
      await http(t).post(
        '/api/workspaces',
        { name: 'untouched', member_agent_ids: [] },
        { headers: OWNER },
      ),
    )).workspace.id as string;
    expect(
      (await http(t).post(
        apiPaths.workspaceMembers(otherWorkspaceId),
        { kind: 'human', user_id: LEAVER },
        { headers: OWNER },
      )).status,
    ).toBe(201);

    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const offViewer = t.ctx.events.subscribeScope(`viewer:${LEAVER}`, event => {
      viewerEvents.push({ kind: event.kind, payload: event.payload });
    });
    const roomEvents: Array<{ kind: string; payload: unknown }> = [];
    const offRoom = t.ctx.events.subscribe(roomId, event => {
      roomEvents.push({ kind: event.kind, payload: event.payload });
    });
    const offRoomSide = t.ctx.events.subscribeScope(conversationSideScope(roomId), event => {
      roomEvents.push({ kind: event.kind, payload: event.payload });
    });

    let status: number;
    try {
      status = (await http(t).post(apiPaths.workspaceLeave(workspaceId), {})).status;
    } finally {
      offViewer();
      offRoom();
      offRoomSide();
    }
    expect(status).toBe(204);

    expect(workspaceUserRows(t, workspaceId, LEAVER)).toBe(0);
    expect(conversationUserRows(t, workspaceId, LEAVER)).toBe(0);
    // Containment: the other workspace is untouched.
    expect(workspaceUserRows(t, otherWorkspaceId, LEAVER)).toBe(1);

    expect(viewerEvents).toEqual([
      {
        kind: 'viewer_workspaces_changed',
        payload: { change: 'removed', workspace_id: workspaceId },
      },
    ]);
    // Actor === member, so the audit row reads as a departure rather than as
    // somebody else's moderation.
    const message = roomEvents.find(e => e.kind === 'message');
    expect((message?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '<silverhand://human/local-test> left this conversation.',
      metadata: {
        subtype: 'conversation_member_removed',
        actor_kind: 'user',
        actor_id: LEAVER,
        member_kind: 'human',
        member_id: LEAVER,
      },
    });
    expect(roomEvents).toContainEqual({
      kind: 'conversation_members_changed',
      payload: { conversation_id: roomId, workspace_id: workspaceId },
    });

    const remaining = await json(
      await http(t).get(apiPaths.conversationMembers(roomId), { headers: OWNER }),
    );
    expect(remaining.members.map((m: any) => m.user_id)).not.toContain(LEAVER);
    expect(secretId).toBeTruthy();
  });

  it('leaves the departing member\'s enrolled agents in place', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, roomId } = await seedScenario(t);

    // An agent created BY the leaver, enrolled in the workspace and seated in a
    // channel. shiki 2026-08-09: a human leaving does NOT take their agents out.
    const agentId = 'leaver-agent';
    const now = 1_700_000_000_000;
    t.ctx.db
      .prepare(
        `INSERT INTO agents (id, name, runtime, host_id, created_by_user_id, created_at, updated_at)
         VALUES (?, 'leaver-agent', 'claude', ?, ?, ?, ?)`,
      )
      .run(agentId, t.ctx.coLocatedHostId!, LEAVER, now, now);
    t.ctx.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(workspaceId, agentId, now);
    t.ctx.db
      .prepare(
        `INSERT INTO conversation_agents (conversation_id, agent_id, joined_at)
         VALUES (?, ?, ?)`,
      )
      .run(roomId, agentId, now);

    expect((await http(t).post(apiPaths.workspaceLeave(workspaceId), {})).status).toBe(204);

    const wsAgentRows = t.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM workspace_members
          WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId)!.c;
    expect(wsAgentRows).toBe(1);
    const convAgentRows = t.ctx.db
      .prepare<[string, string], { c: number }>(
        `SELECT COUNT(*) AS c FROM conversation_agents
          WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(roomId, agentId)!.c;
    expect(convAgentRows).toBe(1);
  });

  it('exits even when a channel-level leave of the same edge is refused', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId, secretId } = await seedScenario(t);

    // Same edge, same moment: the CHANNEL verb is blocked (the leaver is the
    // last human of a private channel) …
    const blocked = await http(t).post(apiPaths.channelLeave(secretId), {});
    expect(blocked.status).toBe(409);
    expect((await json(blocked)).code).toBe('last_human_member');

    // … while the WORKSPACE verb is existential and clears it anyway. Without
    // the deliberate bypass this would be a private channel that locks a person
    // into a workspace.
    expect((await http(t).post(apiPaths.workspaceLeave(workspaceId), {})).status).toBe(204);
    expect(conversationUserRows(t, workspaceId, LEAVER)).toBe(0);
  });

  it('lets an admin leave — ending your own membership needs no role over others', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId } = await seedScenario(t);

    expect(
      (await http(t).post(apiPaths.workspaceLeave(workspaceId), {}, { headers: ADMIN })).status,
    ).toBe(204);
    expect(workspaceUserRows(t, workspaceId, 'alice')).toBe(0);
  });

  it('refuses the owner with owner_removal_unsupported, changing nothing', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId } = await seedScenario(t);

    const res = await http(t).post(apiPaths.workspaceLeave(workspaceId), {}, { headers: OWNER });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('owner_removal_unsupported');
    expect(workspaceUserRows(t, workspaceId, 'teammate')).toBe(1);
    expect(conversationUserRows(t, workspaceId, 'teammate')).toBeGreaterThan(0);
  });

  it('refuses a non-member with not_member instead of an idempotent success', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const { workspaceId } = await seedScenario(t);

    const res = await http(t).post(
      apiPaths.workspaceLeave(workspaceId),
      {},
      { headers: OUTSIDER },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe('not_member');
  });

  it('404s an agent_home workspace — leaving is a regular-workspace verb', async () => {
    t = buildTestApp({ seedAllFixtureMemberships: false });
    const agentId = (await json(
      await http(t).post('/api/agents', { name: 'homey', runtime: 'claude' }),
    )).agent.id as string;
    const home = t.ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM workspaces
          WHERE workspace_kind = 'agent_home' AND owner_agent_id = ?`,
      )
      .get(agentId);
    expect(home).toBeTruthy();

    expect((await http(t).post(apiPaths.workspaceLeave(home!.id), {})).status).toBe(404);
  });
});
