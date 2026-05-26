import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_CONFIG_FILENAME } from '@silverhand/shared';
import {
  loadOrCreateServerConfig,
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
});

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(dir, SERVER_CONFIG_FILENAME), 'utf8'),
  ) as Record<string, unknown>;
}
