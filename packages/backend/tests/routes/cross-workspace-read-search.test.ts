import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
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

function readHistoryPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/read-history`;
}

function searchMessagesPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/search-messages`;
}

describe('PR-B: cross-workspace read_history({target:{conversation_id}})', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('reads a channel in another workspace where the agent is a current conversation member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const otherChannel = await createChannel(t, reg.workspaceId, 'eng', [alice.agentId]);
    const messages = new MessageRepo(t.ctx.db);
    const hit = messages.insertForConversation({
      conversationId: otherChannel,
      fromKind: 'user',
      content: 'hello cross-workspace world',
    });

    // Source = alice's own DM (agent_home workspace); target = the
    // regular workspace channel.
    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: { conversation_id: otherChannel },
      around_message_id: hit.id,
      include_content: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.conversation_id).toBe(otherChannel);
    expect(body.target.workspace_id).toBe(reg.workspaceId);
    expect(body.messages.map((m: any) => m.message_ref.id)).toContain(hit.id);
    const hitMsg = body.messages.find((m: any) => m.message_ref.id === hit.id);
    expect(hitMsg.content).toBe('hello cross-workspace world');
  });

  it('reads a thread by conversation_id even when the agent is not in its parent channel', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    // Channel only bob is in; alice is added to a thread off it directly
    // via the repo so we can construct the "parent-not-member" topology
    // (the create-thread route would refuse to seed a non-parent-member).
    const bobOnly = await createChannel(t, reg.workspaceId, 'bob-only', [bob.agentId]);
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId: bobOnly,
      title: 'mixed',
    });
    conversations.addAgent(thread.id, bob.agentId);
    conversations.addAgent(thread.id, alice.agentId);

    const messages = new MessageRepo(t.ctx.db);
    const hit = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'user',
      content: 'thread message alice should see',
    });

    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: { conversation_id: thread.id },
      around_message_id: hit.id,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.target.conversation_id).toBe(thread.id);
    expect(body.target.thread_id).toBe(thread.id);
    expect(body.target.channel_id).toBe(bobOnly);
    expect(body.messages.map((m: any) => m.message_ref.id)).toContain(hit.id);
  });

  it('returns 403 when the agent is not a member of the target conversation', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const bobOnly = await createChannel(t, reg.workspaceId, 'bob-only', [bob.agentId]);
    const messages = new MessageRepo(t.ctx.db);
    const hit = messages.insertForConversation({
      conversationId: bobOnly,
      fromKind: 'agent',
      fromAgentId: bob.agentId,
      content: 'bob-only content',
    });

    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: { conversation_id: bobOnly },
      around_message_id: hit.id,
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.code).toBe('not_target_conversation_member');
  });

  it('returns 404 when conversation_id does not exist', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // Need a real anchor; insert into reg.onboardingChannelId so seq is valid.
    const messages = new MessageRepo(t.ctx.db);
    const anchor = messages.insertForConversation({
      conversationId: reg.onboardingChannelId,
      fromKind: 'user',
      content: 'anchor',
    });

    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: { conversation_id: 'does-not-exist' },
      around_message_id: anchor.id,
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.code).toBe('conversation_not_found');
  });

  it('resolves self/parent and rejects legacy {thread_id} targets with a deprecation error', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const channel = await createChannel(t, reg.workspaceId, 'main', [alice.agentId]);
    const thread = await (
      await http(t).post(
        `/internal/conversations/${channel}/agents/${alice.agentId}/create-thread`,
        {
          title: 'child',
          members: [alice.agentId],
          context_summary: 'x',
          initial_prompt: 'thread seed',
        },
      )
    ).json() as any;
    const messages = new MessageRepo(t.ctx.db);
    const channelMsg = messages.insertForConversation({
      conversationId: channel,
      fromKind: 'user',
      content: 'channel anchor',
    });
    const threadMsg = messages.insertForConversation({
      conversationId: thread.thread_id,
      fromKind: 'user',
      content: 'thread anchor',
    });

    // self from channel
    const selfRes = await http(t).post(readHistoryPath(channel, alice.agentId), {
      around_message_id: channelMsg.id,
    });
    expect(selfRes.status).toBe(200);
    expect((await selfRes.json() as any).target.conversation_id).toBe(channel);

    // parent from thread
    const parentRes = await http(t).post(readHistoryPath(thread.thread_id, alice.agentId), {
      target: 'parent',
      around_message_id: channelMsg.id,
    });
    expect(parentRes.status).toBe(200);
    expect((await parentRes.json() as any).target.conversation_id).toBe(channel);

    // Legacy isolated thread conversations remain readable via
    // {conversation_id}, but the thread:<id> / {thread_id} target form is
    // now reserved for reply-cluster root ids.
    const threadRes = await http(t).post(readHistoryPath(channel, alice.agentId), {
      target: { thread_id: thread.thread_id },
      around_message_id: threadMsg.id,
    });
    expect(threadRes.status).toBe(400);
    const threadBody = await threadRes.json() as any;
    expect(threadBody.code).toBe('legacy_thread_target_deprecated');
    expect(threadBody.error).toContain(`conversation:${thread.thread_id}`);

    const conversationRes = await http(t).post(readHistoryPath(channel, alice.agentId), {
      target: { conversation_id: thread.thread_id },
      around_message_id: threadMsg.id,
    });
    expect(conversationRes.status).toBe(200);
    expect((await conversationRes.json() as any).target.conversation_id)
      .toBe(thread.thread_id);
  });

  it('rejects {conversation_id} pointing at the workspace itself or other unsupported kinds', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    // workspaces are not conversations — try with reg.workspaceId, should 404.
    const messages = new MessageRepo(t.ctx.db);
    const anchor = messages.insertForConversation({
      conversationId: reg.onboardingChannelId,
      fromKind: 'user',
      content: 'anchor',
    });
    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: { conversation_id: reg.workspaceId },
      around_message_id: anchor.id,
    });
    expect(res.status).toBe(404);
  });
});

describe('PR-B: cross-workspace search_messages({workspace_id?})', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('searches a different workspace when scope=workspace + workspace_id is supplied and the agent has access', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const messages = new MessageRepo(t.ctx.db);
    const remoteHit = messages.insertForConversation({
      conversationId: reg.onboardingChannelId,
      fromKind: 'user',
      content: 'cross-workspace-search-token in regular workspace',
    });
    // Same query string in alice's home DM should NOT appear because
    // we're searching the regular workspace explicitly.
    messages.insertForConversation({
      conversationId: alice.dmChannelId,
      fromKind: 'user',
      content: 'cross-workspace-search-token in home',
    });

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'cross-workspace-search-token',
      scope: 'workspace',
      workspace_id: reg.workspaceId,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('workspace');
    expect(body.workspace_id).toBe(reg.workspaceId);
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([remoteHit.id]);
    expect(body.hits[0].message_ref.workspace_id).toBe(reg.workspaceId);
  });

  it('rejects cross-workspace search to a workspace the agent is not a member of with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const bobOnly = await createRegularWorkspace(t, 'bob-only', [bob.agentId]);

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'whatever',
      scope: 'workspace',
      workspace_id: bobOnly.workspaceId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects cross-workspace search targeting another agent\'s agent_home with 403', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'whatever',
      scope: 'workspace',
      workspace_id: bob.agentHomeWorkspaceId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects workspace_id with scope!=workspace as 400 (input schema)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    const withCurrent = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        scope: 'current',
        workspace_id: reg.workspaceId,
      },
    );
    expect(withCurrent.status).toBe(400);

    const withChannel = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        scope: 'channel',
        channel_id: reg.onboardingChannelId,
        workspace_id: reg.workspaceId,
      },
    );
    expect(withChannel.status).toBe(400);
  });

  it('defaults workspace_id to the source workspace when omitted (back-compat)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const messages = new MessageRepo(t.ctx.db);
    const homeHit = messages.insertForConversation({
      conversationId: alice.dmChannelId,
      fromKind: 'user',
      content: 'default-workspace-token',
    });

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'default-workspace-token',
      scope: 'workspace',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.workspace_id).toBe(alice.agentHomeWorkspaceId);
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([homeHit.id]);
  });

  it('search hits in the target workspace are still gated by conversation_agents membership', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    // Both agents in workspace; channel restricted to bob only.
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const bobOnly = await createChannel(t, reg.workspaceId, 'bob-only', [bob.agentId]);
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: bobOnly,
      fromKind: 'agent',
      fromAgentId: bob.agentId,
      content: 'membership-guard-token bob only',
    });
    const sharedHit = messages.insertForConversation({
      conversationId: reg.onboardingChannelId,
      fromKind: 'user',
      content: 'membership-guard-token shared channel',
    });

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'membership-guard-token',
      scope: 'workspace',
      workspace_id: reg.workspaceId,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([sharedHit.id]);
  });

  it('scope=channel accepts a channel_id from another workspace where the agent is a member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const remoteChannel = await createChannel(t, reg.workspaceId, 'eng', [
      alice.agentId,
    ]);
    // Spawn a child thread alice is in too, to verify the SQL still
    // sweeps visible child threads of the remote channel.
    const conversations = new ConversationRepo(t.ctx.db);
    const thread = conversations.insertThread({
      channelId: remoteChannel,
      title: 'child',
    });
    conversations.addAgent(thread.id, alice.agentId);
    const messages = new MessageRepo(t.ctx.db);
    const channelHit = messages.insertForConversation({
      conversationId: remoteChannel,
      fromKind: 'user',
      content: 'remote-channel-search-token in channel',
    });
    const threadHit = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'user',
      content: 'remote-channel-search-token in child thread',
    });
    // Same token in alice's home DM must NOT appear under channel
    // scope.
    messages.insertForConversation({
      conversationId: alice.dmChannelId,
      fromKind: 'user',
      content: 'remote-channel-search-token in home DM',
    });

    const res = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'remote-channel-search-token',
        scope: 'channel',
        channel_id: remoteChannel,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('channel');
    expect(body.channel_id).toBe(remoteChannel);
    expect(body.hits.map((h: any) => h.message_ref.id).sort()).toEqual(
      [channelHit.id, threadHit.id].sort(),
    );
    // Each hit's channel_id must point at the remote channel, not
    // the source DM channel.
    for (const h of body.hits) {
      expect(h.message_ref.channel_id).toBe(remoteChannel);
    }
  });

  it('scope=channel still 403s on a remote channel the agent is not a member of', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const bobOnly = await createChannel(t, reg.workspaceId, 'bob-only', [bob.agentId]);

    // Alice has workspace-level access to team-x but not to bobOnly.
    // Channel scope must reject — conversation_agents is the bottom
    // guard regardless of workspace.
    const res = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        scope: 'channel',
        channel_id: bobOnly,
      },
    );
    expect(res.status).toBe(403);
  });
});
