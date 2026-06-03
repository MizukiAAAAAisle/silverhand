import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  LAST_THREAD_KEY,
  clearPlaceMemory,
  lastChannelByWorkspace,
  lastThreadByChannel,
  persistLastChannel,
  persistLastThread,
} = await import('./place-memory');

/**
 * place-memory is module-singleton state. The Map instances are
 * re-used across tests; we wipe them explicitly to avoid bleed.
 */
describe('place-memory', () => {
  beforeEach(() => {
    memoryStore.clear();
    lastChannelByWorkspace.clear();
    lastThreadByChannel.clear();
  });

  afterEach(() => {
    memoryStore.clear();
    lastChannelByWorkspace.clear();
    lastThreadByChannel.clear();
  });

  it('persistLastChannel writes the in-memory map to localStorage', () => {
    lastChannelByWorkspace.set('ws-1', 'ch-A');
    lastChannelByWorkspace.set('ws-2', 'ch-B');
    persistLastChannel();
    const raw = localStorage.getItem(LAST_CHANNEL_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ 'ws-1': 'ch-A', 'ws-2': 'ch-B' });
  });

  it('persistLastThread writes the in-memory map to localStorage', () => {
    lastThreadByChannel.set('ch-A', 't-1');
    persistLastThread();
    expect(JSON.parse(localStorage.getItem(LAST_THREAD_KEY)!)).toEqual({
      'ch-A': 't-1',
    });
  });

  it('clearPlaceMemory wipes both maps + both localStorage keys', () => {
    lastChannelByWorkspace.set('ws-1', 'ch-A');
    lastThreadByChannel.set('ch-A', 't-1');
    persistLastChannel();
    persistLastThread();
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).not.toBeNull();
    expect(localStorage.getItem(LAST_THREAD_KEY)).not.toBeNull();

    clearPlaceMemory();

    expect(lastChannelByWorkspace.size).toBe(0);
    expect(lastThreadByChannel.size).toBe(0);
    expect(localStorage.getItem(LAST_CHANNEL_KEY)).toBeNull();
    expect(localStorage.getItem(LAST_THREAD_KEY)).toBeNull();
  });
});
