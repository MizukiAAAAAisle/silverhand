import { afterEach, describe, expect, it } from 'vitest';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json() as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
): Promise<{ workspaceId: string; channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = await (
    await http(t).post('/api/workspaces', {
      name: `search-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json() as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
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

async function createPublicChannel(
  t: TestApp,
  workspaceId: string,
  title: string,
  memberAgentIds: string[],
): Promise<string> {
  const created = await (
    await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
      title,
      member_agent_ids: memberAgentIds,
      visibility: 'public',
    })
  ).json() as any;
  return created.channel.id;
}

function listChannelsPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/list-channels`;
}

function searchMessagesPath(conversationId: string, agentId: string): string {
  return `/internal/conversations/${conversationId}/agents/${agentId}/search-messages`;
}

describe('agent list_channels / search_messages routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('includes member channels (incl. archived) and excludes non-member private channels', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const aliceOnly = await createChannel(t, workspaceId, 'alice-only', [aliceId]);
    const bobOnly = await createChannel(t, workspaceId, 'bob-only', [bobId]);
    await http(t).patch(`/api/channels/${aliceOnly}/archive`, { archived: true });

    const res = await http(t).get(listChannelsPath(channelId, aliceId));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const ids = body.channels.map((c: any) => c.id);
    expect(ids).toContain(channelId);
    expect(ids).toContain(aliceOnly);
    expect(ids).not.toContain(bobOnly);
    expect(body.channels.find((c: any) => c.id === aliceOnly)).toMatchObject({
      title: 'alice-only',
      kind: 'channel',
      archived: true,
    });
  });

  it('unions member channel-like with unjoined active public channels, is_member from membership not arm', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;

    // member arm — any visibility, archived included
    const joinedPrivate = await createChannel(t, workspaceId, 'joined-private', [
      aliceId,
    ]);
    const joinedPublic = await createPublicChannel(t, workspaceId, 'joined-public', [
      aliceId,
    ]);
    const joinedArchived = await createChannel(t, workspaceId, 'joined-archived', [
      aliceId,
    ]);
    await http(t).patch(`/api/channels/${joinedArchived}/archive`, {
      archived: true,
    });

    // discovery arm — unjoined active public channel
    const unjoinedPublic = await createPublicChannel(
      t,
      workspaceId,
      'unjoined-public',
      [bobId],
    );

    // excluded — unjoined private, and unjoined archived public (no discovery arm)
    const unjoinedPrivate = await createChannel(t, workspaceId, 'unjoined-private', [
      bobId,
    ]);
    const unjoinedPublicArchived = await createPublicChannel(
      t,
      workspaceId,
      'unjoined-public-archived',
      [bobId],
    );
    await http(t).patch(`/api/channels/${unjoinedPublicArchived}/archive`, {
      archived: true,
    });

    // excluded — an unjoined DM (dm_channel is always private; the discovery
    // arm is kind='channel' only, so a DM never enters via discovery, and alice
    // is not a member so the member arm skips it too).
    const unjoinedDm = new ConversationRepo(t.ctx.db).insertDmChannel({
      workspaceId,
      title: 'unjoined-dm',
    });

    const res = await http(t).get(listChannelsPath(channelId, aliceId));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const byId = new Map(body.channels.map((c: any) => [c.id, c]));

    // member arm: present, is_member true, visibility preserved
    expect(byId.get(joinedPrivate)).toMatchObject({
      is_member: true,
      visibility: 'private',
      archived: false,
    });
    // a joined PUBLIC channel is is_member:true — not demoted by matching the
    // public predicate first
    expect(byId.get(joinedPublic)).toMatchObject({
      is_member: true,
      visibility: 'public',
      archived: false,
    });
    // discovery arm: the public-but-not-joined state
    expect(byId.get(unjoinedPublic)).toMatchObject({
      is_member: false,
      visibility: 'public',
      archived: false,
    });

    // excluded rows
    expect(byId.has(unjoinedPrivate)).toBe(false);
    expect(byId.has(unjoinedPublicArchived)).toBe(false);
    expect(byId.has(unjoinedDm.id)).toBe(false);

    // member archived channel present, is_member true, and sorted last
    expect(byId.get(joinedArchived)).toMatchObject({
      is_member: true,
      archived: true,
    });
    const archivedIndex = body.channels.findIndex(
      (c: any) => c.id === joinedArchived,
    );
    const lastActiveIndex = body.channels.reduce(
      (acc: number, c: any, i: number) => (c.archived ? acc : i),
      -1,
    );
    expect(archivedIndex).toBeGreaterThan(lastActiveIndex);
  });

  it('searches current conversation and returns excerpt refs, not full content', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
    ]);
    const aliceId = agentIds.alice!;
    const otherChannel = await createChannel(t, workspaceId, 'other', [aliceId]);
    const messages = new MessageRepo(t.ctx.db);
    const hit = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: `before ${'x'.repeat(90)} needle-here ${'y'.repeat(90)} after`,
    });
    messages.insertForConversation({
      conversationId: otherChannel,
      fromKind: 'user',
      content: 'needle-here in another channel',
    });

    const res = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'needle-here',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.scope).toBe('current');
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].message_ref).toMatchObject({
      id: hit.id,
      conversation_id: channelId,
      channel_id: channelId,
      seq: hit.seq,
    });
    expect(body.hits[0]).not.toHaveProperty('content');
    expect(body.hits[0].excerpt).toContain('needle-here');
    expect(body.hits[0].excerpt[body.hits[0].match_offset]).toBe('n');
  });

  it('searches workspace scope through current conversation membership only', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const aliceOnly = await createChannel(t, workspaceId, 'alice-only', [aliceId]);
    const bobOnly = await createChannel(t, workspaceId, 'bob-only', [bobId]);
    const messages = new MessageRepo(t.ctx.db);
    const visible = messages.insertForConversation({
      conversationId: aliceOnly,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'workspace-scope-visible',
    });
    messages.insertForConversation({
      conversationId: bobOnly,
      fromKind: 'agent',
      fromAgentId: bobId,
      content: 'workspace-scope-hidden',
    });

    const res = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'workspace-scope',
      current_workspace: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([visible.id]);
    expect(body.hits[0].sender).toMatchObject({
      status: 'active',
      kind: 'agent',
      id: aliceId,
    });
  });

  it('search sender flips to the deleted snapshot after the author is hard-deleted', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'del',
    ]);
    const aliceId = agentIds.alice!;
    const delId = agentIds.del!;
    // A channel both can see, so alice's search reaches del's message.
    const shared = await createChannel(t, workspaceId, 'shared', [aliceId, delId]);
    const messages = new MessageRepo(t.ctx.db);
    const authored = messages.insertForConversation({
      conversationId: shared,
      fromKind: 'agent',
      fromAgentId: delId,
      content: 'zqvq needle authored by del',
    });
    // Hard-delete the author: ON DELETE SET NULL nulls from_agent_id while the
    // send-time snapshot survives. Search is an independent SQL + mapping path
    // from read-history, so it must be proven separately (task promises both).
    t.ctx.db.prepare(`DELETE FROM agents WHERE id = ?`).run(delId);

    const res = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'zqvq',
      current_workspace: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const hit = body.hits.find((h: any) => h.message_ref.id === authored.id);
    expect(hit).toBeTruthy();
    // Deleted snapshot preserved via the shared resolver; thin projection carries
    // ONLY the resolved identity — no renderer-only avatar_url / runtime.
    expect(hit.sender).toEqual({
      status: 'deleted',
      kind: 'agent',
      id: delId,
      name: 'del',
      display_name: 'del',
    });
  });

  it('rejects a non-member conversation selector, the retired scope key, and a blank selector', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const bobOnly = await createChannel(t, workspaceId, 'bob-only', [bobId]);

    // The retired mode word is refused, not ignored: silently dropping it
    // would answer a workspace-wide question with one conversation.
    const retired = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      scope: 'workspace',
    });
    expect(retired.status).toBe(400);

    // A blank selector is refused, not read as absent: the id IS the range
    // here, so falling back to the calling conversation would answer a
    // narrower question than the caller asked (an unset shell variable is
    // the common way to get here). Blank-as-absent stays correct for the
    // human search *filters*, which is a different input.
    const blank = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      conversation_id: '',
    });
    expect(blank.status).toBe(400);

    const blankWorkspace = await http(t).post(
      searchMessagesPath(channelId, aliceId),
      { q: 'x', workspace_id: '' },
    );
    expect(blankWorkspace.status).toBe(400);

    const forbidden = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      conversation_id: bobOnly,
    });
    expect(forbidden.status).toBe(403);
  });

  it('can omit system messages from search hits', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'system',
      content: 'system-only-keyword',
    });
    const userHit = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'user system-only-keyword',
    });

    const res = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'system-only-keyword',
      include_system: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([userHit.id]);
  });

  // Characterization for the read-model SQL extraction (#task:980, Slice B):
  // pin LIKE wildcard escaping. The search needle goes through escapeLike (which
  // backslash-escapes \ % _) wrapped as %needle% with an `ESCAPE '\'` clause, so
  // a query containing `%` or `_` matches those characters LITERALLY rather than
  // as SQL wildcards. A relocation that dropped the escape or the ESCAPE clause
  // would over-match here but still typecheck.
  it('treats % and _ in the query as literals, not SQL wildcards', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;
    const messages = new MessageRepo(t.ctx.db);
    const percentHit = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'discount 50% today',
    });
    // Decoy that a naked `%50%%` (unescaped) wildcard would also match.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'order 5050 today',
    });
    const underscoreHit = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'the user_id column',
    });
    // Decoy that a naked `_` (any single char) would also match.
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'the userXid column',
    });

    const pct = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: '50%',
    });
    expect(pct.status).toBe(200);
    const pctBody = await pct.json() as any;
    expect(pctBody.hits.map((h: any) => h.message_ref.id)).toEqual([percentHit.id]);

    const us = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'user_id',
    });
    expect(us.status).toBe(200);
    const usBody = await us.json() as any;
    expect(usBody.hits.map((h: any) => h.message_ref.id)).toEqual([underscoreHit.id]);

    // The third escape point: a literal backslash. escapeLike doubles `\` to
    // `\\` and the query runs with `ESCAPE '\'`, so a query containing `\` must
    // match that backslash literally. If the relocation dropped the escape of
    // `\` (but kept the ESCAPE clause), the needle `%path\name%` would read `\n`
    // as the escaped literal `n` — collapsing to `%pathname%` and over-matching
    // the decoy below. The decoy has no backslash, so it only matches under that
    // bug.
    const backslashHit = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'path\\name segment',
    });
    messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      content: 'pathname segment',
    });
    const bs = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'path\\name',
    });
    expect(bs.status).toBe(200);
    const bsBody = await bs.json() as any;
    expect(bsBody.hits.map((h: any) => h.message_ref.id)).toEqual([backslashHit.id]);
  });
});
