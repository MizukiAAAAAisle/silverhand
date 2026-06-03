import { useEffect, useMemo, useState } from 'react';
import { fetchBackendBlob } from '@/lib/api';
import { useUsersById } from './hooks';

/**
 * Avatar fetch hooks for human users. Mirrors
 * `apps/desktop/src/renderer/features/agents/avatar-hooks.ts` for
 * humans: turn a stored `avatar_url` (or a user id resolved against the
 * directory) into a `URL.createObjectURL(...)` blob URL, with proper
 * lifecycle cleanup.
 *
 * Why two flavors:
 *
 * - `useUserAvatarObjectUrl(userId)`: the obvious shape for views that
 *   render exactly one human (HumanHeader, HumanProfileCard, single-row
 *   HumanInfoPopover). Resolves the user from the global directory and
 *   fetches one blob.
 *
 * - `useUserAvatarObjectUrls(users)`: the parent-batch shape for
 *   surfaces that render N humans in the same view (chat header member
 *   chips, mention picker, members rail). Calling the single-user hook
 *   from inside every leaf component would trigger N concurrent fetches
 *   and N object URLs for the same blob; the batch hook fetches once
 *   per (id, avatar_url) pair, returns a `Map<id, objectUrl | null>`,
 *   and the parent threads the map down as a prop. Mirrors the agent
 *   batch shape so the two surfaces stay isomorphic.
 *
 * Both helpers fetch through the main-process auth proxy. On 4xx/5xx
 * the URL falls back to `null` so the caller renders the placeholder —
 * there is no second-class error state for missing avatars.
 *
 * The viewer's own avatar still has its own hook
 * (`useViewerAvatarObjectUrl` in `features/me/hooks.ts`) — that path
 * keys off the viewer's auth-resolved dto (`useViewerUser`) rather
 * than the public directory, so it works even before `/api/users` has
 * hydrated.
 */

async function fetchAvatarObjectUrl(
  avatarUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    if (signal.aborted) return null;
    const res = await fetchBackendBlob(avatarUrl);
    if (signal.aborted) {
      URL.revokeObjectURL(res.url);
      return null;
    }
    return res.url;
  } catch {
    // Best-effort — caller falls back to the placeholder.
    return null;
  }
}

/**
 * Resolve one human's `avatar_url` to a browser object URL.
 *
 * Pass either a user id (looked up against the directory) or a raw
 * `avatar_url` string. `null`/`undefined` short-circuits to null.
 *
 * The hook owns the URL's lifetime: it revokes the previous URL
 * whenever the input changes or the component unmounts.
 */
export function useUserAvatarObjectUrl(
  input: { userId: string | null | undefined } | { avatarUrl: string | null | undefined },
): string | null {
  const usersById = useUsersById();
  const avatarUrl =
    'avatarUrl' in input
      ? input.avatarUrl ?? null
      : input.userId
        ? (usersById.get(input.userId)?.avatar_url ?? null)
        : null;

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!avatarUrl) {
      setObjectUrl(null);
      return;
    }
    const ac = new AbortController();
    let createdUrl: string | null = null;
    void (async () => {
      const url = await fetchAvatarObjectUrl(avatarUrl, ac.signal);
      if (ac.signal.aborted) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      createdUrl = url;
      setObjectUrl(url);
    })();
    return () => {
      ac.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [avatarUrl]);
  return objectUrl;
}

/** Stable shape — only the fields the batch hook actually uses. */
export interface UserAvatarSource {
  id: string;
  avatar_url: string | null;
}

/**
 * Batch resolver: takes a list of humans, returns `Map<id, objectUrl | null>`.
 *
 * Dedupes by `${id}:${avatar_url ?? ''}` so a list with the same human
 * twice (e.g. mention chip + author row) shares one fetch.
 *
 * Caller responsibilities:
 *   - Pass a stable list (memoize the array reference). Re-creating
 *     the array every render forces a teardown/refetch cycle.
 *   - Treat the returned map as read-only.
 */
export function useUserAvatarObjectUrls(
  users: ReadonlyArray<UserAvatarSource>,
): Map<string, string | null> {
  const cacheKey = useMemo(
    () => users.map(u => `${u.id}:${u.avatar_url ?? ''}`).join('|'),
    [users],
  );

  const [byId, setById] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const acs = new Map<string, AbortController>();
    const created = new Map<string, string>();
    const fetched = new Map<string, Promise<void>>();

    const next = new Map<string, string | null>();
    for (const u of users) {
      if (!u.avatar_url) {
        next.set(u.id, null);
        continue;
      }
      next.set(u.id, null);
      const k = `${u.id}:${u.avatar_url}`;
      if (fetched.has(k)) continue;
      const ac = new AbortController();
      acs.set(k, ac);
      const p = (async () => {
        const url = await fetchAvatarObjectUrl(u.avatar_url!, ac.signal);
        if (cancelled || ac.signal.aborted) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) created.set(k, url);
        setById(prev => {
          const out = new Map(prev);
          out.set(u.id, url);
          return out;
        });
      })();
      fetched.set(k, p);
    }

    setById(next);

    return () => {
      cancelled = true;
      for (const ac of acs.values()) ac.abort();
      for (const url of created.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey is the
    // stable identity of the input set; using `users` here would re-fire on
    // every parent render that reconstructs the array.
  }, [cacheKey]);

  return byId;
}
