import { useQuery } from '@tanstack/react-query';
import type { SearchDto, SearchScope } from '@silverhand/shared';
import { apiPaths } from '@silverhand/shared';
import { api } from '@/lib/api';

export interface SearchFilters {
  q: string;
  scope: SearchScope;
  channel_id?: string;
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
    !!filters.channel_id ||
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
  if (filters.channel_id) params.set('channel_id', filters.channel_id);
  if (filters.user_id) params.set('user_id', filters.user_id);
  if (filters.agent_id) params.set('agent_id', filters.agent_id);
  if (filters.from !== undefined) params.set('from', String(filters.from));
  if (filters.to !== undefined) params.set('to', String(filters.to));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  return params.toString();
}

export function useMessageSearch(filters: SearchFilters) {
  const enabled = hasSearchIntent(filters);
  return useQuery({
    queryKey: ['search', filters] as const,
    enabled,
    staleTime: 5_000,
    queryFn: async () => {
      const qs = buildSearchParams(filters);
      return api<SearchDto>(`${apiPaths.search}?${qs}`);
    },
  });
}
