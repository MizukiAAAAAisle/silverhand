import { useEffect, useMemo, useState } from "react";
import { getAvatarBlobUrl, loadAvatarBlobUrl } from "@/lib/avatar-blob-cache";

/**
 * Avatar fetch hooks for agents. Both flavors resolve an `avatar_url` (relative
 * `?v=`-versioned path baked into `AgentDto`) into a browser object URL by
 * delegating to the app-session avatar cache (`@/lib/avatar-blob-cache`).
 *
 * The session cache — not the component — owns the object URL's lifetime: the
 * same `avatar_url` is fetched exactly once per renderer session and reused
 * across every consumer and every re-render, so a new message in a conversation
 * (or a remounted virtualized row) never re-fetches an avatar it already has
 * (#task:1321). These hooks therefore NEVER revoke; teardown is the cache's job
 * (logout / session reset `clearAvatarBlobCache`).
 *
 * Why two flavors:
 *
 * - `useAgentAvatarObjectUrl(avatarUrl)`: the obvious shape for views that
 *   render exactly one agent (AgentHeader, AgentProfileCard, AgentInfoPopover).
 *
 * - `useAgentAvatarObjectUrls(agents)`: the parent-batch shape for surfaces that
 *   render N agents in the same view (member chips, message authors). The parent
 *   resolves the whole set once and threads a `Map<id, objectUrl | null>` down
 *   as a prop; leaf components must never fetch internally (Cindy PR-2 review).
 *
 * On 4xx/5xx the value falls back to `null` so the caller renders the runtime
 * icon — there is no second-class error state for missing avatars.
 */

/**
 * Resolve a single agent's `avatar_url` into a session-cached object URL. Seeds
 * from the cache synchronously so a remount with an already-fetched avatar shows
 * it with no flash-to-placeholder. Pass `null`/`undefined` to short-circuit.
 */
export function useAgentAvatarObjectUrl(avatarUrl: string | null | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(() =>
    avatarUrl ? (getAvatarBlobUrl(avatarUrl) ?? null) : null,
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
    void loadAvatarBlobUrl(avatarUrl).then((url) => {
      if (!cancelled) setObjectUrl(url);
    });
    return () => {
      cancelled = true;
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
 *
 * Session-cache-backed, so a cached avatar fills the returned map synchronously
 * (no flash) and only genuinely-uncached avatars fetch. The session cache
 * de-dupes concurrent fetches for the same url, so two agents sharing an
 * `avatar_url` (or the same avatar across many surfaces) never multiply calls.
 *
 * Caller responsibilities:
 *   - Pass a stable list (memoize the array reference). Re-creating the array
 *     every render is cheap here (cached avatars re-seed synchronously) but a
 *     stable reference still avoids needless effect churn.
 *   - Treat the returned map as read-only.
 */
export function useAgentAvatarObjectUrls(
  agents: ReadonlyArray<AgentAvatarSource>,
): Map<string, string | null> {
  // Stable cache key per (id, avatar_url) SET — deduped + sorted so reordering
  // the input list never re-runs the effect (#task:1146).
  const cacheKey = useMemo(
    () =>
      Array.from(new Set(agents.map((a) => `${a.id}:${a.avatar_url ?? ""}`)))
        .sort()
        .join("|"),
    [agents],
  );

  const [byId, setById] = useState<Map<string, string | null>>(() => new Map());

  useEffect(() => {
    let cancelled = false;

    // Seed synchronously from the session cache: known avatars land with no
    // flash; unknowns start null and fill in as their (deduped) fetches land.
    const next = new Map<string, string | null>();
    const toLoad: Array<{ id: string; url: string }> = [];
    for (const a of agents) {
      if (!a.avatar_url) {
        next.set(a.id, null);
        continue;
      }
      const cached = getAvatarBlobUrl(a.avatar_url);
      next.set(a.id, cached ?? null);
      if (!cached) toLoad.push({ id: a.id, url: a.avatar_url });
    }
    setById(next);

    for (const { id, url } of toLoad) {
      // loadAvatarBlobUrl de-dupes concurrent same-url fetches internally.
      void loadAvatarBlobUrl(url).then((resolved) => {
        if (cancelled || !resolved) return;
        setById((prev) => {
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
    // stable identity of the input set; using `agents` here would re-fire on
    // every parent render that reconstructs the array.
  }, [cacheKey]);

  return byId;
}
