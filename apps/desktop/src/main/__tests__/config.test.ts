import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_CONFIG_FILENAME } from '@silverhand/shared';
import {
  electronUserDataPath,
  loadOrCreateServerConfig,
  shouldRedirectElectronUserData,
  silverhandDir,
  writeServerConfig,
} from '../config.js';

describe('desktop server config', () => {
  const originalSilverhandDir = process.env.SILVERHAND_DIR;
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
    if (originalSilverhandDir === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = originalSilverhandDir;
  });

  it('creates new server-config.json without the retired auth_token field', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-config-'));
    process.env.SILVERHAND_DIR = tmp;

    const config = await loadOrCreateServerConfig();
    expect(config.auth_token).toBeUndefined();

    const raw = readConfig(tmp);
    expect(raw).not.toHaveProperty('auth_token');
    expect(raw).toMatchObject({
      mode: 'embedded',
      url: 'http://127.0.0.1:0',
      refresh_token: null,
    });
  });

  it('reads old auth_token configs but omits the field on rewrite', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-config-'));
    process.env.SILVERHAND_DIR = tmp;
    writeFileSync(
      join(tmp, SERVER_CONFIG_FILENAME),
      JSON.stringify({
        mode: 'embedded',
        url: 'http://127.0.0.1:0',
        auth_token: 'a'.repeat(32),
        refresh_token: null,
        child_sessions: {
          max_concurrent_per_parent: null,
          spawn_cooldown_seconds: null,
          max_depth: 1,
        },
      }),
      { mode: 0o600 },
    );

    const config = await loadOrCreateServerConfig();
    expect(config.auth_token).toBe('a'.repeat(32));

    await writeServerConfig(config);
    const raw = readConfig(tmp);
    expect(raw).not.toHaveProperty('auth_token');
  });

  it('never persists the generated event_ws_allowed_origins allowlist', async () => {
    // #task:1428 P1: the embedded allowlist is a per-boot GENERATED value (the
    // current finalized loopback origin, re-seeded fresh by startBackend), not a
    // durable setting. Persisting it would let a stale origin from an earlier
    // port survive into the next boot — trusting a loopback the app no longer
    // listens on. So writeServerConfig must strip it even when the in-memory
    // config carries one.
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-config-'));
    process.env.SILVERHAND_DIR = tmp;
    writeFileSync(
      join(tmp, SERVER_CONFIG_FILENAME),
      JSON.stringify({
        mode: 'embedded',
        url: 'http://127.0.0.1:4321',
        refresh_token: null,
        event_ws_allowed_origins: ['http://127.0.0.1:1111'],
        child_sessions: {
          max_concurrent_per_parent: null,
          spawn_cooldown_seconds: null,
          max_depth: 1,
        },
      }),
      { mode: 0o600 },
    );

    // The read path still accepts an old file that carries the field...
    const config = await loadOrCreateServerConfig();
    expect(config.event_ws_allowed_origins).toEqual(['http://127.0.0.1:1111']);

    // ...but a rewrite drops it, so the stale origin can't accumulate on disk.
    await writeServerConfig(config);
    const raw = readConfig(tmp);
    expect(raw).not.toHaveProperty('event_ws_allowed_origins');
  });

  it('derives isolated Electron userData under the silverhand root', () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-config-'));
    expect(electronUserDataPath(tmp)).toBe(
      join(tmp, 'desktop', 'electron-user-data'),
    );
  });
});

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, SERVER_CONFIG_FILENAME), 'utf8'),
  ) as Record<string, unknown>;
}

describe('silverhandDir — the ONE unified SILVERHAND_DIR contract (#task:1603)', () => {
  const original = process.env.SILVERHAND_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = original;
  });

  it('unset/empty/whitespace fall back to ~/.silverhand; a padded value is trimmed; explicit is used as-is', () => {
    delete process.env.SILVERHAND_DIR;
    expect(silverhandDir().endsWith('/.silverhand')).toBe(true);
    process.env.SILVERHAND_DIR = '';
    expect(silverhandDir().endsWith('/.silverhand')).toBe(true);
    // Unified trim contract (shiki 2026-07-24): blank after trim = unset.
    process.env.SILVERHAND_DIR = '   ';
    expect(silverhandDir().endsWith('/.silverhand')).toBe(true);
    process.env.SILVERHAND_DIR = ' /x/y ';
    expect(silverhandDir()).toBe('/x/y');
    process.env.SILVERHAND_DIR = '/x/y';
    expect(silverhandDir()).toBe('/x/y');
  });

  it('the Electron userData redirect gate takes the SAME arm as the root for unset/empty/whitespace vs explicit (Cindy P1)', () => {
    for (const variant of [undefined, '', '   '] as const) {
      if (variant === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = variant;
      expect(shouldRedirectElectronUserData(), `env=${JSON.stringify(variant)}`).toBe(false);
    }
    for (const variant of ['/x/y', ' /x/y '] as const) {
      process.env.SILVERHAND_DIR = variant;
      expect(shouldRedirectElectronUserData(), `env=${JSON.stringify(variant)}`).toBe(true);
    }
  });
});
