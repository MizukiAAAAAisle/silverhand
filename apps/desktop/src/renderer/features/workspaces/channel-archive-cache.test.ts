import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { reconcileChannelArchive } from './hooks';
import { applyFavoritesSync, favoritesKey } from '../favorites/hooks';

describe('archive menu cache convergence', () => {
  it('removes a foreign-workspace favorite and restores fresh detail before menu reopen', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let archivedAt: number | null = null;
    const favorite = { entity_id: 'channel-b', workspace_id: 'workspace-b' };
    const detailKey = ['channel-detail', 'channel-b'];
    const detailOptions = {
      queryKey: detailKey,
      queryFn: async () => ({ is_member: true, channel: { id: 'channel-b', archived_at: archivedAt } }),
    };
    const favorites = new QueryObserver(qc, {
      queryKey: favoritesKey,
      queryFn: async () => ({ items: archivedAt === null ? [favorite] : [] }),
    });
    const unsubscribe = favorites.subscribe(() => {});
    try {
      await favorites.refetch();
      await qc.fetchQuery(detailOptions);
      qc.setQueryData(['channel-detail', 'channel-a'], { marker: 'current workspace untouched' });
      expect(favorites.getCurrentResult().data?.items).toEqual([favorite]);
      archivedAt = 123;
      reconcileChannelArchive(qc, 'channel-b', 'workspace-b');
      expect(qc.getQueryState(detailKey)?.isInvalidated).toBe(true);
      await applyFavoritesSync(qc, { type: 'event', scope: 'workspace:workspace-b', kind: 'workspace_channels_changed' }, ['workspace-a', 'workspace-b']);
      expect(favorites.getCurrentResult().data?.items).toEqual([]);
      expect((await qc.fetchQuery(detailOptions)).channel.archived_at).toBe(123);
      archivedAt = null;
      reconcileChannelArchive(qc, 'channel-b', 'workspace-b');
      await applyFavoritesSync(qc, { type: 'event', scope: 'workspace:workspace-b', kind: 'workspace_channels_changed' }, ['workspace-a', 'workspace-b']);
      expect(favorites.getCurrentResult().data?.items).toEqual([favorite]);
      expect((await qc.fetchQuery(detailOptions)).channel.archived_at).toBeNull();
      expect(qc.getQueryData(['channel-detail', 'channel-a'])).toEqual({ marker: 'current workspace untouched' });
      expect(qc.getQueryState(['channel-detail', 'channel-a'])?.isInvalidated).toBe(false);
    } finally {
      unsubscribe();
      qc.clear();
    }
  });
});
