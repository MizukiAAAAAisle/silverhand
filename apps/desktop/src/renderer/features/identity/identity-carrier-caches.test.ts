import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
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
    const keys: readonly unknown[][] = [
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
  });
});
