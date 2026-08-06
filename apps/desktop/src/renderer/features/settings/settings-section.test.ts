import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavior of the settings-section store, not its markup: aiming Settings
 * at a section must survive unusable localStorage, because the Members
 * profile card's "Edit in Settings" does nothing else to carry the intent
 * (#task:1846).
 *
 * The module holds the section in a singleton, so every case loads a
 * fresh copy.
 */

type StorageStub = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function stubGlobalStorage(storage: StorageStub | null): void {
  const scope = globalThis as { localStorage?: unknown };
  if (storage === null) delete scope.localStorage;
  else scope.localStorage = storage;
}

async function loadStore(storage: StorageStub | null) {
  vi.resetModules();
  stubGlobalStorage(storage);
  return import('./settings-section');
}

/** Storage that reads back what was written, like a healthy browser. */
function workingStorage(initial: string | null = null): StorageStub {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
}

/** Disabled / partitioned / over-quota storage: every access throws. */
function unusableStorage(): StorageStub {
  return {
    getItem: () => {
      throw new Error('storage unavailable');
    },
    setItem: () => {
      throw new Error('storage unavailable');
    },
    removeItem: () => {
      throw new Error('storage unavailable');
    },
  };
}

afterEach(() => {
  stubGlobalStorage(null);
});

describe('settings-section store — where Settings opens', () => {
  it('opens on Appearance when nothing is stored', async () => {
    const store = await loadStore(workingStorage());
    expect(store.readSettingsSection()).toBe('appearance');
  });

  it('opens on the stored section', async () => {
    const store = await loadStore(workingStorage('connection'));
    expect(store.readSettingsSection()).toBe('connection');
  });

  it('migrates the persisted `profile` key forward to `account`', async () => {
    // Profile editing lived in Members while the section was named
    // `profile`; a returning user must still land on Account.
    const store = await loadStore(workingStorage('profile'));
    expect(store.readSettingsSection()).toBe('account');
  });

  it('folds retired sections into Connection and ignores unknown values', async () => {
    for (const raw of ['server', 'hosts', 'proxy']) {
      const store = await loadStore(workingStorage(raw));
      expect(store.readSettingsSection()).toBe('connection');
    }
    const unknown = await loadStore(workingStorage('nonsense'));
    expect(unknown.readSettingsSection()).toBe('appearance');
  });
});

describe('settings-section store — aiming survives unusable storage', () => {
  it('still opens on the aimed section when the write throws', async () => {
    const store = await loadStore(unusableStorage());
    expect(() => store.persistSettingsSection('account')).not.toThrow();
    expect(store.readSettingsSection()).toBe('account');
  });

  it('opens on Appearance when the read throws, without propagating', async () => {
    const store = await loadStore(unusableStorage());
    expect(() => store.readSettingsSection()).not.toThrow();
    expect(store.readSettingsSection()).toBe('appearance');
  });

  it('honours a second aim after the user moved elsewhere in Settings', async () => {
    // The in-memory section is not a one-shot flag: it is overwritten by
    // whoever wrote last, so a repeat visit from the same entry point is
    // not a no-op.
    const store = await loadStore(unusableStorage());
    store.persistSettingsSection('account');
    expect(store.readSettingsSection()).toBe('account');
    store.persistSettingsSection('connection'); // user switches tabs
    expect(store.readSettingsSection()).toBe('connection');
    store.persistSettingsSection('account'); // aimed again from Members
    expect(store.readSettingsSection()).toBe('account');
  });

  it('survives storage that reappears mid-session without losing the aim', async () => {
    const store = await loadStore(unusableStorage());
    store.persistSettingsSection('account');
    stubGlobalStorage(workingStorage('connection'));
    expect(store.readSettingsSection()).toBe('account');
  });
});

describe('settings-section store — logout does not hand the section to the next viewer', () => {
  it('clears memory and disk, so the next viewer starts on Appearance', async () => {
    // Viewer A signs out on Account; viewer B signs in inside the same
    // renderer process, where the singleton would otherwise outlive the
    // session and be served ahead of the emptied storage key.
    const storage = workingStorage();
    const store = await loadStore(storage);
    store.persistSettingsSection('account');
    expect(storage.getItem('silverhand:settings-section')).toBe('account');

    store.clearSettingsSection();

    expect(store.readSettingsSection()).toBe('appearance');
    expect(storage.getItem('silverhand:settings-section')).toBeNull();
  });

  it('clears the section even when storage refuses the removal', async () => {
    const store = await loadStore(unusableStorage());
    store.persistSettingsSection('account');
    expect(() => store.clearSettingsSection()).not.toThrow();
    expect(store.readSettingsSection()).toBe('appearance');
  });
});
