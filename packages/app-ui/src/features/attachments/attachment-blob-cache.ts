import { useSyncExternalStore } from "react";
import { fetchAttachmentBlob } from "../../lib/api";

const MAX_ENTRIES = 128;

interface CacheEntry {
  url: string;
  token: string;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, { token: string; promise: Promise<string> }>();

// Generation state. `epoch` is global (coarse gap recovery); `revById` is the
// precise per-id content revision learned from `attachment_changed`.
let epoch = 0;
const revById = new Map<string, number>();

// Subscribers re-render on ANY generation change; each reads its own id's token
// via `getSnapshot`, so React only re-renders the components whose token moved.
const listeners = new Set<() => void>();

function currentToken(id: string): string {
  return `${epoch}:${revById.get(id) ?? 0}`;
}

function emitGenerationChange(): void {
  for (const listener of Array.from(listeners)) listener();
}

function touch(id: string, entry: CacheEntry): void {
  // Re-insert so iteration order reflects most-recently-used.
  cache.delete(id);
  cache.set(id, entry);
  evictIfOverCap();
}

function evictIfOverCap(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) return;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) URL.revokeObjectURL(entry.url);
  }
}

/**
 * Cache a freshly-created object URL for `id`. When `revision` is known (upload
 * success carries the DTO `content_revision`), record it first so the entry's
 * token matches what the server will report and a redelivered
 * `attachment_changed` for the same revision is a no-op.
 */
export function setAttachmentBlobUrl(id: string, url: string, revision?: number): void {
  if (revision != null && revision > (revById.get(id) ?? 0)) {
    revById.set(id, revision);
    emitGenerationChange();
  }
  const token = currentToken(id);
  const existing = cache.get(id);
  if (existing && existing.url !== url) {
    // Replacing (fresher generation, or a re-registered preview) — revoke the
    // stale URL so we don't leak both copies.
    URL.revokeObjectURL(existing.url);
  }
  touch(id, { url, token });
}

/**
 * Synchronous cache read. Returns a URL only when the cached entry's token
 * still matches the current generation for `id`; a stale entry is a miss (the
 * URL is left in place so a currently-displayed <img> keeps working until a
 * fresher URL replaces it — see `loadAttachmentBlobUrl`).
 */
export function getAttachmentBlobUrl(id: string): string | undefined {
  const entry = cache.get(id);
  if (!entry) return undefined;
  if (entry.token !== currentToken(id)) return undefined;
  touch(id, entry);
  return entry.url;
}

/** Drop and revoke a cached URL. Safe to call with an unknown id. */
export function releaseAttachmentPreview(id: string): void {
  const entry = cache.get(id);
  if (!entry) return;
  cache.delete(id);
  URL.revokeObjectURL(entry.url);
}

/** Fetch the attachment via the authenticated API and cache the resulting
 *  object URL under the CURRENT generation token. De-duplicates concurrent
 *  fetches for the same id+token so a row of images doesn't trigger N parallel
 *  downloads. A fetch that resolves after its token moved (a generation bump
 *  landed mid-flight) neither writes back the stale bytes nor returns them — it
 *  revokes and re-drives to the current token, so the caller always resolves to
 *  the latest generation. */
export async function loadAttachmentBlobUrl(id: string): Promise<string> {
  const cached = getAttachmentBlobUrl(id);
  if (cached) return cached;
  const token = currentToken(id);
  const pending = inflight.get(id);
  if (pending && pending.token === token) return pending.promise;
  const promise = fetchAttachmentBlob(id)
    .then((res) => {
      if (currentToken(id) === token) {
        setAttachmentBlobUrl(id, res.url);
        return res.url;
      }
      // The generation moved while this fetch was in flight — these bytes are
      // already stale. Revoke them and re-drive to the current generation.
      URL.revokeObjectURL(res.url);
      return loadAttachmentBlobUrl(id);
    })
    .finally(() => {
      // Only clear the inflight slot if it is still ours; a newer-token load
      // may have replaced it, and we must not delete the live entry.
      if (inflight.get(id)?.token === token) inflight.delete(id);
    });
  inflight.set(id, { token, promise });
  return promise;
}

/**
 * Precise per-id generation bump from an `attachment_changed` event. Idempotent
 * on redelivery / reordering: a revision that is not strictly newer is ignored.
 */
export function bumpAttachmentRevision(id: string, revision: number): void {
  if (!Number.isFinite(revision)) return;
  if (revision <= (revById.get(id) ?? 0)) return;
  revById.set(id, revision);
  emitGenerationChange();
}

/**
 * Coarse global generation bump for a side-scope `snapshot_required`: a
 * reconnect gap may have dropped an `attachment_changed` whose id we cannot
 * name, so invalidate every cached blob and let each visible attachment
 * refetch the latest bytes.
 */
export function bumpAttachmentBlobEpoch(): void {
  epoch += 1;
  emitGenerationChange();
}

/**
 * Subscribe to the current generation token for `id`. Re-renders the caller
 * when the token changes (its revision bumped, or the global epoch bumped) so a
 * displayed preview reloads the latest bytes in place. Pair with a load effect
 * keyed on the returned token.
 */
export function useAttachmentBlobToken(id: string): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentToken(id),
  );
}

/** Test-only: read the current generation token without React. */
export function readAttachmentToken(id: string): string {
  return currentToken(id);
}

/** Test-only: reset all module state between tests. */
export function __resetAttachmentBlobCacheForTest(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  inflight.clear();
  revById.clear();
  epoch = 0;
  listeners.clear();
}
