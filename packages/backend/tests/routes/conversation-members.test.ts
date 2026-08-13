import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES, conversationSideScope, internalPaths } from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { ConversationReadRepo } from '../../src/repos/conversation-read-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Stage-2 P2: a membership flow emits `message` on the message-stream (compat)
 * conversation emitter and `conversation_members_changed` on the side-channel
 * scope. Capture both into one sink so order-agnostic membership assertions
 * still see both kinds. Emits are synchronous, so the merged array preserves
 * source order.
 */
function subscribeConversationEvents(
  t: TestApp,
  conversationId: string,
  sink: Array<{ kind: string; payload: unknown }>,
): () => void {
  const offStream = t.ctx.events.subscribe(conversationId, e =>
    sink.push({ kind: e.kind, payload: e.payload }),
  );
  const offSide = t.ctx.events.subscribeScope(conversationSideScope(conversationId), e =>
    sink.push({ kind: e.kind, payload: e.payload }),
  );
  return () => {
    offStream();
    offSide();
  };
}

async function makeAgent(t: TestApp, name: string): Promise<{
  agentId: string;
  dmChannelId: string;
  agentHomeWorkspaceId: string;
}> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  const workspaces = await (await http(t).get('/api/workspaces')).json() as any;
  const home = workspaces.workspaces.find(
    (w: any) =>
      w.workspace_kind === 'agent_home' && w.owner_agent_id === created.agent.id,
  );
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    agentId: created.agent.id,
    dmChannelId: created.dm_channel_id,
    agentHomeWorkspaceId: home.id,
  };
}

async function createRegularWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; onboardingChannelId: string }> {
  const created = await (
    await http(t).post('/api/workspaces', {
      name,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id,
    onboardingChannelId: created.onboarding_channel_id,
  };
}

async function createChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
    })
  ).json() as any;
  return created.channel.id;
}

function membersPath(id: string): string {
  return `/api/conversations/${id}/members`;
}

function agentMemberPath(id: string, agentId: string): string {
  return `/api/conversations/${id}/members/agents/${agentId}`;
}

describe('GET /api/conversations/:id/members', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('returns agents + humans for a regular channel, agents-first order', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'planning', [
      alice.agentId,
      bob.agentId,
    ]);

    const res = await http(t).get(membersPath(channelId));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    // Agents first (joined order), then humans.
    const kinds = members.map((m: any) => m.kind);
    const firstHumanIdx = kinds.indexOf('human');
    const lastAgentIdx = kinds.lastIndexOf('agent');
    expect(lastAgentIdx).toBeGreaterThan(-1);
    expect(firstHumanIdx).toBeGreaterThan(lastAgentIdx);
    // Both agents are present.
    const agentIds = members
      .filter((m: any) => m.kind === 'agent')
      .map((m: any) => m.agent_id);
    expect(agentIds).toContain(alice.agentId);
    expect(agentIds).toContain(bob.agentId);
    // Agent fields are populated for the chip strip.
    const aliceMember = members.find(
      (m: any) => m.kind === 'agent' && m.agent_id === alice.agentId,
    );
    expect(aliceMember).toMatchObject({
      kind: 'agent',
      agent_id: alice.agentId,
      name: 'alice',
      runtime: 'claude',
    });
    expect(typeof aliceMember.display_name).toBe('string');
    // The fixture's `local` user is auto-seeded into every conversation
    // by the test fixture's seed triggers (see tests/utils/db.ts).
    const humanIds = members
      .filter((m: any) => m.kind === 'human')
      .map((m: any) => m.user_id);
    expect(humanIds).toContain('local');
  });

  it("returns dm channel members (agent + viewer)", async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');

    const res = await http(t).get(membersPath(alice.dmChannelId));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    expect(members.find((m: any) => m.kind === 'agent')?.agent_id).toBe(
      alice.agentId,
    );
    const humanIds = members
      .filter((m: any) => m.kind === 'human')
      .map((m: any) => m.user_id);
    expect(humanIds).toContain('local');
  });

  it('returns 404 for a missing conversation id', async () => {
    t = buildTestApp();
    const res = await http(t).get(membersPath('nonexistent-id'));
    expect(res.status).toBe(404);
  });

  it('rejects unauthorized callers with 401 (token guard upstream)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const res = await t.app.fetch(
      new Request(`http://localhost${membersPath(alice.dmChannelId)}`, {
        method: 'GET',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects a non-member user (non-system) with 403', async () => {
    // canViewConversation is strict membership-only for human principals
    // (v25 PR-A tightening). Drop the auto-seed triggers + the viewer's
    // membership rows for the target channel; the route should 403.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-secret', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    // Strip both viewer-seeded edges so the principal is not a member of
    // the workspace nor the conversation.
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);

    const res = await http(t).get(membersPath(channelId));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/conversations/:id/members', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('adds an existing workspace agent to a channel and is duplicate-safe', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'post-agents', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'team-room', [
      alice.agentId,
    ]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const workspaceEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = subscribeConversationEvents(t, channelId, conversationEvents);
    const unsubscribeWorkspace = t.ctx.events.subscribeScope(
      `workspace:${reg.workspaceId}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const add = await http(t).post(membersPath(channelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    unsubscribeConversation();
    unsubscribeWorkspace();
    expect(add.status).toBe(200);
    const body = await add.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'agent')
        .map((m: any) => m.agent_id),
    ).toEqual(expect.arrayContaining([alice.agentId, bob.agentId]));
    const memberAddedMessage = conversationEvents.find(e => e.kind === 'message');
    expect((memberAddedMessage?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '<silverhand://human/local-test> added <silverhand://agent/bob> to this conversation.',
      metadata: {
        subtype: 'conversation_member_added',
        actor_kind: 'user',
        actor_id: 'local',
        actor_name: 'local-test',
        member_kind: 'agent',
        member_id: bob.agentId,
        member_name: 'bob',
      },
    });
    expect(conversationEvents).toContainEqual({
      kind: 'conversation_members_changed',
      payload: {
        conversation_id: channelId,
        workspace_id: reg.workspaceId,
      },
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: reg.workspaceId,
        channel_id: channelId,
      },
    });
    // Universe alignment (§5.2): the member-added notice bumps the main
    // stream head, so EVERY agent member must get a normal delivery —
    // under the signal-only stale contract an undelivered head-bump would
    // 409-block their sends forever.
    const noticeDeliveries = t.fake.delivered.filter(
      d => d.conversationId === channelId,
    );
    expect(noticeDeliveries.map(d => d.agentId).sort()).toEqual(
      [alice.agentId, bob.agentId].sort(),
    );

    const duplicate = await http(t).post(membersPath(channelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    expect(duplicate.status).toBe(200);
    const dupBody = await duplicate.json() as any;
    expect(
      dupBody.members
        .filter((m: any) => m.kind === 'agent' && m.agent_id === bob.agentId),
    ).toHaveLength(1);
    const auditRows = t.ctx.db
      .prepare<[string], { count: number }>(
        `SELECT COUNT(*) AS count
           FROM messages
          WHERE conversation_id = ?
            AND json_extract(metadata, '$.subtype') = 'conversation_member_added'`,
      )
      .get(channelId);
    expect(auditRows?.count).toBe(1);
  });

  it('adds an existing workspace human to a channel', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'post-humans', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'human-room', [
      alice.agentId,
    ]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(channelId, e => {
      conversationEvents.push({ kind: e.kind, payload: e.payload });
    });
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const add = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'teammate',
    });
    unsubscribeConversation();
    expect(add.status).toBe(200);
    const body = await add.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'human')
        .map((m: any) => m.user_id),
    ).toContain('teammate');
    const memberAddedMessage = conversationEvents.find(e => e.kind === 'message');
    expect((memberAddedMessage?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '<silverhand://human/local-test> added <silverhand://human/teammate-test> to this conversation.',
      metadata: {
        subtype: 'conversation_member_added',
        actor_kind: 'user',
        actor_id: 'local',
        actor_name: 'local-test',
        member_kind: 'human',
        member_id: 'teammate',
        member_name: 'teammate-test',
      },
    });
  });

  it('seeds the join-time unread baseline across ALL streams: prior mainline + thread history is NOT unread, only post-join messages count (#task:1404)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'add-unread', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'history-room', [
      alice.agentId,
    ]);
    const messages = new MessageRepo(t.ctx.db);
    // Mainline history that predates the join.
    for (let i = 0; i < 3; i++) {
      messages.insertForConversation({
        conversationId: channelId,
        fromKind: 'agent',
        fromAgentId: alice.agentId,
        content: `mainline before you joined #${i}`,
      });
    }
    // A thread with replies that also predates the join. The thread-chip read
    // model is follow-agnostic, so these must NOT surface as `+n new` for the
    // new member — seeding only the mainline cursor would miss this (Cindy
    // blocking review). Root is a mainline message; its replies form a thread.
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: alice.agentId,
      content: 'thread root before join',
    });
    for (let i = 0; i < 2; i++) {
      messages.insertForConversation({
        conversationId: channelId,
        fromKind: 'agent',
        fromAgentId: alice.agentId,
        content: `reply before you joined #${i}`,
        threadRootId: root.id,
      });
    }
    // Ensure 'teammate' is not yet a conversation member (so the add is real).
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    // Joining must not manufacture unread — no unread_updated for the added
    // viewer, and no perturbation of existing members' badges.
    const teammateFrames: unknown[] = [];
    const localFrames: unknown[] = [];
    const offTeammate = t.ctx.events.subscribeScope('viewer:teammate', e => {
      if (e.kind === 'unread_updated') teammateFrames.push(e.payload);
    });
    const offLocal = t.ctx.events.subscribeScope('viewer:local', e => {
      if (e.kind === 'unread_updated') localFrames.push(e.payload);
    });

    const add = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'teammate',
    });
    offTeammate();
    offLocal();
    expect(add.status).toBe(200);

    const reads = new ConversationReadRepo(t.ctx.db);
    // Baseline seeded across every stream → zero inherited unread anywhere:
    // roll-up (mainline) AND the follow-agnostic thread-chip read model.
    expect(reads.unreadCountForStream(channelId, null, 'teammate')).toBe(0);
    const atJoin = reads.streamUnreadForConversation(channelId, 'teammate');
    expect(atJoin.mainline.unread_count).toBe(0);
    expect(Object.keys(atJoin.threads)).toHaveLength(0);
    // No whole-history unread_updated on join, and existing members untouched.
    expect(teammateFrames).toHaveLength(0);
    expect(localFrames).toHaveLength(0);

    // A mainline message posted AFTER join is the first thing that counts there.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: alice.agentId,
      content: 'mainline after you joined',
    });
    expect(reads.unreadCountForStream(channelId, null, 'teammate')).toBe(1);

    // A reply posted AFTER join is the first thing that counts in that thread —
    // pre-join replies stay read, so the chip shows exactly the new one.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: alice.agentId,
      content: 'reply after you joined',
      threadRootId: root.id,
    });
    const afterReply = reads.streamUnreadForConversation(channelId, 'teammate');
    expect(afterReply.threads[root.id]?.unread_count).toBe(1);
  });

  it('adds an existing workspace human by handle', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'post-human-handle', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'handle-room', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const add = await http(t).post(membersPath(channelId), {
      handle: '@teammate-test',
    });
    expect(add.status).toBe(200);
    const body = await add.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'human')
        .map((m: any) => m.user_id),
    ).toContain('teammate');
  });

  it('auto-adds non-workspace agents and humans for human admins', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'not-workspace-member', [
      alice.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'restricted', [
      alice.agentId,
    ]);

    const agentRes = await http(t).post(membersPath(channelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    expect(agentRes.status).toBe(200);
    const agentBody = await agentRes.json() as any;
    expect(
      agentBody.members
        .filter((m: any) => m.kind === 'agent')
        .map((m: any) => m.agent_id),
    ).toContain(bob.agentId);
    const workspaceAgent = t.ctx.db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
           FROM workspace_members
          WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(reg.workspaceId, bob.agentId);
    expect(workspaceAgent?.count).toBe(1);
    const agentCaps = t.ctx.db
      .prepare<[string, string], { capability: string }>(
        `SELECT capability
           FROM workspace_agent_capabilities
          WHERE workspace_id = ? AND agent_id = ?
          ORDER BY capability ASC`,
      )
      .all(reg.workspaceId, bob.agentId)
      .map(r => r.capability);
    expect(agentCaps).toEqual([...AGENT_CAPABILITIES].sort());

    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(reg.workspaceId, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');
    const viewerEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeViewer = t.ctx.events.subscribeScope(
      'viewer:teammate',
      e => viewerEvents.push({ kind: e.kind, payload: e.payload }),
    );
    const humanRes = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'teammate',
    });
    unsubscribeViewer();
    expect(humanRes.status).toBe(200);
    const humanBody = await humanRes.json() as any;
    expect(
      humanBody.members
        .filter((m: any) => m.kind === 'human')
        .map((m: any) => m.user_id),
    ).toContain('teammate');
    const workspaceUser = t.ctx.db
      .prepare<[string, string], { role: string }>(
        `SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(reg.workspaceId, 'teammate');
    expect(workspaceUser).toEqual({ role: 'member' });
    expect(viewerEvents).toContainEqual({
      kind: 'viewer_workspaces_changed',
      payload: {
        change: 'added',
        workspace_id: reg.workspaceId,
        role: 'member',
      },
    });

    const handleRes = await http(t).post(membersPath(channelId), {
      handle: '@bob',
    });
    expect(handleRes.status).toBe(200);
  });

  it('lets workspace admins auto-add non-workspace humans', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'admin-human-auto-workspace', [
      alice.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'restricted', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = ?`)
      .run(reg.workspaceId, 'local');
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(reg.workspaceId, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const res = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'teammate',
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'human')
        .map((m: any) => m.user_id),
    ).toContain('teammate');
    const workspaceUser = t.ctx.db
      .prepare<[string, string], { role: string }>(
        `SELECT role
           FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(reg.workspaceId, 'teammate');
    expect(workspaceUser).toEqual({ role: 'member' });
  });

  it('returns candidate_not_found for an unknown handle', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'unknown-handle', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'lookup', [
      alice.agentId,
    ]);

    const res = await http(t).post(membersPath(channelId), {
      handle: '@missing-member',
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as any).toMatchObject({
      code: 'candidate_not_found',
    });
  });

  it('rejects dm channels and closed conversations', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'dm-closed-only', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'closed-room', [
      alice.agentId,
    ]);

    const dmRes = await http(t).post(membersPath(alice.dmChannelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    expect(dmRes.status).toBe(422);
    expect((await dmRes.json()) as any).toMatchObject({
      code: 'conversation_member_add_unsupported',
    });

    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
      .run(Date.now(), channelId);
    const closed = await http(t).post(membersPath(channelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    expect(closed.status).toBe(409);
    expect((await closed.json()) as any).toMatchObject({
      code: 'conversation_closed',
    });
  });

  it('rejects callers who are not current channel members', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'actor-member-gate', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'local');

    const res = await http(t).post(membersPath(channelId), {
      kind: 'agent',
      agent_id: bob.agentId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects a workspace member (non-admin) human adding a HUMAN even when they are a channel member (graded-permissions §6.1)', async () => {
    // The people half of the conversation-member-add gate requires the admin
    // effective role for USER principals, on top of conversation visibility.
    // Demote the (channel-member) viewer to `member`: adding a HUMAN must 403.
    // Restore to admin: it succeeds. This pins the role half of the gate
    // independently of the visibility half above.
    //
    // The target is a human on purpose. Since #task:1683 a plain channel member
    // may add their OWN agents, so an agent target created by `local` no longer
    // isolates the role axis; the agent matrix (own → allowed, foreign → 403
    // `agent_not_owned`) lives in `agent-self-service-membership.test.ts`.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'role-gate', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'governed', [
      alice.agentId,
    ]);
    // `local` is a current channel member (seeded) — only the role varies.
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);

    const denied = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'carol',
    });
    expect(denied.status).toBe(403);

    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);
    const allowed = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'carol',
    });
    expect(allowed.status).toBe(200);
  });

  it('allows an agent principal to add workspace members to its current channel', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'agent-can-add', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'agent-room', [
      alice.agentId,
    ]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(channelId, e => {
      conversationEvents.push({ kind: e.kind, payload: e.payload });
    });

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice.agentId),
      { handle: '@bob' },
    );
    unsubscribeConversation();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'agent')
        .map((m: any) => m.agent_id),
    ).toEqual(expect.arrayContaining([alice.agentId, bob.agentId]));
    const memberAddedMessage = conversationEvents.find(e => e.kind === 'message');
    expect((memberAddedMessage?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '<silverhand://agent/alice> added <silverhand://agent/bob> to this conversation.',
      metadata: {
        subtype: 'conversation_member_added',
        actor_kind: 'agent',
        actor_id: alice.agentId,
        actor_name: 'alice',
        member_kind: 'agent',
        member_id: bob.agentId,
        member_name: 'bob',
      },
    });
  });

  it('does not let an agent principal auto-add a non-workspace human by handle', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'agent-no-human-auto-workspace', [
      alice.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'agent-room', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(reg.workspaceId, 'teammate');
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = ?`)
      .run(channelId, 'teammate');

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice.agentId),
      { handle: '@teammate-test' },
    );

    expect(res.status).toBe(422);
    expect((await res.json()) as any).toMatchObject({
      code: 'workspace_membership_required',
    });
    const workspaceUser = t.ctx.db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
           FROM workspace_users
          WHERE workspace_id = ? AND user_id = ?`,
      )
      .get(reg.workspaceId, 'teammate');
    expect(workspaceUser?.count).toBe(0);
  });

  it('does not let an agent principal auto-add a non-workspace agent by handle', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'agent-no-agent-auto-workspace', [
      alice.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'agent-room', [
      alice.agentId,
    ]);

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice.agentId),
      { handle: '@bob' },
    );

    expect(res.status).toBe(422);
    expect((await res.json()) as any).toMatchObject({
      code: 'workspace_membership_required',
    });
    const workspaceAgent = t.ctx.db
      .prepare<[string, string], { count: number }>(
        `SELECT COUNT(*) AS count
           FROM workspace_members
          WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(reg.workspaceId, bob.agentId);
    expect(workspaceAgent?.count).toBe(0);
  });

  it('keeps the agent-facing internal route handle-only', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'agent-handle-only', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'agent-room', [
      alice.agentId,
    ]);

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(channelId, alice.agentId),
      { kind: 'agent', agent_id: bob.agentId },
    );
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/conversations/:id/members/agents/:agentId', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('removes an agent from a channel, stops its runtime, and broadcasts membership changes', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'remove-agent', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'removals', [
      alice.agentId,
      bob.agentId,
    ]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const workspaceEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = subscribeConversationEvents(t, channelId, conversationEvents);
    const unsubscribeWorkspace = t.ctx.events.subscribeScope(
      `workspace:${reg.workspaceId}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const res = await http(t).del(agentMemberPath(channelId, bob.agentId));
    unsubscribeConversation();
    unsubscribeWorkspace();

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(
      body.members
        .filter((m: any) => m.kind === 'agent')
        .map((m: any) => m.agent_id),
    ).toEqual([alice.agentId]);
    expect(t.fake.stops).toContainEqual({
      conversationId: channelId,
      agentId: bob.agentId,
    });
    // Remaining agents get the member-removed notice as a normal delivery
    // (the departed agent is naturally absent from listAgents).
    const removalDeliveries = t.fake.delivered.filter(
      d => d.conversationId === channelId && d.agentId === alice.agentId,
    );
    expect(removalDeliveries.length).toBeGreaterThan(0);
    const memberRemovedMessage = conversationEvents.find(e => e.kind === 'message');
    expect((memberRemovedMessage?.payload as any)?.message).toMatchObject({
      from_kind: 'system',
      content: '<silverhand://human/local-test> removed <silverhand://agent/bob> from this conversation.',
      metadata: {
        subtype: 'conversation_member_removed',
        actor_kind: 'user',
        actor_id: 'local',
        actor_name: 'local-test',
        member_kind: 'agent',
        member_id: bob.agentId,
        member_name: 'bob',
      },
    });
    expect(conversationEvents).toContainEqual({
      kind: 'conversation_members_changed',
      payload: {
        conversation_id: channelId,
        workspace_id: reg.workspaceId,
      },
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: reg.workspaceId,
        channel_id: channelId,
      },
    });
    expect(new ConversationRepo(t.ctx.db).getAgent(channelId, bob.agentId)).toBeNull();
  });

  it('allows the target agent creator even when the viewer is only a workspace member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'remove-creator', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'creator-removes', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);

    const res = await http(t).del(agentMemberPath(channelId, alice.agentId));
    expect(res.status).toBe(200);
    expect(new ConversationRepo(t.ctx.db).getAgent(channelId, alice.agentId)).toBeNull();
  });

  it('allows a workspace admin to remove an agent they did not create', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'remove-admin', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'admin-removes', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`UPDATE agents SET created_by_user_id = 'teammate' WHERE id = ?`)
      .run(alice.agentId);
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'admin' WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);

    const allowed = await http(t).del(agentMemberPath(channelId, alice.agentId));
    expect(allowed.status).toBe(200);

    // Non-member target is a duplicate-safe no-op; it must not stop or
    // emit another audit row.
    t.fake.stops = [];
    const noop = await http(t).del(agentMemberPath(channelId, bob.agentId));
    expect(noop.status).toBe(200);
    expect(t.fake.stops).toEqual([]);
  });

  // #task:975 (P6 pre-refactor characterization): the non-member no-op is a
  // FULL no-op — beyond not stopping the runtime, it must not insert a new
  // system audit message and must not publish ANY conversation/workspace event.
  // The existing admin test only pins `stops === []`; this pins the rest so the
  // removeConversationMember use-case extraction is behavior-preserving on the
  // idempotent short-circuit arm (spec §6 #7).
  it('non-member remove is a full no-op: 200 {members}, no audit message, no events, no stop (#task:975)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'remove-noop', [
      alice.agentId,
      bob.agentId,
    ]);
    // bob is a workspace member but NOT a member of this channel.
    const channelId = await createChannel(t, reg.workspaceId, 'noop-room', [
      alice.agentId,
    ]);

    const messageCount = (): number =>
      (
        t!.ctx.db
          .prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?`)
          .get(channelId) as { c: number }
      ).c;
    const before = messageCount();

    const conversationEvents: Array<{ kind: string }> = [];
    const workspaceEvents: Array<{ kind: string }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(channelId, e => {
      conversationEvents.push({ kind: e.kind });
    });
    const unsubscribeWorkspace = t.ctx.events.subscribeScope(
      `workspace:${reg.workspaceId}`,
      e => workspaceEvents.push({ kind: e.kind }),
    );

    const res = await http(t).del(agentMemberPath(channelId, bob.agentId));
    unsubscribeConversation();
    unsubscribeWorkspace();

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // Members unchanged — still just alice (the lone channel agent).
    expect(
      body.members
        .filter((m: any) => m.kind === 'agent')
        .map((m: any) => m.agent_id),
    ).toEqual([alice.agentId]);
    // No new system audit row.
    expect(messageCount()).toBe(before);
    // No conversation/workspace events of any kind.
    expect(conversationEvents).toEqual([]);
    expect(workspaceEvents).toEqual([]);
    // No runtime stop.
    expect(t.fake.stops).toEqual([]);
  });

  it('rejects a non-creator workspace member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'remove-deny', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'member-denied', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`UPDATE agents SET created_by_user_id = 'teammate' WHERE id = ?`)
      .run(alice.agentId);
    t.ctx.db
      .prepare(`UPDATE workspace_users SET role = 'member' WHERE workspace_id = ? AND user_id = 'local'`)
      .run(reg.workspaceId);

    const res = await http(t).del(agentMemberPath(channelId, alice.agentId));
    expect(res.status).toBe(403);
    expect(new ConversationRepo(t.ctx.db).getAgent(channelId, alice.agentId)).not.toBeNull();
  });

  it('rejects callers who cannot view the conversation even if they created the agent', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'remove-visibility', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'private', [
      alice.agentId,
    ]);
    t.ctx.db
      .prepare(`DELETE FROM conversation_users WHERE conversation_id = ? AND user_id = 'local'`)
      .run(channelId);

    const res = await http(t).del(agentMemberPath(channelId, alice.agentId));
    expect(res.status).toBe(403);
  });

  it('rejects dm channels, closed conversations, and missing agents', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'remove-invalid-targets', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'closed-room', [
      alice.agentId,
    ]);

    const dmRes = await http(t).del(agentMemberPath(alice.dmChannelId, alice.agentId));
    expect(dmRes.status).toBe(422);
    expect((await dmRes.json()) as any).toMatchObject({
      code: 'conversation_member_remove_unsupported',
    });

    const missing = await http(t).del(agentMemberPath(channelId, 'missing-agent'));
    expect(missing.status).toBe(404);
    expect((await missing.json()) as any).toMatchObject({
      code: 'candidate_not_found',
    });

    t.ctx.db
      .prepare(`UPDATE conversations SET closed_at = ? WHERE id = ?`)
      .run(Date.now(), channelId);
    const closed = await http(t).del(agentMemberPath(channelId, alice.agentId));
    expect(closed.status).toBe(409);
    expect((await closed.json()) as any).toMatchObject({
      code: 'conversation_closed',
    });
  });
});
