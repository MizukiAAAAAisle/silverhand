import { useEffect, useMemo, useState } from 'react';
import { fetchBackendBlob } from '@/lib/api';

/**
 * Avatar fetch hooks for agents. Mirrors `useViewerAvatarObjectUrl`
 * (single-viewer) but generalized so multiple call sites can resolve
 * an `avatar_url` (relative path baked into `AgentDto`) into a
 * browser-side `URL.createObjectURL(...)` blob URL with proper
 * cleanup.
 *
 * Why two flavors:
 *
 * - `useAgentAvatarObjectUrl(avatarUrl)`: the obvious shape for views
 *   that render exactly one agent (AgentHeader, AgentProfileCard,
 *   AgentInfoPopover). One fetch, one object URL, one revoke.
 *
 * - `useAgentAvatarObjectUrls(agents)`: the parent-batch shape for
 *   surfaces that render N agents in the same view (member chips on
 *   the chat header, message authors in the timeline). Calling the
 *   single-agent hook from inside every leaf component would trigger
 *   N concurrent fetches and N object URLs for the same blob; the
 *   batch hook fetches once per (id, avatar_url) pair, returns a
 *   `Map<id, objectUrl | null>`, and the parent threads the map
 *   down as a prop. Per Cindy's PR-2 review, leaf components must
 *   never fetch internally.
 *
 * Both helpers fetch through the main-process auth proxy. On 4xx/5xx
 * the URL falls back to `null` so the caller renders the runtime icon
 * — there is no second-class error state for missing avatars.
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
    // Best-effort — caller falls back to the runtime placeholder.
    return null;
  }
}

/**
 * Resolve a single agent's `avatar_url` (relative path) into a
 * browser object URL. The hook owns the URL's lifetime: it revokes
 * the previous URL whenever `avatarUrl` changes or the component
 * unmounts. Pass `null`/`undefined` to short-circuit (no fetch).
 */
export function useAgentAvatarObjectUrl(
  avatarUrl: string | null | undefined,
): string | null {
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
export interface AgentAvatarSource {
  id: string;
  avatar_url: string | null;
}

/**
 * Batch resolver: takes a list of agents, returns a `Map<id, objectUrl | null>`.
 * Dedupes by `${id}:${avatar_url ?? ''}` so two agents with the same
 * `avatar_url` (rare but possible) share one fetch, and the same
 * `(id, avatar_url)` pair across renders reuses an in-flight promise.
 *
 * Caller responsibilities:
 *   - Pass a stable list (memoize the array reference). Re-creating
 *     the array every render forces a teardown/refetch cycle.
 *   - Treat the returned map as read-only.
 *
 * The hook owns object URL lifetimes — it revokes URLs for entries
 * that fall out of the input list, and revokes everything on
 * unmount.
 */
export function useAgentAvatarObjectUrls(
  agents: ReadonlyArray<AgentAvatarSource>,
): Map<string, string | null> {
  // Build a stable cache key per (id, avatar_url) pair so the effect
  // only re-runs when the relevant subset of input actually changes.
  // Deduped + SORTED so the key depends only on the SET of pairs, never their
  // order — reordering the input list (e.g. a drag-sorted sidebar) must not
  // tear down + refetch every avatar (that resets each URL to null mid-flight
  // and flashes the runtime fallback). #task:1146
  const cacheKey = useMemo(
    () =>
      Array.from(new Set(agents.map(a => `${a.id}:${a.avatar_url ?? ''}`)))
        .sort()
        .join('|'),
    [agents],
  );

  const [byId, setById] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const acs = new Map<string, AbortController>();
    const created = new Map<string, string>();
    // Collapse duplicates within this batch.
    const fetched = new Map<string, Promise<void>>();

    const next = new Map<string, string | null>();
    for (const a of agents) {
      if (!a.avatar_url) {
        next.set(a.id, null);
        continue;
      }
      // Reserve a slot so callers see the id immediately (object URL
      // arrives async).
      next.set(a.id, null);
      const k = `${a.id}:${a.avatar_url}`;
      if (fetched.has(k)) continue;
      const ac = new AbortController();
      acs.set(k, ac);
      const p = (async () => {
        const url = await fetchAvatarObjectUrl(a.avatar_url!, ac.signal);
        if (cancelled || ac.signal.aborted) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) created.set(k, url);
        // Append to the next snapshot — react with a fresh Map so
        // consumers re-render.
        setById(prev => {
          const out = new Map(prev);
          out.set(a.id, url);
          return out;
        });
      })();
      fetched.set(k, p);
    }

    // Reset to the new shape immediately so previous (now-orphaned)
    // entries clear out before the async fills come in.
    setById(next);

    return () => {
      cancelled = true;
      for (const ac of acs.values()) ac.abort();
      for (const url of created.values()) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cacheKey is the
    // stable identity of the input set; using `agents` here would
    // re-fire on every parent render that reconstructs the array.
  }, [cacheKey]);

  return byId;
}
