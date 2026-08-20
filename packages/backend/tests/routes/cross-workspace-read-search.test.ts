import { afterEach, describe, expect, it } from 'vitest';
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
    (w: any) => w.owner_agent_id === created.agent.id,
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
  return `/internal/agents/${agentId}/read-history`;
}

function searchMessagesPath(conversationId: string, agentId: string): string {
  return `/internal/agents/${agentId}/search-messages`;
}

/** Well-formed (16 base64url chars) and names no row — the grammar must pass so
 *  the refusal comes from the LOOKUP, not from the shape. */
const MISSING_ID = 'zzzzMISSINGzzz01';

describe('PR-B: cross-workspace read_history by address', () => {
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
      target: `#conv:${otherChannel}`,
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

  // Behavior change (#task:2021 P4-4): this was a 403
  // `not_target_conversation_member`, distinct from the 404 an unknown id got —
  // which made the pair an existence oracle over every conversation id in the
  // installation. Both are now the same 404, asserted byte-identical below.
  it('refuses a conversation the agent is not a member of, indistinguishably from an unknown id', async () => {
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

    const forbidden = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: `#conv:${bobOnly}`,
      around_message_id: hit.id,
    });
    const unknown = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: `#conv:${MISSING_ID}`,
      around_message_id: hit.id,
    });
    expect(forbidden.status).toBe(404);
    expect(unknown.status).toBe(forbidden.status);
    // Bodies compared as BYTES: a field order difference or an extra key would be
    // enough to tell the two apart, and comparing parsed objects would not see it.
    expect(await forbidden.text()).toEqual(await unknown.text());
    expect(await (await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: `#conv:${bobOnly}`,
      around_message_id: hit.id,
    })).json()).toEqual({ error: expect.any(String), code: 'target_unresolved' });
  });

  it('refuses an id that names no conversation', async () => {
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
      target: `#conv:${MISSING_ID}`,
      around_message_id: anchor.id,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: expect.any(String),
      code: 'target_unresolved',
    });
    // A string that is not an address at all is a DIFFERENT outcome, and stays
    // distinct on purpose: no lookup happened, so it reveals nothing.
    const malformed = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: 'does-not-exist',
      around_message_id: anchor.id,
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).code).toBe('target_malformed');
  });

  it('treats a workspace id in the conversation slot as an id that names no stream', async () => {
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
    // A workspace id is well-formed as an id (same 16-char domain) and names no
    // conversation — so it is not a special "unsupported kind", it is the unknown
    // case, and must be indistinguishable from it.
    const res = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: `#conv:${reg.workspaceId}`,
      around_message_id: anchor.id,
    });
    const unknown = await http(t).post(readHistoryPath(alice.dmChannelId, alice.agentId), {
      target: `#conv:${MISSING_ID}`,
      around_message_id: anchor.id,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toEqual(await unknown.text());
  });
});

describe('PR-B: cross-workspace search_messages (selector-only range)', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('searches a different workspace when workspace_id is supplied and the agent has access', async () => {
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
      workspace_id: bob.agentHomeWorkspaceId,
    });
    expect(res.status).toBe(403);
  });

  it('rejects two selectors, and the retired scope/channel_id keys, as 400 (input schema)', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);

    // Two selectors name two ranges — there is no precedence rule to fall
    // back on, so the request is refused rather than silently picking one.
    const twoSelectors = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        conversation_id: reg.onboardingChannelId,
        workspace_id: reg.workspaceId,
      },
    );
    expect(twoSelectors.status).toBe(400);

    const bothWorkspaceForms = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        current_workspace: true,
        workspace_id: reg.workspaceId,
      },
    );
    expect(bothWorkspaceForms.status).toBe(400);

    // The retired mode+selector spelling must fail LOUDLY. If the schema
    // merely stripped these keys, a stale caller asking for a workspace or
    // channel search would silently get the calling conversation instead.
    const retiredScope = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      { q: 'whatever', scope: 'workspace', workspace_id: reg.workspaceId },
    );
    expect(retiredScope.status).toBe(400);

    const retiredChannelId = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      { q: 'whatever', channel_id: reg.onboardingChannelId },
    );
    expect(retiredChannelId.status).toBe(400);

    // `current_workspace: false` is not "the default spelled out" — the
    // presence of the key IS the signal, so only `true` is accepted.
    const explicitFalse = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      { q: 'whatever', current_workspace: false },
    );
    expect(explicitFalse.status).toBe(400);
  });

  it('current_workspace: true searches the source workspace', async () => {
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
      current_workspace: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('workspace');
    expect(body.workspace_id).toBe(alice.agentHomeWorkspaceId);
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([homeHit.id]);
  });

  it('omitting every selector searches the calling conversation', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const messages = new MessageRepo(t.ctx.db);
    const dmHit = messages.insertForConversation({
      conversationId: alice.dmChannelId,
      fromKind: 'user',
      content: 'no-selector-token in the calling DM',
    });
    // Same token elsewhere in the same agent's reach must NOT appear:
    // absence of a selector means the calling conversation, not "everything
    // I can see".
    messages.insertForConversation({
      conversationId: reg.onboardingChannelId,
      fromKind: 'user',
      content: 'no-selector-token in another workspace',
    });

    const res = await http(t).post(searchMessagesPath(alice.dmChannelId, alice.agentId), {
      q: 'no-selector-token',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('current');
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([dmHit.id]);
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
      workspace_id: reg.workspaceId,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([sharedHit.id]);
  });

  it('conversation_id accepts a conversation in another workspace where the agent is a member', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId]);
    const remoteChannel = await createChannel(t, reg.workspaceId, 'eng', [
      alice.agentId,
    ]);
    const messages = new MessageRepo(t.ctx.db);
    const channelHit = messages.insertForConversation({
      conversationId: remoteChannel,
      fromKind: 'user',
      content: 'remote-channel-search-token in channel',
    });
    // Same token in alice's home DM must NOT appear: the conversation
    // selector IS the range.
    messages.insertForConversation({
      conversationId: alice.dmChannelId,
      fromKind: 'user',
      content: 'remote-channel-search-token in home DM',
    });

    const res = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'remote-channel-search-token',
        conversation_id: remoteChannel,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('conversation');
    expect(body.conversation_id).toBe(remoteChannel);
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([channelHit.id]);
    // Each hit's channel_id must point at the remote channel, not
    // the source DM channel.
    for (const h of body.hits) {
      expect(h.message_ref.channel_id).toBe(remoteChannel);
    }
  });

  it('conversation_id still 403s on a remote conversation the agent is not a member of', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const reg = await createRegularWorkspace(t, 'team-x', [alice.agentId, bob.agentId]);
    const bobOnly = await createChannel(t, reg.workspaceId, 'bob-only', [bob.agentId]);

    // Alice has workspace-level access to team-x but not to bobOnly.
    // The conversation selector must reject — conversation_agents is the
    // bottom guard regardless of workspace.
    const res = await http(t).post(
      searchMessagesPath(alice.dmChannelId, alice.agentId),
      {
        q: 'whatever',
        conversation_id: bobOnly,
      },
    );
    expect(res.status).toBe(403);
  });
});
