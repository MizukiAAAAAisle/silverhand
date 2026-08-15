import { afterEach, describe, expect, it } from 'vitest';
import { internalPaths } from '@silverhand/shared';
import { AgentCapabilityRepo } from '../../src/repos/agent-capability-repo.js';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';
import { agentSlotAuth, insertAgentScopedAgent } from '../utils/agent-scope.js';

/**
 * #task:2021 P4-4: `channel create`'s FORK SOURCE is one absolute address.
 *
 * This door is the awkward one, and the reason it cannot be left alone until
 * #task:2030: it has no object id of its own to be addressed by, and it does not
 * post anywhere either. What it does is READ one conversation twice — the
 * placement decides which workspace the new channel is born into, the agent
 * roster decides who it starts with — and until now both came from
 * `principal.conversationId`: a runtime coordinate pretending to be a place the
 * actor chose. The agent-global route now carries no source coordinate.
 *
 * So the differentials here are all of the form "the credential's conversation
 * must not be able to influence the outcome": a source in a DIFFERENT workspace
 * with a DIFFERENT roster, and an anchor that is an agent inbox — no workspace at
 * all — which the old shape refused outright and the addressed shape does not even
 * consult. Plus the two refusals that keep the ambient guess from reappearing one
 * level down (`/thread:` suffix, workspace-less source) and the collapse that
 * keeps the resolver from becoming an existence oracle.
 *
 * HOW FAR the address may reach is the credential's own axis (ruled 2026-08-15,
 * §7.1): `channel_fork_source` from a ConversationSlot acts only in its own
 * stream, so every cross-stream case below carries a real AgentSlot bearer — the
 * credential kind that reaches by participation, and the one an agent-scoped
 * session actually holds. The confinement itself, per door and per slot kind, is
 * `delivery-reach-slot-scope.test.ts`.
 */

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.agent.id;
}

async function makeWorkspace(
  t: TestApp,
  name: string,
  memberAgentIds: string[],
): Promise<{ workspaceId: string; channelId: string }> {
  const created = (await (
    await http(t).post('/api/workspaces', { name, member_agent_ids: memberAgentIds })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: created.workspace.id as string,
    channelId: created.onboarding_channel_id as string,
  };
}

async function makeChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
  visibility?: 'public' | 'private',
): Promise<string> {
  const created = (await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
      ...(visibility === undefined ? {} : { visibility }),
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return created.channel.id as string;
}

/** Fork through the agent door, exactly as the CLI shapes it: the address is a
 *  body field. `target: null` omits it entirely — the hand-rolled-client path,
 *  since the CLI refuses a missing `--target` locally.
 *
 *  `credential.conversationId` is used only to mint a ConversationSlot bearer
 *  when no explicit auth is supplied. The agent-global path carries no
 *  conversation. `channel_fork_source` is confined to a ConversationSlot's own
 *  stream, so every cross-stream case passes a real AgentSlot `auth`. */
function fork(
  t: TestApp,
  credential: { conversationId: string; agentId: string },
  target: string | null,
  title = 'forked',
  auth?: { authorization: string },
): Promise<Response> {
  const requestAuth = auth ?? {
    authorization: `Bearer ${issueTestConversationRuntimeToken(
      t,
      credential.conversationId,
      credential.agentId,
    )}`,
  };
  return http(t, requestAuth).post(
    internalPaths.agentCreateChannel(credential.agentId),
    {
      title,
      context_summary: 'the user asked to split this out',
      initial_prompt: 'continue here',
      ...(target === null ? {} : { target }),
    },
  );
}

function channelTitles(t: TestApp, workspaceId: string): string[] {
  return new ConversationRepo(t.ctx.db)
    .listAllChannelsForWorkspace(workspaceId)
    .map(c => c.title);
}

async function rosterOf(t: TestApp, channelId: string): Promise<string[]> {
  const agents = (await (
    await http(t).get(`/api/channels/${channelId}/agents`)
  ).json()) as any;
  return agents.agents.map((a: any) => a.agent_id as string).sort();
}

describe('internal create-channel — the address is the fork source', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('is born in the ADDRESSED source\'s workspace with the ADDRESSED source\'s roster', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const bob = await makeAgent(t, 'bob');
    // Two workspaces so "workspace" cannot be right by coincidence, and two
    // different rosters so "members" cannot either.
    const anchorWs = await makeWorkspace(t, 'where-i-run', [alice]);
    const sourceWs = await makeWorkspace(t, 'where-the-fork-lives', [alice, bob]);
    const source = await makeChannel(t, sourceWs.workspaceId, 'the-source', [alice, bob]);

    const res = await fork(
      t,
      { conversationId: anchorWs.channelId, agentId: alice },
      `#conv:${source}`,
      'release signing',
      agentSlotAuth(t, alice),
    );
    expect(res.status).toBe(200);
    const { channel_id } = (await res.json()) as { channel_id: string };

    const created = (await (
      await http(t).get(`/api/channels/${channel_id}`)
    ).json()) as any;
    expect(created.channel.workspace_id).toBe(sourceWs.workspaceId);
    expect(await rosterOf(t, channel_id)).toEqual([alice, bob].sort());
    // …and nothing appeared where the credential happens to live.
    expect(channelTitles(t, anchorWs.workspaceId)).not.toContain('release signing');
    // The seed quotes the SOURCE, not the anchor — the audit trail has to name
    // the conversation that was actually forked.
    const msgs = (await (
      await http(t).get(`/api/channels/${channel_id}/messages`)
    ).json()) as any;
    expect(msgs.messages[0].content).toContain('the-source');
  });

  it('uses no ambient AgentSlot coordinate when choosing the fork source', async () => {
    // The AgentSlot credential carries no conversation. Only the addressed
    // source can determine the workspace and initial roster.
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const ws = await makeWorkspace(t, 'inbox-anchored', [alice]);
    const inbox = new ConversationRepo(t.ctx.db).getAgentInbox(alice);
    expect(inbox).not.toBeNull();

    const res = await fork(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${ws.channelId}`,
      'forked from an inbox session',
      agentSlotAuth(t, alice),
    );
    expect(res.status).toBe(200);
    const { channel_id } = (await res.json()) as { channel_id: string };
    const created = (await (
      await http(t).get(`/api/channels/${channel_id}`)
    ).json()) as any;
    expect(created.channel.workspace_id).toBe(ws.workspaceId);
  });

  it('answers a source it cannot post to exactly like one that does not exist', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'unknown-equals-unauthorized-fork', [alice, bob]);
    const mine = await makeChannel(t, ws.workspaceId, 'mine', [alice]);
    const theirs = await makeChannel(t, ws.workspaceId, 'theirs', [bob]);

    const unauthorized = await fork(
      t,
      { conversationId: mine, agentId: alice },
      `#conv:${theirs}`,
    );
    const unknown = await fork(
      t,
      { conversationId: mine, agentId: alice },
      '#conv:AAAAAAAAAAAAAAAA',
    );

    expect(unauthorized.status).toBe(404);
    expect(unknown.status).toBe(404);
    // Byte-identical, not merely same-coded: a differing message tells a
    // non-participant that the stream exists — and here it would also leak its
    // roster, since a successful fork copies it.
    expect(await unauthorized.text()).toBe(await unknown.text());
    expect(channelTitles(t, ws.workspaceId)).not.toContain('forked');
  });

  it('refuses a /thread: suffix instead of quietly forking the parent', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'suffix-refused-fork', [alice]);
    const root = (await (
      await http(t).post(`/api/channels/${ws.channelId}/messages`, { content: 'root' })
    ).json()) as any;

    const res = await fork(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${ws.channelId}/thread:${root.message.id}`,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      code: 'thread_suffix_not_supported',
    });
    // A reply cluster has neither a placement nor a member set of its own, so
    // honouring the suffix would mean forking its parent — the ambient guess one
    // level down, under a name that looks precise.
    expect(channelTitles(t, ws.workspaceId)).not.toContain('forked');
  });

  it('refuses a workspace-less source rather than guessing a workspace', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const ws = await makeWorkspace(t, 'inbox-source-refused', [alice]);
    const inbox = new ConversationRepo(t.ctx.db).getAgentInbox(alice);

    const res = await fork(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${inbox!.id}`,
      'forked',
      agentSlotAuth(t, alice),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as any).toMatchObject({
      code: 'workspace_scope_required',
    });
  });

  it('collapses a merely DISCOVERABLE public channel into the same 404', async () => {
    // The floor is resolution's participation predicate, whose workspace arm is
    // the `conversation_agents` roster edge — not visibility. A public channel
    // alice never joined is listable (discovery) and must still be unforkable,
    // with the SAME answer an id nobody holds gets: forking copies the roster, so
    // a distinguishable refusal would leak both existence and membership.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'discoverable-not-forkable', [alice, bob]);
    const publicChannel = await makeChannel(t, ws.workspaceId, 'open-house', [bob], 'public');

    const listed = (await (
      await http(t).get(
        `${internalPaths.agentListChannels(alice)}?workspace_id=${ws.workspaceId}`,
      )
    ).json()) as any;
    expect(
      listed.channels.find((ch: any) => ch.id === publicChannel),
    ).toMatchObject({ is_member: false, visibility: 'public' });

    const discovered = await fork(
      t,
      { conversationId: ws.channelId, agentId: alice },
      `#conv:${publicChannel}`,
    );
    const unknown = await fork(
      t,
      { conversationId: ws.channelId, agentId: alice },
      '#conv:AAAAAAAAAAAAAAAA',
    );
    expect(discovered.status).toBe(404);
    expect(await discovered.text()).toBe(await unknown.text());
  });

  it('opens no pair: the fork source is READ, and reads never allocate', async () => {
    // `dm:@handle` is the one arm of the grammar that can bring a conversation
    // into existence, and it must not do so here: nothing is posted into the
    // source, and a pair has no workspace, so an allocating resolve would leave a
    // brand-new conversation behind a `workspace_scope_required` refusal.
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const bob = await makeAgent(t, 'bob');
    const ws = await makeWorkspace(t, 'no-allocation-fork', [alice, bob]);
    const repo = new ConversationRepo(t.ctx.db);
    expect(repo.findDirectPair({ kind: 'agent', id: alice }, { kind: 'agent', id: bob })).toBeNull();

    const res = await fork(t, { conversationId: ws.channelId, agentId: alice }, 'dm:@bob');
    expect(res.status).toBe(404);
    expect(
      repo.findDirectPair({ kind: 'agent', id: alice }, { kind: 'agent', id: bob }),
    ).toBeNull();
  });

  it('has no default source: an absent target is invalid input', async () => {
    t = buildTestApp();
    const alice = await makeAgent(t, 'alice');
    const ws = await makeWorkspace(t, 'no-default-fork', [alice]);

    const res = await fork(t, { conversationId: ws.channelId, agentId: alice }, null);
    expect(res.status).toBe(400);
    expect(channelTitles(t, ws.workspaceId)).not.toContain('forked');
  });

  it('judges create_channels in the SOURCE workspace, not the credential one', async () => {
    t = buildTestApp();
    const seed = await makeAgent(t, 'seed');
    const alice = insertAgentScopedAgent(t, seed, 'alice');
    const anchor = await makeWorkspace(t, 'anchor-home', [alice]);
    const source = await makeWorkspace(t, 'source-away', [alice]);
    const caps = new AgentCapabilityRepo(t.ctx.db);
    const auth = agentSlotAuth(t, alice);

    // Everything at home, nothing where the fork is actually happening.
    caps.replaceSet(source.workspaceId, alice, ['read_messages']);
    const denied = await fork(
      t,
      { conversationId: anchor.channelId, agentId: alice },
      `#conv:${source.channelId}`,
      'forked',
      auth,
    );
    expect(denied.status).toBe(403);
    expect((await denied.json()) as any).toMatchObject({
      code: 'capability_denied',
      capability: 'create_channels',
    });
    expect(channelTitles(t, source.workspaceId)).not.toContain('forked');

    // Positive control, inverted: the grant that matters is the source's, and the
    // credential's workspace losing it changes nothing.
    caps.replaceSet(source.workspaceId, alice, ['create_channels', 'read_messages']);
    caps.replaceSet(anchor.workspaceId, alice, ['read_messages']);
    const ok = await fork(
      t,
      { conversationId: anchor.channelId, agentId: alice },
      `#conv:${source.channelId}`,
      'forked',
      auth,
    );
    expect(ok.status).toBe(200);
    expect(channelTitles(t, source.workspaceId)).toContain('forked');
  });
});
