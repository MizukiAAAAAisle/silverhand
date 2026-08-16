import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeMessageSeq } from '@silverhand/shared';

/**
 * Tiny localStorage polyfill — vitest runs this test in the node
 * environment by config, but place-memory.ts unconditionally touches
 * `localStorage`. The real renderer ships in Electron where the API
 * is native. Defining a Storage-shaped global before importing the
 * SUT keeps the test isolated without adding jsdom to devDeps.
 */
const memoryStore = new Map<string, string>();
const polyfill = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => {
    memoryStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    memoryStore.delete(key);
  },
  clear: () => {
    memoryStore.clear();
  },
  key: (index: number) => Array.from(memoryStore.keys())[index] ?? null,
  get length(): number {
    return memoryStore.size;
  },
} satisfies Storage;
(globalThis as { localStorage: Storage }).localStorage = polyfill;

const {
  LAST_CHANNEL_KEY,
  LAST_WORKSPACE_KEY,
  LAST_CHAT_PLACE_KEY,
  LAST_LAYOUT_KEY,
  CLOSE_WATERMARK_KEY,
  clearPlaceMemory,
  closeWatermarkByChannel,
  getChannelLayout,
  getCloseWatermark,
  getLastChatPlace,
  getLastWorkspaceId,
  lastChannelByWorkspace,
  lastLayoutByChannel,
  persistLastChannel,
  recordLastChatPlace,
  recordLastWorkspace,
  recordChannelLayout,
  recordCloseWatermark,
} = await import('./place-memory');

/**
 * place-memory is module-singleton state. The Map instances are
 * re-used across tests; we wipe them explicitly to avoid bleed.
 */
describe('place-memory', () => {
  beforeEach(() => {
    memoryStore.clear();
    clearPlaceMemory();
  });

  afterEach(() => {
    clearPlaceMemory();
    memoryStore.clear();
  });

  it('persistLastChannel writes the in-memory map to localStorage', () => {
    lastChannelByWorkspace.set('ws-1', 'ch-A');
    lastChannelByWorkspace.set('ws-2', 'ch-B');
    persistLastChannel();
    const raw = localStorage.getItem(LAST_CHANNEL_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'ws-1': 'ch-A', 'ws-2': 'ch-B' });
  });

  it('clearPlaceMemory wipes the map + localStorage key', () => {
    lastChannelByWorkspace.set('ws-1', 'ch-A');
    persistLastChannel();
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).not.toBeNull();

    clearPlaceMemory();

    expect(lastChannelByWorkspace.size).toBe(0);
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBeNull();
  });

  describe('last workspace memory', () => {
    it('recordLastWorkspace persists and getLastWorkspaceId reads it back', () => {
      recordLastWorkspace('ws-starred');

      expect(getLastWorkspaceId()).toBe('ws-starred');
      expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws-starred');
    });

    it('recordLastWorkspace overwrites with the newest selected workspace', () => {
      recordLastWorkspace('ws-a');
      recordLastWorkspace('ws-b');

      expect(getLastWorkspaceId()).toBe('ws-b');
      expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBe('ws-b');
    });

    it('clearPlaceMemory wipes the last workspace value + localStorage key', () => {
      recordLastWorkspace('ws-starred');
      expect(localStorage.getItem(LAST_WORKSPACE_KEY)).not.toBeNull();

      clearPlaceMemory();

      expect(getLastWorkspaceId()).toBeNull();
      expect(localStorage.getItem(LAST_WORKSPACE_KEY)).toBeNull();
    });

    it('hydrates the last workspace from localStorage on module load', async () => {
      memoryStore.set(LAST_WORKSPACE_KEY, 'ws-persisted');
      vi.resetModules();
      const fresh = await import('./place-memory');

      expect(fresh.getLastWorkspaceId()).toBe('ws-persisted');
      vi.resetModules();
    });
  });

  describe('Chat-rail place memory (#task:2042)', () => {
    it('records the direct arm with its conversation id and reads it back', () => {
      recordLastChatPlace({ kind: 'direct_pair', conversationId: 'c-dm' });

      expect(getLastChatPlace()).toEqual({
        kind: 'direct_pair',
        conversationId: 'c-dm',
      });
      expect(JSON.parse(localStorage.getItem(LAST_CHAT_PLACE_KEY)!)).toEqual({
        kind: 'direct_pair',
        conversationId: 'c-dm',
      });
    });

    it('records the workspace arm without any coordinate', () => {
      recordLastChatPlace({ kind: 'workspace_channel' });

      // No workspace/channel id here on purpose — those live in their own
      // memory, and a second copy could disagree with the first.
      expect(JSON.parse(localStorage.getItem(LAST_CHAT_PLACE_KEY)!)).toEqual({
        kind: 'workspace_channel',
      });
    });

    it('switching arms overwrites, so the newest place wins', () => {
      recordLastChatPlace({ kind: 'direct_pair', conversationId: 'c-dm' });
      recordLastChatPlace({ kind: 'workspace_channel' });
      expect(getLastChatPlace()).toEqual({ kind: 'workspace_channel' });

      recordLastChatPlace({ kind: 'direct_pair', conversationId: 'c-other' });
      expect(getLastChatPlace()).toEqual({
        kind: 'direct_pair',
        conversationId: 'c-other',
      });
    });

    it('keeps a DirectPair id out of the workspace-keyed memory', () => {
      // #task:2035's gate: a workspace-less line must not be written into the
      // per-workspace channel map, whose keys are workspace ids. Recording the
      // rail's arm must not have re-opened that door.
      recordLastChatPlace({ kind: 'direct_pair', conversationId: 'c-dm' });

      expect(lastChannelByWorkspace.size).toBe(0);
      expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBeNull();
      expect(getLastWorkspaceId()).toBeNull();
      expect(lastLayoutByChannel.has('c-dm')).toBe(false);
    });

    it('clearPlaceMemory wipes the place + its localStorage key', () => {
      // Per-viewer: the next signed-in human must not inherit a DM id.
      recordLastChatPlace({ kind: 'direct_pair', conversationId: 'c-dm' });
      expect(localStorage.getItem(LAST_CHAT_PLACE_KEY)).not.toBeNull();

      clearPlaceMemory();

      expect(getLastChatPlace()).toBeNull();
      expect(localStorage.getItem(LAST_CHAT_PLACE_KEY)).toBeNull();
    });

    it('hydrates the place from localStorage on module load', async () => {
      memoryStore.set(
        LAST_CHAT_PLACE_KEY,
        JSON.stringify({ kind: 'direct_pair', conversationId: 'c-persisted' }),
      );
      vi.resetModules();
      const fresh = await import('./place-memory');

      expect(fresh.getLastChatPlace()).toEqual({
        kind: 'direct_pair',
        conversationId: 'c-persisted',
      });
      vi.resetModules();
    });

    it('drops a malformed persisted place rather than routing from it', async () => {
      // A direct arm with no id, an unknown kind, and non-JSON all fail the
      // codec: the value cannot become a route, so the rail falls back to the
      // workspace arm instead of navigating somewhere half-built.
      for (const raw of [
        JSON.stringify({ kind: 'direct_pair' }),
        JSON.stringify({ kind: 'direct_pair', conversationId: '' }),
        JSON.stringify({ kind: 'wat' }),
        JSON.stringify('direct_pair'),
        'not json',
      ]) {
        memoryStore.set(LAST_CHAT_PLACE_KEY, raw);
        vi.resetModules();
        const fresh = await import('./place-memory');
        expect(fresh.getLastChatPlace()).toBeNull();
      }
      vi.resetModules();
    });
  });

  describe('per-channel layout memory', () => {
    it('recordChannelLayout persists and getChannelLayout reads it back', () => {
      recordChannelLayout('ch-A', { kind: 'threads-list' });
      expect(getChannelLayout('ch-A')).toEqual({ kind: 'threads-list' });
      expect(JSON.parse(localStorage.getItem(LAST_LAYOUT_KEY)!)).toEqual({
        'ch-A': { kind: 'threads-list' },
      });
    });

    it('getChannelLayout returns null for an unknown channel', () => {
      expect(getChannelLayout('nope')).toBeNull();
    });

    it('recordChannelLayout overwrites a channel with its newest layout', () => {
      recordChannelLayout('ch-A', { kind: 'threads-list' });
      recordChannelLayout('ch-A', { kind: 'side', id: 'c-x' });
      expect(getChannelLayout('ch-A')).toEqual({ kind: 'side', id: 'c-x' });
    });

    it('records an explicit none so a deliberate close survives re-entry', () => {
      recordChannelLayout('ch-A', { kind: 'none' });
      expect(getChannelLayout('ch-A')).toEqual({ kind: 'none' });
    });

    it('clearPlaceMemory wipes the layout map + its localStorage key', () => {
      recordChannelLayout('ch-A', { kind: 'thread', rootId: 'm-1' });
      expect(localStorage.getItem(LAST_LAYOUT_KEY)).not.toBeNull();

      clearPlaceMemory();

      expect(lastLayoutByChannel.size).toBe(0);
      expect(localStorage.getItem(LAST_LAYOUT_KEY)).toBeNull();
    });

    it('drops malformed entries on load (validated against the layout shape)', async () => {
      // A thread layout missing its rootId, and a side missing its id,
      // are corrupt — the loader must drop them rather than hand back a
      // half-built layout the URL builder would mis-serialize. A valid
      // entry alongside them survives. Load happens at import time, so we
      // seed the store and re-import the module with a fresh registry.
      memoryStore.set(
        LAST_LAYOUT_KEY,
        JSON.stringify({
          'ch-bad-thread': { kind: 'thread' },
          'ch-bad-side': { kind: 'side' },
          'ch-bad-kind': { kind: 'wat' },
          'ch-good': { kind: 'side', id: 'c-x' },
        }),
      );
      vi.resetModules();
      const fresh = await import('./place-memory');
      expect(fresh.getChannelLayout('ch-bad-thread')).toBeNull();
      expect(fresh.getChannelLayout('ch-bad-side')).toBeNull();
      expect(fresh.getChannelLayout('ch-bad-kind')).toBeNull();
      expect(fresh.getChannelLayout('ch-good')).toEqual({
        kind: 'side',
        id: 'c-x',
      });
      vi.resetModules();
    });

    it('drops a stale persisted files-list entry (Attachments no longer persists)', async () => {
      // The Attachments panel became a transient overlay — `files-list` was
      // removed from ChannelLayout. A value written by an older build must be
      // rejected on load (not laundered into an invalid layout), so the
      // channel opens bare instead of resurrecting a pane the model no longer
      // knows how to render.
      memoryStore.set(
        LAST_LAYOUT_KEY,
        JSON.stringify({ 'ch-files': { kind: 'files-list' } }),
      );
      vi.resetModules();
      const fresh = await import('./place-memory');
      expect(fresh.getChannelLayout('ch-files')).toBeNull();
      vi.resetModules();
    });
  });

  describe('explicit-close watermark', () => {
    it('recordCloseWatermark persists and getCloseWatermark reads it back', () => {
      recordCloseWatermark('ch-A', decodeMessageSeq(42));
      expect(getCloseWatermark('ch-A')).toBe(42);
      expect(JSON.parse(localStorage.getItem(CLOSE_WATERMARK_KEY)!)).toEqual({
        'ch-A': 42,
      });
    });

    it('getCloseWatermark returns null for an unknown channel', () => {
      expect(getCloseWatermark('nope')).toBeNull();
    });

    it('is monotonic — a newer seq raises the watermark', () => {
      recordCloseWatermark('ch-A', decodeMessageSeq(10));
      recordCloseWatermark('ch-A', decodeMessageSeq(25));
      expect(getCloseWatermark('ch-A')).toBe(25);
    });

    it('never lowers an existing watermark with a smaller seq', () => {
      recordCloseWatermark('ch-A', decodeMessageSeq(25));
      recordCloseWatermark('ch-A', decodeMessageSeq(10));
      expect(getCloseWatermark('ch-A')).toBe(25);
    });

    it('clearPlaceMemory wipes the watermark map + its localStorage key', () => {
      recordCloseWatermark('ch-A', decodeMessageSeq(7));
      expect(localStorage.getItem(CLOSE_WATERMARK_KEY)).not.toBeNull();

      clearPlaceMemory();

      expect(closeWatermarkByChannel.size).toBe(0);
      expect(localStorage.getItem(CLOSE_WATERMARK_KEY)).toBeNull();
    });

    it('drops malformed (non-number) entries on load', async () => {
      memoryStore.set(
        CLOSE_WATERMARK_KEY,
        JSON.stringify({ 'ch-bad': 'nope', 'ch-good': 99 }),
      );
      vi.resetModules();
      const fresh = await import('./place-memory');
      expect(fresh.getCloseWatermark('ch-bad')).toBeNull();
      expect(fresh.getCloseWatermark('ch-good')).toBe(99);
      vi.resetModules();
    });

    it('rejects a numeric-but-invalid stored seq at the decode boundary (#task:1267 §3.4)', async () => {
      // A negative / fractional value survives JSON + loadNumberMap's
      // `typeof === number` filter but is NOT a valid MessageSeq. getCloseWatermark
      // is the renderer's sole runtime decode boundary: it validates through the
      // shared decodeMessageSeq, so garbage is REJECTED to null (no watermark →
      // unread still surfaces), never laundered through as a real seq.
      memoryStore.set(
        CLOSE_WATERMARK_KEY,
        JSON.stringify({ 'ch-neg': -5, 'ch-frac': 3.5, 'ch-ok': 12 }),
      );
      vi.resetModules();
      const fresh = await import('./place-memory');
      expect(fresh.getCloseWatermark('ch-neg')).toBeNull();
      expect(fresh.getCloseWatermark('ch-frac')).toBeNull();
      expect(fresh.getCloseWatermark('ch-ok')).toBe(12);
      vi.resetModules();
    });
  });
});
