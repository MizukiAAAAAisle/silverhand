import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

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

function createThreadWithMembers(
  t: TestApp,
  channelId: string,
  memberAgentIds: string[],
  memberUserIds: string[] = ['local'],
): string {
  const conversations = new ConversationRepo(t.ctx.db);
  const thread = conversations.insertThread({
    channelId,
    title: 'member-thread',
  });
  for (const agentId of memberAgentIds) {
    conversations.addAgent(thread.id, agentId);
  }
  for (const userId of memberUserIds) {
    conversations.addUser(thread.id, userId);
  }
  return thread.id;
}

function membersPath(id: string): string {
  return `/api/conversations/${id}/members`;
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

  it('returns the same shape for a thread (members snapshotted from parent at create)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-y', [alice.agentId]);
    const channelId = await createChannel(t, reg.workspaceId, 'investigations', [
      alice.agentId,
    ]);
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId,
      title: 'perf-dive',
    });
    // Snapshot the parent's agents into the thread (the production path
    // goes via ThreadService; here the unit test uses ConversationRepo
    // directly, then opts into the same per-thread membership rows).
    for (const ca of conversations.listAgents(channelId)) {
      conversations.addAgent(thread.id, ca.agent_id);
    }

    const res = await http(t).get(membersPath(thread.id));
    expect(res.status).toBe(200);
    const { members } = await res.json() as any;
    const agents = members.filter((m: any) => m.kind === 'agent');
    expect(agents.map((m: any) => m.agent_id)).toEqual([alice.agentId]);
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
    const unsubscribeConversation = t.ctx.events.subscribe(channelId, e => {
      conversationEvents.push({ kind: e.kind, payload: e.payload });
    });
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
      content: '@local-test added @bob to this conversation.',
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
      content: '@local-test added @teammate-test to this conversation.',
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

  it('adds an existing workspace agent to a thread', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'post-thread-agent', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'thread-parent', [
      alice.agentId,
    ]);
    const threadId = createThreadWithMembers(t, channelId, [alice.agentId]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const workspaceEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(threadId, e => {
      conversationEvents.push({ kind: e.kind, payload: e.payload });
    });
    const unsubscribeWorkspace = t.ctx.events.subscribeScope(
      `workspace:${reg.workspaceId}`,
      e => workspaceEvents.push({ kind: e.kind, payload: e.payload }),
    );

    const add = await http(t).post(membersPath(threadId), {
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
      metadata: {
        subtype: 'conversation_member_added',
        actor_kind: 'user',
        actor_id: 'local',
        member_kind: 'agent',
        member_id: bob.agentId,
      },
    });
    expect(conversationEvents).toContainEqual({
      kind: 'conversation_members_changed',
      payload: {
        conversation_id: threadId,
        workspace_id: reg.workspaceId,
      },
    });
    expect(workspaceEvents).toContainEqual({
      kind: 'workspace_channels_changed',
      payload: {
        workspace_id: reg.workspaceId,
        channel_id: threadId,
      },
    });
  });

  it('rejects candidates that are not workspace members', async () => {
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
    expect(agentRes.status).toBe(422);
    expect((await agentRes.json()) as any).toMatchObject({
      code: 'workspace_membership_required',
    });

    t.ctx.db
      .prepare(`DELETE FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .run(reg.workspaceId, 'teammate');
    const humanRes = await http(t).post(membersPath(channelId), {
      kind: 'human',
      user_id: 'teammate',
    });
    expect(humanRes.status).toBe(422);
    expect((await humanRes.json()) as any).toMatchObject({
      code: 'workspace_membership_required',
    });

    const handleRes = await http(t).post(membersPath(channelId), {
      handle: '@bob',
    });
    expect(handleRes.status).toBe(422);
    expect((await handleRes.json()) as any).toMatchObject({
      code: 'workspace_membership_required',
    });
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
      content: '@alice added @bob to this conversation.',
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

  it('allows an agent principal to add workspace members to its current thread', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'agent-can-add-thread', [
      alice.agentId,
      bob.agentId,
    ]);
    const channelId = await createChannel(t, reg.workspaceId, 'agent-thread-parent', [
      alice.agentId,
    ]);
    const threadId = createThreadWithMembers(t, channelId, [alice.agentId]);
    const conversationEvents: Array<{ kind: string; payload: unknown }> = [];
    const unsubscribeConversation = t.ctx.events.subscribe(threadId, e => {
      conversationEvents.push({ kind: e.kind, payload: e.payload });
    });

    const res = await http(t).post(
      internalPaths.agentAddConversationMember(threadId, alice.agentId),
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
