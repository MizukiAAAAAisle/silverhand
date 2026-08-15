import { afterEach, describe, expect, it } from 'vitest';
import { MessageRepo } from '../../src/repos/message-repo.js';
import {
  buildTestApp,
  http,
  issueTestConversationRuntimeToken,
  type TestApp,
} from '../utils/app.js';

// Reply-cluster voluntary follow/unfollow (docs/thread-reply-cluster-v1.md
// §5 B / §8; cut2 2-B2c). `source='manual'`; a new follow backfills the
// cluster's prior history; unfollow is idempotent and re-followed on later
// activity. Follow is a subscription, never a permission backdoor.

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
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
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `follow-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    workspaceId: workspace.workspace.id,
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

const followPath = (cid: string, aid: string) =>
  `/internal/agents/${aid}/follow-thread`;
const unfollowPath = (cid: string, aid: string) =>
  `/internal/agents/${aid}/unfollow-thread`;

function followerSource(
  t: TestApp,
  threadRootId: string,
  agentId: string,
): string | null {
  const row = t.ctx.db
    .prepare<[string, string], { source: string }>(
      `SELECT source FROM thread_followers
        WHERE thread_root_id = ? AND principal_kind = 'agent' AND principal_id = ?`,
    )
    .get(threadRootId, agentId);
  return row?.source ?? null;
}

function inboxMessageIds(t: TestApp, channelId: string, agentId: string): string[] {
  return t.ctx.db
    .prepare<[string, string], { message_id: string }>(
      `SELECT message_id FROM conversation_inboxes
        WHERE conversation_id = ? AND agent_id = ?`,
    )
    .all(channelId, agentId)
    .map(r => r.message_id);
}

describe('POST /internal/.../follow-thread + unfollow-thread', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('manual-follows a cluster (source=manual), is idempotent, and backfills prior history', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'cluster root',
    });
    const reply1 = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'reply one',
      threadRootId: root.id,
    });
    // bob's OWN reply must NOT be backfilled to bob.
    const bobReply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: bobId,
      content: 'bob reply',
      threadRootId: root.id,
    });

    const res = await http(t).post(followPath(channelId, bobId), {
      root_message_id: root.id,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as any;
    expect(body.thread_root_id).toBe(root.id);
    expect(body.changed).toBe(true);
    expect(followerSource(t, root.id, bobId)).toBe('manual');

    // Backfill: root + alice's reply landed in bob's inbox; bob's own reply did not.
    const inbox = inboxMessageIds(t, channelId, bobId);
    expect(inbox).toContain(root.id);
    expect(inbox).toContain(reply1.id);
    expect(inbox).not.toContain(bobReply.id);

    // Idempotent re-follow: no new row, changed=false, no duplicate backfill.
    const again = await http(t).post(followPath(channelId, bobId), {
      root_message_id: root.id,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).changed).toBe(false);
    const inboxAfter = inboxMessageIds(t, channelId, bobId).filter(id => id === root.id);
    expect(inboxAfter.length).toBe(1);
  });

  it('normalizes a reply id to the canonical root when following', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'reply',
      threadRootId: root.id,
    });

    const res = await http(t).post(followPath(channelId, bobId), {
      root_message_id: reply.id,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).thread_root_id).toBe(root.id);
    expect(followerSource(t, root.id, bobId)).toBe('manual');
  });

  it('derives the addressed conversation from the root instead of the credential scope', async () => {
    t = buildTestApp();
    const { workspaceId, channelId: anchor, agentIds } = await createWorkspaceChannel(
      t,
      ['alice'],
    );
    const aliceId = agentIds.alice!;
    const destination = (await (
      await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'follow-destination',
        member_agent_ids: [aliceId],
      })
    ).json()) as any;
    const destinationId = destination.channel.id as string;
    const root = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: destinationId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'root in another conversation',
    });

    const response = await http(t).post(
      followPath(destinationId, aliceId),
      { root_message_id: root.id },
      {
        headers: {
          authorization: `Bearer ${issueTestConversationRuntimeToken(t, anchor, aliceId)}`,
        },
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({
      thread_root_id: root.id,
      changed: true,
    });
    expect(followerSource(t, root.id, aliceId)).toBe('manual');
  });

  it('unfollows idempotently and re-follow on a later reply preserves the original manual source', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: aliceId,
      content: 'root',
    });

    await http(t).post(followPath(channelId, bobId), { root_message_id: root.id });
    expect(followerSource(t, root.id, bobId)).toBe('manual');

    const off = await http(t).post(unfollowPath(channelId, bobId), {
      root_message_id: root.id,
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).changed).toBe(true);
    expect(followerSource(t, root.id, bobId)).toBeNull();

    // Idempotent: unfollowing again is a no-op (changed=false).
    const offAgain = await http(t).post(unfollowPath(channelId, bobId), {
      root_message_id: root.id,
    });
    expect(((await offAgain.json()) as any).changed).toBe(false);
  });

  it('rejects follow/unfollow of an unknown root with reply_target_not_found (404)', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, ['alice']);
    const aliceId = agentIds.alice!;

    const f = await http(t).post(followPath(channelId, aliceId), {
      root_message_id: 'nope',
    });
    expect(f.status).toBe(404);
    expect(((await f.json()) as any).code).toBe('reply_target_not_found');

    const u = await http(t).post(unfollowPath(channelId, aliceId), {
      root_message_id: 'nope',
    });
    expect(u.status).toBe(404);
    expect(((await u.json()) as any).code).toBe('reply_target_not_found');
  });

  it('makes an invisible root indistinguishable from an unknown root', async () => {
    t = buildTestApp();
    const { workspaceId, channelId: aliceChannel, agentIds } =
      await createWorkspaceChannel(t, ['alice', 'bob']);
    const aliceId = agentIds.alice!;
    const bobId = agentIds.bob!;
    const bobOnly = (await (
      await http(t).post(`/api/workspaces/${workspaceId}/channels`, {
        title: 'bob-only',
        member_agent_ids: [bobId],
      })
    ).json()) as any;
    const hiddenRoot = new MessageRepo(t.ctx.db).insertForConversation({
      conversationId: bobOnly.channel.id,
      fromKind: 'agent',
      fromAgentId: bobId,
      content: 'hidden root',
    });
    const headers = {
      authorization: `Bearer ${issueTestConversationRuntimeToken(t, aliceChannel, aliceId)}`,
    };

    const [hidden, unknown] = await Promise.all([
      http(t).post(
        followPath(bobOnly.channel.id, aliceId),
        { root_message_id: hiddenRoot.id },
        { headers },
      ),
      http(t).post(
        followPath(aliceChannel, aliceId),
        { root_message_id: 'unknown-root' },
        { headers },
      ),
    ]);

    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await hidden.text()).toBe(await unknown.text());
    expect(followerSource(t, hiddenRoot.id, aliceId)).toBeNull();
  });
});
