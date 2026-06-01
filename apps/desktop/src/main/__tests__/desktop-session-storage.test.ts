import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPersistedDesktopSession,
  desktopSessionPath,
  loadPersistedDesktopSessionToken,
  persistDesktopSessionToken,
} from '../desktop-session-storage.js';

describe('desktop-session-storage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'desktop-session-storage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stores the session bearer as a 0600 plaintext local file', () => {
    persistDesktopSessionToken({
      silverhandRoot: root,
      token: 'session-token-plain',
    });

    const path = desktopSessionPath(root);
    expect(readFileSync(path, 'utf8')).toBe('session-token-plain');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('loads a persisted token and trims trailing whitespace', () => {
    const path = desktopSessionPath(root);
    persistDesktopSessionToken({ silverhandRoot: root, token: 'abc\n' });
    expect(loadPersistedDesktopSessionToken({ silverhandRoot: root })).toBe('abc');
    expect(path).toBe(join(root, 'desktop', 'session.bin'));
  });

  it('treats missing or empty files as no token', () => {
    expect(loadPersistedDesktopSessionToken({ silverhandRoot: root })).toBeNull();

    persistDesktopSessionToken({ silverhandRoot: root, token: '' });
    expect(loadPersistedDesktopSessionToken({ silverhandRoot: root })).toBeNull();
  });

  it('clears idempotently', () => {
    persistDesktopSessionToken({ silverhandRoot: root, token: 'abc' });
    clearPersistedDesktopSession({ silverhandRoot: root });
    expect(existsSync(desktopSessionPath(root))).toBe(false);

    const warn = vi.fn();
    clearPersistedDesktopSession({
      silverhandRoot: root,
      logger: { warn },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when an existing session path cannot be read', () => {
    const path = desktopSessionPath(root);
    mkdirSync(path, { recursive: true });
    const warn = vi.fn();

    expect(
      loadPersistedDesktopSessionToken({
        silverhandRoot: root,
        logger: { warn },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(path).toBe(join(root, 'desktop', 'session.bin'));
  });
});
