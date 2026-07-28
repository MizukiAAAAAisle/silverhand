import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { SearchDto, SearchScope } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

export interface SearchFilters {
  q: string;
  scope: SearchScope;
  workspace_id?: string;
  conversation_id?: string;
  user_id?: string;
  agent_id?: string;
  from?: number;
  to?: number;
  limit?: number;
}

function hasSearchIntent(filters: SearchFilters): boolean {
  return (
    filters.q.trim().length > 0 ||
    filters.scope !== 'all' ||
    !!filters.workspace_id ||
    !!filters.conversation_id ||
    !!filters.user_id ||
    !!filters.agent_id ||
    filters.from !== undefined ||
    filters.to !== undefined
  );
}

function buildSearchParams(filters: SearchFilters): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q) params.set('q', q);
  if (filters.scope !== 'all') params.set('scope', filters.scope);
  if (filters.workspace_id) params.set('workspace_id', filters.workspace_id);
  if (filters.conversation_id) {
    params.set('conversation_id', filters.conversation_id);
  }
  if (filters.user_id) params.set('user_id', filters.user_id);
  if (filters.agent_id) params.set('agent_id', filters.agent_id);
  if (filters.from !== undefined) params.set('from', String(filters.from));
  if (filters.to !== undefined) params.set('to', String(filters.to));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params.toString();
}

/** Prefix key of every message-search variant (`['search', filters]`). */
export const searchKey = ['search'] as const;

/**
 * Discard every search result set that references ONE channel (#task:1689).
 *
 * Unlike the list read-models this one is REMOVED rather than patched, and the
 * reason is the payload's own contract: `SearchDto` carries `total` and
 * `truncated` for a RANKED, CAPPED window. Filtering rows out of it would leave
 * a set no refetch can produce — a count that no longer matches its rows, and a
 * `truncated` window whose next page was computed against the removed rows. A
 * search cache is also cheap to lose: it is re-fetched the moment the pane is
 * open, and search is server-side visibility-filtered, so the refetch is the
 * authority.
 *
 * PRESENT-ONLY: a variant whose results never mention the channel is left
 * alone, so an unrelated channel loss does not blow away the viewer's open
 * search.
 */
export function removeChannelFromSearch(qc: QueryClient, channelId: string): void {
  for (const q of qc.getQueryCache().findAll({ queryKey: searchKey })) {
    const data = qc.getQueryData<SearchDto>(q.queryKey);
    if (!data) continue;
    if (!searchDtoReferencesChannel(data, channelId)) continue;
    qc.removeQueries({ queryKey: q.queryKey, exact: true });
  }
}

/** Which channels of ONE workspace a loaded search result set references
 *  (#task:1689). Each result carries `workspace.id` + `conversation.channel_id`
 *  (a thread hit's `conversation.id` is the thread, `channel_id` the parent). */
export function searchHeldChannelIds(
  qc: QueryClient,
  workspaceId: string,
): string[] {
  const ids = new Set<string>();
  for (const q of qc.getQueryCache().findAll({ queryKey: searchKey })) {
    const data = qc.getQueryData<SearchDto>(q.queryKey);
    if (!data) continue;
    for (const r of data.results) {
      if (r.type === 'workspace') continue;
      if (r.workspace.id === workspaceId) ids.add(r.conversation.channel_id);
    }
  }
  return [...ids];
}

function searchDtoReferencesChannel(data: SearchDto, channelId: string): boolean {
  return data.results.some(
    r => r.type !== 'workspace' && r.conversation.channel_id === channelId,
  );
}

export function useMessageSearch(filters: SearchFilters) {
  const enabled = hasSearchIntent(filters);
  return useQuery({
    queryKey: [...searchKey, filters] as const,
    enabled,
    staleTime: 5_000,
    queryFn: async () => {
      const qs = buildSearchParams(filters);
      return api<SearchDto>(`${apiPaths.search}?${qs}`);
    },
  });
}
