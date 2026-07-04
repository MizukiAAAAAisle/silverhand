import { afterEach, describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

/**
 * Seed a fossil `kind='thread'` conversation via raw SQL. The producer
 * (`ConversationRepo.insertThread`) and the `thread` kind were retired in
 * #task:1303 phase 2; the channel-scope search still sweeps physical child
 * threads, so this reproduces the row without touching the narrowed model.
 */
function insertFossilThread(
  db: Db,
  channel: { id: string; workspace_id: string; workspace_path: string },
): { id: string } {
  const id = `fossil_thread_${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, workspace_path, kind, parent_conversation_id,
        title, status, created_at, updated_at, latest_message_seq)
     VALUES (?, ?, ?, 'thread', ?, 'Fossil', 'idle', ?, ?, 0)`,
  ).run(id, channel.workspace_id, channel.workspace_path, channel.id, Date.now(), Date.now());
  return { id };
}

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

  it('lists only current-workspace channels where the agent is a current member', async () => {
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
      thread_id: null,
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
      scope: 'workspace',
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.hits.map((h: any) => h.message_ref.id)).toEqual([visible.id]);
    expect(body.hits[0].sender).toMatchObject({
      kind: 'agent',
      agent_id: aliceId,
    });
  });

  it('searches channel scope across the channel and visible child threads', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
    ]);
    const aliceId = agentIds.alice!;
    const searchChannel = await createChannel(t, workspaceId, 'search-channel', [
      aliceId,
    ]);
    const conversations = new ConversationRepo(t.ctx.db);
    const parent = conversations.getChannel(searchChannel)!;
    const thread = insertFossilThread(t.ctx.db, {
      id: searchChannel,
      workspace_id: parent.workspace_id,
      workspace_path: parent.workspace_path,
    });
    conversations.addAgent(thread.id, aliceId);
    const messages = new MessageRepo(t.ctx.db);
    const channelHit = messages.insertForConversation({
      conversationId: searchChannel,
      fromKind: 'user',
      content: 'channel-scope shared token',
    });
    const threadHit = messages.insertForConversation({
      conversationId: thread.id,
      fromKind: 'user',
      content: 'thread channel-scope shared token',
    });

    const res = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'channel-scope',
      scope: 'channel',
      channel_id: searchChannel,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.channel_id).toBe(searchChannel);
    expect(body.hits.map((h: any) => h.message_ref.id).sort()).toEqual(
      [channelHit.id, threadHit.id].sort(),
    );
    const threadRef = body.hits.find((h: any) => h.message_ref.id === threadHit.id)
      .message_ref;
    expect(threadRef).toMatchObject({
      conversation_id: thread.id,
      channel_id: searchChannel,
      thread_id: thread.id,
    });
  });

  it('rejects invalid channel scope combinations and non-member channels', async () => {
    t = buildTestApp();
    const { workspaceId, channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const bobOnly = await createChannel(t, workspaceId, 'bob-only', [bobId]);

    const missing = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      scope: 'channel',
    });
    expect(missing.status).toBe(400);

    const mixed = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      scope: 'workspace',
      channel_id: channelId,
    });
    expect(mixed.status).toBe(400);

    const forbidden = await http(t).post(searchMessagesPath(channelId, aliceId), {
      q: 'x',
      scope: 'channel',
      channel_id: bobOnly,
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
