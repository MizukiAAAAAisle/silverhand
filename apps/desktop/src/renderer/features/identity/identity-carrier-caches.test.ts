import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  agentsKey,
  clusterFetchEpochKey,
  clusterMessagesKey,
  mainlineLiveGapKey,
  messagesKey,
  threadFollowersKey,
  threadRootKey,
} from '@/features/channels/message-cache-core';
import {
  channelThreadsKey,
  channelThreadsUnreadKey,
} from '@/features/channels/useChannelThreads';
import { channelAttachmentsKey } from '@/features/channels/useChannelAttachments';
import { savedKey } from '@/features/saved/hooks';
import { searchKey } from '@/features/search/hooks';
import {
  identityCarrierIdsFor,
  invalidateIdentityCarrierCaches,
} from './identity-carrier-caches';

/**
 * The registry's value is its SCOPING, not its inventory: one shared
 * enumeration must not make a human avatar change refetch host status / DM
 * favorites, nor an agent rename refetch the human directory (Cindy
 * #task:1703). These assert that boundary through the real query cache, so a
 * carrier added to the wrong group fails here.
 */
describe('identity-carrier caches', () => {
  const seed = (qc: QueryClient, key: readonly unknown[]) => {
    qc.setQueryData(key, { seeded: true });
  };

  /** Keys marked stale by an invalidation of `kind`. */
  const stalePaths = (kind: 'agent' | 'human'): string[] => {
    const qc = new QueryClient();
    const keys: readonly (readonly unknown[])[] = [
      ['conversation-members', 'c1'],
      ['workspaces', 'w1', 'members'],
      ['workspaces', 'w1', 'channels'],
      ['activity', 'all'],
      ['message-reactions', 'm1'],
      ['tasks', { workspaceId: 'w1' }],
      ['task-detail', 't1'],
      ['task-by-number', 'w1', 7],
      ['agents'],
      ['favorites', 'all'],
      ['host-status', 'h1'],
      ['host-resources', 'h1'],
      ['hosts'],
      ['users'],
      // #task:1792 — every channel-scoped read model that now embeds a
      // `MessageAuthorDto` snapshot, built from its REAL factory so a segment
      // rename breaks this test rather than silently dropping a family.
      messagesKey('c1'),
      clusterMessagesKey('c1', 'root1'),
      threadRootKey('c1', 'root1'),
      channelThreadsKey('c1'),
      channelThreadsUnreadKey('c1'),
      channelAttachmentsKey('c1'),
      savedKey,
      searchKey,
      // Non-author channel caches that share the `['channels', cid, …]` prefix
      // (and, for the cluster arm, the `'cluster'` segment) — they must NOT be
      // reseated by an identity change.
      agentsKey('c1'),
      mainlineLiveGapKey('c1'),
      threadFollowersKey('c1', 'root1'),
      clusterFetchEpochKey('c1', 'root1'),
    ];
    for (const k of keys) seed(qc, k);
    invalidateIdentityCarrierCaches(qc, kind);
    return qc
      .getQueryCache()
      .findAll({ stale: true })
      .map(q => JSON.stringify(q.queryKey))
      .sort();
  };

  it('reseats both-kind rosters, Activity, reactors and task dtos for either kind', () => {
    const shared = [
      '["activity","all"]',
      '["conversation-members","c1"]',
      '["message-reactions","m1"]',
      '["task-by-number","w1",7]',
      '["task-detail","t1"]',
      '["tasks",{"workspaceId":"w1"}]',
      '["workspaces","w1","members"]',
    ];
    for (const kind of ['agent', 'human'] as const) {
      expect(stalePaths(kind)).toEqual(expect.arrayContaining(shared));
    }
  });

  it('reseats every embedded-author read model, both kinds (#task:1792)', () => {
    // A hard-deleted actor's snapshot, a rename, and an avatar swap all only
    // reflect on these caches by refetch — none is keyed by the actor id.
    const authorCarriers = [
      JSON.stringify(messagesKey('c1')),
      JSON.stringify(clusterMessagesKey('c1', 'root1')),
      JSON.stringify(threadRootKey('c1', 'root1')),
      JSON.stringify(channelThreadsKey('c1')),
      JSON.stringify(channelThreadsUnreadKey('c1')),
      JSON.stringify(channelAttachmentsKey('c1')),
      JSON.stringify(savedKey),
      JSON.stringify(searchKey),
    ];
    for (const kind of ['agent', 'human'] as const) {
      expect(stalePaths(kind)).toEqual(expect.arrayContaining(authorCarriers));
    }
  });

  it('does NOT reseat non-author channel caches sharing the prefix (#task:1792)', () => {
    // The cluster arm matches only `…, root, 'messages'`; `fetch-epoch` shares
    // the `'cluster'` segment but carries no author. `agents` / mainline
    // `live-gap` / `thread-followers` are pure affordance/roster caches.
    const nonAuthor = [
      JSON.stringify(agentsKey('c1')),
      JSON.stringify(mainlineLiveGapKey('c1')),
      JSON.stringify(threadFollowersKey('c1', 'root1')),
      JSON.stringify(clusterFetchEpochKey('c1', 'root1')),
    ];
    for (const kind of ['agent', 'human'] as const) {
      const stale = stalePaths(kind);
      for (const key of nonAuthor) expect(stale).not.toContain(key);
    }
  });

  it('leaves the other kind\'s caches alone', () => {
    const agent = stalePaths('agent');
    expect(agent).toEqual(
      expect.arrayContaining([
        '["agents"]',
        '["favorites","all"]',
        '["host-resources","h1"]',
        '["host-status","h1"]',
      ]),
    );
    expect(agent).not.toContain('["users"]');

    const human = stalePaths('human');
    expect(human).toContain('["users"]');
    for (const agentOnly of [
      '["agents"]',
      '["favorites","all"]',
      '["host-status","h1"]',
      '["host-resources","h1"]',
    ]) {
      expect(human).not.toContain(agentOnly);
    }
  });

  it('never widens past the member list into a workspace\'s other lists', () => {
    for (const kind of ['agent', 'human'] as const) {
      expect(stalePaths(kind)).not.toContain('["workspaces","w1","channels"]');
    }
    // `HostDto` carries no agent identity, so the host list itself is exempt.
    expect(stalePaths('agent')).not.toContain('["hosts"]');
  });

  it('exposes the per-kind carrier set for review', () => {
    expect(identityCarrierIdsFor('human')).toContain('users');
    expect(identityCarrierIdsFor('human')).not.toContain('favorites');
    expect(identityCarrierIdsFor('agent')).toContain('favorites');
    expect(identityCarrierIdsFor('agent')).not.toContain('users');
    // The embedded-author families are both-kind carriers (#task:1792).
    for (const kind of ['agent', 'human'] as const) {
      expect(identityCarrierIdsFor(kind)).toEqual(
        expect.arrayContaining([
          'channel-author-projections',
          'saved',
          'search',
        ]),
      );
    }
  });
});
