import { useQuery } from '@tanstack/react-query';
import { apiPaths, type UsersResponse, type UserDto } from '@silverhand/shared';
import { api } from '@/lib/api';

const usersKey = ['users'] as const;
const STALE_MS = 30 * 1000;
const GC_MS = 5 * 60 * 1000;

/**
 * Fetch every registered human user.
 *
 * Backs candidate pickers — workspace add-human + (future) anywhere
 * a UI surface needs to enumerate humans for selection. Returns the
 * full list; callers filter (e.g. "minus current workspace humans").
 *
 * Cache lives at `['users']` so all consumers share a single network
 * round trip; React Query coalesces concurrent subscribers.
 */
export function useUsers() {
  return useQuery<UsersResponse, Error, UserDto[]>({
    queryKey: usersKey,
    queryFn: () => api<UsersResponse>(apiPaths.users),
    select: res => res.users,
    staleTime: STALE_MS,
    gcTime: GC_MS,
  });
}
