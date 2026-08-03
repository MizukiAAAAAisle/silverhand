import { useEffect, useState } from 'react';

/**
 * How chat messages are arranged horizontally.
 *
 * - `'user-right'`: current user's messages flush right, others left
 *   (Slack/iMessage convention).
 * - `'all-left'`: every message left-aligned (Discord / log-style). Default —
 *   the screenshot export also renders all-left, so a shared image reads as a
 *   neutral log rather than baking in the exporter's personal alignment.
 *
 * Persisted to localStorage so the choice survives reloads. A real
 * Settings panel will own the toggle later; for now the only writer
 * is the dev console (`localStorage.setItem(...)`) or the (TODO)
 * settings UI.
 */
export type MessageLayoutMode = 'user-right' | 'all-left';

const STORAGE_KEY = 'silverhand.layout.message-mode';
const DEFAULT_MODE: MessageLayoutMode = 'all-left';

function read(): MessageLayoutMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'all-left' || v === 'user-right' ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function useMessageLayoutMode(): MessageLayoutMode {
  const [mode, setMode] = useState<MessageLayoutMode>(read);

  useEffect(() => {
    // Pick up dev-console changes from `localStorage.setItem(...)` in
    // other tabs; same-tab writes still need a manual reload (the
    // `storage` event doesn't fire on the writing tab).
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_KEY) setMode(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return mode;
}
