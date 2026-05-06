import { fetchAttachmentBlob } from './api';

/**
 * Renderer-side LRU cache of attachment blob object URLs keyed by
 * attachment id.
 *
 * Why this exists:
 *   - Composer registers a URL the moment a file is picked / pasted /
 *     dropped, so the chip preview and the optimistic message both
 *     render the image bytes instantly without a network round-trip.
 *   - MessageItem looks the URL up before falling back to a backend
 *     fetch, so the swap from "optimistic temp message" → "real
 *     persisted message" doesn't trigger a reload (same id, same URL).
 *
 * Lifecycle ownership rules (also documented in Composer / MessageItem):
 *   - Composer owns a preview URL it created with `URL.createObjectURL`
 *     UNTIL upload succeeds. On success it calls `setAttachmentBlobUrl`,
 *     which transfers ownership to the cache. On upload failure or
 *     pre-upload chip removal, Composer revokes the URL itself.
 *   - MessageItem only READS via `getAttachmentBlobUrl` /
 *     `loadAttachmentBlobUrl`. It must not call revoke directly — the
 *     same URL may be displayed in another row (e.g. message replayed
 *     in a thread pane) or in a Lightbox.
 *   - The cache revokes URLs when (a) explicit `releaseAttachmentPreview`
 *     is called (e.g. when a message is deleted), or (b) the LRU cap is
 *     exceeded and the oldest entry is evicted. MessageItem's <img>
 *     guards against use-after-revoke via `onError`, which falls back
 *     to `loadAttachmentBlobUrl` — that misses the cache (we just
 *     revoked) and re-fetches from the backend.
 *
 * Cap rationale: 10MB per-attachment server cap × 128 entries ≈ 1.3GB
 * worst-case memory ceiling. Realistic usage is far lower (most
 * attachments are screenshots <500KB) but the cap stops a long-running
 * session from leaking unbounded blob memory.
 */
const MAX_ENTRIES = 128;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function touch(id: string, url: string): void {
  // Re-insert so iteration order reflects most-recently-used.
  cache.delete(id);
  cache.set(id, url);
  evictIfOverCap();
}

function evictIfOverCap(): void {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) return;
    const url = cache.get(oldest);
    cache.delete(oldest);
    if (url) URL.revokeObjectURL(url);
  }
}

export function setAttachmentBlobUrl(id: string, url: string): void {
  const existing = cache.get(id);
  if (existing && existing !== url) {
    // Replacing — revoke the stale URL so we don't leak both copies.
    URL.revokeObjectURL(existing);
  }
  touch(id, url);
}

export function getAttachmentBlobUrl(id: string): string | undefined {
  const url = cache.get(id);
  if (url) touch(id, url);
  return url;
}

/** Drop and revoke a cached URL. Safe to call with an unknown id. */
export function releaseAttachmentPreview(id: string): void {
  const url = cache.get(id);
  if (!url) return;
  cache.delete(id);
  URL.revokeObjectURL(url);
}

/** Fetch the attachment via the authenticated API and cache the
 *  resulting object URL. De-duplicates concurrent fetches for the same
 *  id so a row of images doesn't trigger N parallel downloads of the
 *  same blob across re-renders. */
export async function loadAttachmentBlobUrl(id: string): Promise<string> {
  const cached = getAttachmentBlobUrl(id);
  if (cached) return cached;
  const pending = inflight.get(id);
  if (pending) return pending;
  const promise = fetchAttachmentBlob(id)
    .then(res => {
      setAttachmentBlobUrl(id, res.url);
      return res.url;
    })
    .finally(() => {
      inflight.delete(id);
    });
  inflight.set(id, promise);
  return promise;
}
