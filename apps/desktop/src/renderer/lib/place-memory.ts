/**
 * Per-workspace "last viewed channel" persistence.
 *
 * The map lives in a module-level singleton hydrated from localStorage at
 * import time. Mutations write through to localStorage immediately so
 * the next launch restores the place even if the app crashes between
 * routes.
 *
 * Multi-human audit 2026-06-03 #task:857 P0.7. The map is
 * **identity-bound** — when a remote-backend viewer logs out, the next
 * session's human must NOT inherit the previous viewer's last-visited
 * channel. {@link clearPlaceMemory} wipes both the disk value AND the
 * in-process Map so App.tsx's restore effect sees an empty slate.
 *
 * Besides the last channel per workspace, we also remember the last
 * **secondary-pane layout per channel** ({@link lastLayoutByChannel}) so
 * switching away from a channel and back restores its threads-list /
 * thread / side overlay instead of dropping to a bare channel, plus a
 * per-channel **explicit-close watermark** ({@link closeWatermarkByChannel})
 * that lets an unread thread auto-surface without immediately re-surfacing
 * a batch the user just closed. All three maps are wiped together on
 * logout.
 *
 * Lives in `lib/` (not `App.tsx`) so `useLogout` in
 * `features/me/hooks.ts` can import it without taking a circular
 * dependency on the App module.
 */

import type { ChannelLayout } from '@/router';

export const LAST_CHANNEL_KEY = 'silverhand:layout.last-channel-by-workspace';
export const LAST_LAYOUT_KEY = 'silverhand:layout.last-layout-by-channel';
export const CLOSE_WATERMARK_KEY = 'silverhand:layout.close-watermark-by-channel';

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

function loadNumberMap(key: string): Map<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return new Map();
    return new Map(
      Object.entries(obj).filter(
        (entry): entry is [string, number] =>
          typeof entry[0] === 'string' && typeof entry[1] === 'number',
      ),
    );
  } catch {
    return new Map();
  }
}

function saveNumberMap(key: string, map: Map<string, number>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Quota / disabled storage — fall back to in-memory only.
  }
}

export const lastChannelByWorkspace = loadStringMap(LAST_CHANNEL_KEY);

export function persistLastChannel(): void {
  saveStringMap(LAST_CHANNEL_KEY, lastChannelByWorkspace);
}

/**
 * Per-channel secondary-pane layout. Hydrated from localStorage at import
 * time and written through on every change so the layout survives both a
 * channel switch and an app restart. Values are validated on load —
 * anything that doesn't match the {@link ChannelLayout} shape is dropped
 * rather than trusted.
 */
function loadLayoutMap(key: string): Map<string, ChannelLayout> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return new Map();
    const out = new Map<string, ChannelLayout>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k !== 'string') continue;
      const parsed = parseLayout(v);
      if (parsed) out.set(k, parsed);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Validate one persisted layout entry. Returns null for any shape that
 *  doesn't round-trip the {@link ChannelLayout} contract. */
function parseLayout(value: unknown): ChannelLayout | null {
  if (!value || typeof value !== 'object') return null;
  const layout = value as { kind?: unknown; rootId?: unknown; id?: unknown };
  switch (layout.kind) {
    case 'none':
      return { kind: 'none' };
    case 'threads-list':
      return { kind: 'threads-list' };
    case 'thread':
      return typeof layout.rootId === 'string' && layout.rootId.length > 0
        ? { kind: 'thread', rootId: layout.rootId }
        : null;
    case 'side':
      return typeof layout.id === 'string' && layout.id.length > 0
        ? { kind: 'side', id: layout.id }
        : null;
    default:
      return null;
  }
}

export const lastLayoutByChannel = loadLayoutMap(LAST_LAYOUT_KEY);

function persistLastLayout(): void {
  try {
    localStorage.setItem(
      LAST_LAYOUT_KEY,
      JSON.stringify(Object.fromEntries(lastLayoutByChannel)),
    );
  } catch {
    // Quota / disabled storage — fall back to in-memory only.
  }
}

/** Read a channel's remembered layout, or null when none is stored. */
export function getChannelLayout(channelId: string): ChannelLayout | null {
  return lastLayoutByChannel.get(channelId) ?? null;
}

/**
 * Record a channel's secondary-pane layout, persisting through to disk.
 * No-ops when the layout is byte-identical to what's already stored so we
 * don't thrash localStorage on every unrelated route change.
 */
export function recordChannelLayout(
  channelId: string,
  layout: ChannelLayout,
): void {
  const prev = lastLayoutByChannel.get(channelId);
  if (prev && JSON.stringify(prev) === JSON.stringify(layout)) return;
  lastLayoutByChannel.set(channelId, layout);
  persistLastLayout();
}

/**
 * Per-channel explicit-close watermark (#task:1082). When the user
 * explicitly closes a channel's secondary pane, we stamp the seq of the
 * unread pointer they just dismissed. The channel-open precedence
 * ({@link resolveChannelOpen}) only auto-surfaces an unread thread when
 * its pointer `seq` exceeds this watermark — so a just-closed batch isn't
 * yanked back, but a genuinely newer reply still re-surfaces.
 */
export const closeWatermarkByChannel = loadNumberMap(CLOSE_WATERMARK_KEY);

/** Read a channel's explicit-close watermark, or null when none is set. */
export function getCloseWatermark(channelId: string): number | null {
  return closeWatermarkByChannel.get(channelId) ?? null;
}

/**
 * Stamp a channel's explicit-close watermark, persisting through to disk.
 * Monotonic — a smaller seq never lowers an existing watermark, and a
 * byte-identical value no-ops to avoid thrashing localStorage.
 */
export function recordCloseWatermark(channelId: string, seq: number): void {
  const prev = closeWatermarkByChannel.get(channelId);
  if (prev !== undefined && prev >= seq) return;
  closeWatermarkByChannel.set(channelId, seq);
  saveNumberMap(CLOSE_WATERMARK_KEY, closeWatermarkByChannel);
}

/**
 * Wipe both the disk value and the in-process Map. Called from
 * `useLogout` so the next signed-in human starts with a blank place
 * memory.
 */
export function clearPlaceMemory(): void {
  lastChannelByWorkspace.clear();
  lastLayoutByChannel.clear();
  closeWatermarkByChannel.clear();
  try {
    localStorage.removeItem(LAST_CHANNEL_KEY);
    localStorage.removeItem(LAST_LAYOUT_KEY);
    localStorage.removeItem(CLOSE_WATERMARK_KEY);
  } catch {
    // Quota / disabled storage — Maps are already empty.
  }
}
