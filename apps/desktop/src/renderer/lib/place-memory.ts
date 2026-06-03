/**
 * Per-workspace "last viewed channel" and per-channel "last open thread"
 * persistence.
 *
 * Maps live in module-level singletons hydrated from localStorage at
 * import time. Mutations write through to localStorage immediately so
 * the next launch restores the place even if the app crashes between
 * routes.
 *
 * Multi-human audit 2026-06-03 #task:857 P0.7. The two maps are
 * **identity-bound** — when a remote-backend viewer logs out, the next
 * session's human must NOT inherit the previous viewer's last-visited
 * channel. {@link clearPlaceMemory} wipes both the disk values AND the
 * in-process Maps so App.tsx's restore effect sees an empty slate.
 *
 * Lives in `lib/` (not `App.tsx`) so `useLogout` in
 * `features/me/hooks.ts` can import it without taking a circular
 * dependency on the App module.
 */

export const LAST_CHANNEL_KEY = 'silverhand:layout.last-channel-by-workspace';
export const LAST_THREAD_KEY = 'silverhand:layout.last-thread-by-channel';

function loadStringMap(key: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, string>;
    if (!obj || typeof obj !== 'object') return new Map();
    return new Map(
      Object.entries(obj).filter(
        ([k, v]) => typeof k === 'string' && typeof v === 'string',
      ),
    );
  } catch {
    return new Map();
  }
}

function saveStringMap(key: string, map: Map<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Quota / disabled storage — fall back to in-memory only.
  }
}

export const lastChannelByWorkspace = loadStringMap(LAST_CHANNEL_KEY);
export const lastThreadByChannel = loadStringMap(LAST_THREAD_KEY);

export function persistLastChannel(): void {
  saveStringMap(LAST_CHANNEL_KEY, lastChannelByWorkspace);
}

export function persistLastThread(): void {
  saveStringMap(LAST_THREAD_KEY, lastThreadByChannel);
}

/**
 * Wipe both the disk values and the in-process Maps. Called from
 * `useLogout` so the next signed-in human starts with a blank place
 * memory.
 */
export function clearPlaceMemory(): void {
  lastChannelByWorkspace.clear();
  lastThreadByChannel.clear();
  try {
    localStorage.removeItem(LAST_CHANNEL_KEY);
    localStorage.removeItem(LAST_THREAD_KEY);
  } catch {
    // Quota / disabled storage — Maps are already empty.
  }
}
