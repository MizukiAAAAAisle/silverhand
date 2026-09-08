import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiPaths, type UsersResponse, type UserDto } from "@silverhand/shared";
import { api } from "@/lib/api";
import type { UserNameResolver } from "@/lib/current-user";

/** Query key of the global human directory. Exported so a mutation that
 *  changes a human's profile (`features/me/hooks.ts`) can invalidate the
 *  directory copy of it — `UserDto.display_name` / `avatar_url` are
 *  denormalized into this list, so writing only `['me']` leaves every
 *  directory-backed surface showing the old name or avatar. */
export const usersKey = ["users"] as const;
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
 *
 * D3 / multi-human: this endpoint is intentionally a **server-global
 * directory** (shiki `y9vLBOdCB-btEK3-`: "允许的, 这样更加方便拉人协作").
 * Trust boundary is signup gate, not workspace scope. If we ever tighten
 * to workspace-scoped users, swap to `useWorkspaceMemberLists()`.
 */
export function useUsers(options?: { enabled?: boolean }) {
  return useQuery<UsersResponse, Error, UserDto[]>({
    queryKey: usersKey,
    queryFn: () => api<UsersResponse>(apiPaths.users),
    select: (res) => res.users,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    enabled: options?.enabled ?? true,
  });
}

/**
 * Directory of humans keyed by id.
 *
 * Stable across renders while the underlying users list is stable
 * (React Query memoizes the `select` result), and rebuilt only when the
 * users list changes. Returns an empty map until the directory is
 * first hydrated — callers should treat misses as "not yet known", not
 * "does not exist".
 *
 * The map shape is the canonical resolver for any UI surface that
 * carries `user_id` but needs to render the human's `display_name` /
 * `avatar_url` (chat message authors, mention chips, saved-message
 * actors, task-event participants, sender-filter labels, ...). Pair
 * with {@link makeUserNameResolver} when feeding
 * {@link formatUserDisplayName}.
 */
export function useUsersById(): Map<string, UserDto> {
  const { data: users } = useUsers();
  return useMemo(() => {
    const map = new Map<string, UserDto>();
    if (!users) return map;
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);
}

/**
 * Adapt a `useUsersById()` map into the {@link UserNameResolver} shape.
 *
 * Returns `null` for unknown ids; {@link formatUserDisplayName} then
 * falls back to the raw id (or the "Unknown" sentinel for legacy null
 * authors). This keeps the resolver contract self-contained — callers
 * never have to reach into the map themselves.
 */
export function makeUserNameResolver(usersById: Map<string, UserDto>): UserNameResolver {
  return (userId: string) => usersById.get(userId)?.display_name ?? null;
}
