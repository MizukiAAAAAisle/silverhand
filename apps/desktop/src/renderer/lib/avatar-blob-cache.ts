import { fetchBackendBlob } from "./api";

/**
 * App-session avatar blob cache (#task:1321) — keyed by the agent/user
 * `avatar_url` (a `${path}?v=${updated_at}` cache-busted relative path), so the
 * SAME avatar is fetched exactly once for the whole renderer session and reused
 * by every consumer and every re-render.
 *
 * Why this exists:
 *   Previously each avatar hook (`useAgentAvatarObjectUrl(s)`,
 *   `useUserAvatarObjectUrl(s)`, `useViewerAvatarObjectUrl`) owned its object
 *   URL in component state and revoked it on unmount / input change. Nothing
 *   was shared across the session, so a re-render that changed the batch input
 *   set — or a remounted row in the virtualized timeline — tore the URL down
 *   and re-fetched the exact same blob. shiki's repro: every new message in a
 *   conversation fired a fresh avatar request (each a distinct network call in
 *   devtools). The hooks now delegate here and never revoke; the cache owns the
 *   object URL lifetime for the session.
 *
 * Correctness on avatar change: `avatar_url` carries `?v=updated_at`, so a new
 * avatar is a new key and a fresh fetch; the superseded entry is harmless (its
 * `?v=` is never requested again). Correctness on logout: `clearAvatarBlobCache()`
 * (wired into `clearViewerLocalState`) revokes everything so the next signed-in
 * viewer never inherits the previous session's blobs.
 *
 * Lifetime: an entry lives for the whole renderer session — it is revoked ONLY
 * by (a) `clearAvatarBlobCache()` (logout / session reset) or (b) the
 * session-generation guard dropping an in-flight fetch that outlived a logout.
 * There is deliberately NO size-capped LRU eviction: the task contract is "the
 * same avatar is fetched exactly once for the whole session" (shiki), and an LRU
 * cap would silently break that once the distinct-avatar count crossed the cap
 * (the next sighting of an evicted avatar would re-fetch). Avatars are small,
 * finite identity assets keyed by a versioned url, so unbounded-per-session is
 * the right trade; a memory cap would be a different (LRU) contract and needs
 * explicit sign-off, not a hidden exception (Cindy #task:1321 review).
 *
 * Failures are best-effort and NOT cached: a fetch error resolves to `null` (the
 * caller renders the runtime/placeholder icon) and drops the in-flight entry, so
 * a later mount can retry. Concurrent requests for the same url share one
 * in-flight fetch, so a screen full of the same author never multiplies calls.
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
// Session generation — bumped by `clearAvatarBlobCache` (logout). An in-flight
// fetch captures the generation at start; if it changed by the time the fetch
// resolves, the session was reset under it, so it must NOT write its blob into
// the new session's cache (that would leak the previous viewer's avatar). See
// `loadAvatarBlobUrl`.
let generation = 0;

/** Synchronous peek — the cached object URL for this `avatar_url`, or undefined
 *  if not yet resolved. Lets hooks seed their initial state without a
 *  flash-to-placeholder on remount. */
export function getAvatarBlobUrl(avatarUrl: string): string | undefined {
  return cache.get(avatarUrl);
}

/** Fetch (or reuse) the blob for this `avatar_url` and cache the object URL for
 *  the session. De-duplicates concurrent fetches for the same url. Resolves to
 *  the object URL, or `null` on fetch failure (best-effort; not cached, so a
 *  later call retries).
 *
 *  Session isolation: the fetch captures the current `generation`. If a logout
 *  (`clearAvatarBlobCache`) bumps the generation while the fetch is in flight,
 *  the resolved blob is immediately revoked and dropped (returns null) instead
 *  of being written into the next viewer's cache — closing the leak Cindy caught
 *  where a slow avatar request outlives the session that started it. */
export function loadAvatarBlobUrl(avatarUrl: string): Promise<string | null> {
  const cached = getAvatarBlobUrl(avatarUrl);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(avatarUrl);
  if (pending) return pending;
  const startGeneration = generation;
  const promise = (async () => {
    try {
      const res = await fetchBackendBlob(avatarUrl);
      if (generation !== startGeneration) {
        // The session was reset (logout) while this fetch was in flight —
        // never leak the previous viewer's blob into the new session.
        URL.revokeObjectURL(res.url);
        return null;
      }
      cache.set(avatarUrl, res.url);
      return res.url;
    } catch {
      return null;
    } finally {
      // Only clear our own slot. After a generation bump `inflight` was already
      // cleared and may now hold a newer session's fetch for this url; deleting
      // it here would strand that one.
      if (generation === startGeneration) inflight.delete(avatarUrl);
    }
  })();
  inflight.set(avatarUrl, promise);
  return promise;
}

/** Revoke every cached object URL, drop all entries, and bump the session
 *  generation. Called on logout (`clearViewerLocalState`) so the next viewer
 *  starts clean and the previous session's blob memory is released. In-flight
 *  fetches started before this call will see the changed generation on resolve
 *  and revoke-and-drop their blob rather than repopulating the cache (#task:1321
 *  session isolation). */
export function clearAvatarBlobCache(): void {
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
  generation += 1;
}
