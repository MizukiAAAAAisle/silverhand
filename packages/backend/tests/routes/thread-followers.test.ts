import { afterEach, describe, expect, it } from 'vitest';
import {
  apiPaths,
  encodeUserPrincipalHeader,
  X_SILVERHAND_PRINCIPAL_HEADER,
} from '@silverhand/shared';
import { ConversationRepo } from '../../src/repos/conversation-repo.js';
import { MessageRepo } from '../../src/repos/message-repo.js';
import { ThreadFollowerRepo } from '../../src/repos/thread-follower-repo.js';
import { buildTestApp, http, type TestApp } from '../utils/app.js';

async function makeAgent(t: TestApp, name: string): Promise<string> {
  const created = (await (
    await http(t).post('/api/agents', { name, runtime: 'claude' })
  ).json()) as any;
  return created.agent.id;
}

async function createWorkspaceChannel(
  t: TestApp,
  names: string[],
  memberUserIds: string[] = [],
): Promise<{ channelId: string; agentIds: Record<string, string> }> {
  const agentIds: Record<string, string> = {};
  for (const name of names) {
    agentIds[name] = await makeAgent(t, name);
  }
  const workspace = (await (
    await http(t).post('/api/workspaces', {
      name: `thread-followers-${names.join('-')}`,
      member_agent_ids: Object.values(agentIds),
      member_user_ids: memberUserIds,
    })
  ).json()) as any;
  t.fake.starts = [];
  t.fake.delivered = [];
  return {
    channelId: workspace.onboarding_channel_id,
    agentIds,
  };
}

function followerSource(
  t: TestApp,
  threadRootId: string,
  principalKind: 'human' | 'agent',
  principalId: string,
): string | null {
  const row = t.ctx.db
    .prepare<[string, string, string], { source: string }>(
      `SELECT source FROM thread_followers
        WHERE thread_root_id = ?
          AND principal_kind = ?
          AND principal_id = ?`,
    )
    .get(threadRootId, principalKind, principalId);
  return row?.source ?? null;
}

describe('human thread follower routes', () => {
  let t: TestApp | null = null;
  afterEach(() => {
    t?.cleanup();
    t = null;
  });

  it('reads viewer follow state and visible follower agents for a thread', async () => {
    t = buildTestApp();
    const { channelId, agentIds } = await createWorkspaceChannel(t, [
      'alice',
      'bob',
    ]);
    const charlieId = await makeAgent(t, 'charlie-not-in-channel');
    const messages = new MessageRepo(t.ctx.db);
    const followers = new ThreadFollowerRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    const reply = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'agent',
      fromAgentId: agentIds.alice!,
      content: 'reply',
      threadRootId: root.id,
    });
    followers.upsert({
      threadRootId: root.id,
      conversationId: channelId,
      principalKind: 'human',
      principalId: 'local',
      source: 'reply',
    });
    followers.upsert({
      threadRootId: root.id,
      conversationId: channelId,
      principalKind: 'agent',
      principalId: agentIds.alice!,
      source: 'reply',
    });
    followers.upsert({
      threadRootId: root.id,
      conversationId: channelId,
      principalKind: 'agent',
      principalId: charlieId,
      source: 'manual',
    });

    const res = await http(t).get(
      apiPaths.channelThreadFollowers(channelId, reply.id),
    );

    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({
      thread_root_id: root.id,
      viewer_following: true,
      follower_agent_ids: [agentIds.alice],
    });
  });

  it('lets the current human follow and unfollow idempotently', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice']);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });

    const follow = await http(t).post(
      apiPaths.channelThreadFollow(channelId, root.id),
    );
    expect(follow.status, await follow.clone().text()).toBe(200);
    expect(await follow.json()).toEqual({
      thread_root_id: root.id,
      changed: true,
      viewer_following: true,
    });
    expect(followerSource(t, root.id, 'human', 'local')).toBe('manual');

    const followAgain = await http(t).post(
      apiPaths.channelThreadFollow(channelId, root.id),
    );
    expect(await followAgain.json()).toMatchObject({
      changed: false,
      viewer_following: true,
    });

    const unfollow = await http(t).del(
      apiPaths.channelThreadFollow(channelId, root.id),
    );
    expect(unfollow.status).toBe(200);
    expect(await unfollow.json()).toEqual({
      thread_root_id: root.id,
      changed: true,
      viewer_following: false,
    });
    expect(followerSource(t, root.id, 'human', 'local')).toBeNull();

    const unfollowAgain = await http(t).del(
      apiPaths.channelThreadFollow(channelId, root.id),
    );
    expect(await unfollowAgain.json()).toMatchObject({
      changed: false,
      viewer_following: false,
    });
  });

  it('does not make follow a permission backdoor', async () => {
    t = buildTestApp();
    const { channelId } = await createWorkspaceChannel(t, ['alice'], [
      'teammate',
    ]);
    const messages = new MessageRepo(t.ctx.db);
    const root = messages.insertForConversation({
      conversationId: channelId,
      fromKind: 'user',
      fromUserId: 'local',
      content: 'root',
    });
    t.ctx.db
      .prepare(
        `DELETE FROM conversation_users
          WHERE conversation_id = ? AND user_id = 'teammate'`,
      )
      .run(channelId);

    const res = await http(t).post(
      apiPaths.channelThreadFollow(channelId, root.id),
      {},
      {
        headers: {
          [X_SILVERHAND_PRINCIPAL_HEADER]:
            encodeUserPrincipalHeader('teammate'),
        },
      },
    );

    expect(res.status).toBe(403);
    expect(followerSource(t, root.id, 'human', 'teammate')).toBeNull();
  });
});
