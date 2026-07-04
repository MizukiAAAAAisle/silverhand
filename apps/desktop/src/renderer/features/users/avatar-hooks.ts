import { useEffect, useMemo, useState } from 'react';
import { getAvatarBlobUrl, loadAvatarBlobUrl } from '@/lib/avatar-blob-cache';
import { useUsersById } from './hooks';

/**
 * Avatar fetch hooks for human users. Mirror the agent hooks
 * (`apps/desktop/src/renderer/features/agents/avatar-hooks.ts`): turn a stored
 * `avatar_url` (or a user id resolved against the directory) into a browser
 * object URL by delegating to the app-session avatar cache
 * (`@/lib/avatar-blob-cache`), which owns the URL's lifetime and fetches each
 * `avatar_url` exactly once per renderer session (#task:1321). These hooks never
 * revoke.
 *
 * Why two flavors:
 *
 * - `useUserAvatarObjectUrl(input)`: one human (HumanHeader, HumanProfileCard,
 *   single-row HumanInfoPopover). Accepts a user id (resolved via the directory)
 *   or a raw `avatar_url`.
 *
 * - `useUserAvatarObjectUrls(users)`: the parent-batch shape for surfaces that
 *   render N humans (chat header chips, mention picker, members rail). The
 *   parent threads a `Map<id, objectUrl | null>` down as a prop.
 *
 * On 4xx/5xx the value falls back to `null` so the caller renders the
 * placeholder — there is no second-class error state for missing avatars.
 *
 * The viewer's own avatar still has its own hook (`useViewerAvatarObjectUrl` in
 * `features/me/hooks.ts`) — that path keys off the auth-resolved dto rather than
 * the public directory — but it now shares the same session cache.
 */

/**
 * Resolve one human's `avatar_url` to a session-cached object URL. Pass either a
 * user id (looked up against the directory) or a raw `avatar_url` string.
 * `null`/`undefined` short-circuits to null. Seeds from the cache synchronously
 * so a remount with an already-fetched avatar shows it with no flash.
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

  const [objectUrl, setObjectUrl] = useState<string | null>(() =>
    avatarUrl ? getAvatarBlobUrl(avatarUrl) ?? null : null,
  );
  useEffect(() => {
    if (!avatarUrl) {
      setObjectUrl(null);
      return;
    }
    const cached = getAvatarBlobUrl(avatarUrl);
    if (cached) {
      setObjectUrl(cached);
      return;
    }
    let cancelled = false;
    void loadAvatarBlobUrl(avatarUrl).then(url => {
      if (!cancelled) setObjectUrl(url);
    });
    return () => {
      cancelled = true;
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
 * Session-cache-backed, so a cached avatar fills the returned map synchronously
 * (no flash) and only genuinely-uncached avatars fetch; concurrent fetches for
 * the same url are de-duped by the cache.
 *
 * Caller responsibilities:
 *   - Pass a stable list (memoize the array reference).
 *   - Treat the returned map as read-only.
 */
export function useUserAvatarObjectUrls(
  users: ReadonlyArray<UserAvatarSource>,
): Map<string, string | null> {
  // Deduped + sorted so the key depends only on the SET of pairs, not order.
  const cacheKey = useMemo(
    () =>
      Array.from(new Set(users.map(u => `${u.id}:${u.avatar_url ?? ''}`)))
        .sort()
        .join('|'),
    [users],
  );

  const [byId, setById] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;

    const next = new Map<string, string | null>();
    const toLoad: Array<{ id: string; url: string }> = [];
    for (const u of users) {
      if (!u.avatar_url) {
        next.set(u.id, null);
        continue;
      }
      const cached = getAvatarBlobUrl(u.avatar_url);
      next.set(u.id, cached ?? null);
      if (!cached) toLoad.push({ id: u.id, url: u.avatar_url });
    }
    setById(next);

    for (const { id, url } of toLoad) {
      void loadAvatarBlobUrl(url).then(resolved => {
        if (cancelled || !resolved) return;
        setById(prev => {
          const out = new Map(prev);
          out.set(id, resolved);
          return out;
        });
      });
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey is the
    // stable identity of the input set; using `users` here would re-fire on
    // every parent render that reconstructs the array.
  }, [cacheKey]);

  return byId;
}
