import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';
import { resolveBackendDataPaths } from '@silverhand/shared/app-data-layout';
import type { BackendLogger } from '../../src/context.js';

const silentLogger: BackendLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeServerConfig(): ServerConfig {
  return {
    mode: 'remote',
    url: 'http://127.0.0.1:0',
    auth_token: 'd'.repeat(32),
    refresh_token: null,
    child_sessions: {
      max_concurrent_per_parent: null,
      spawn_cooldown_seconds: null,
      max_depth: 1,
    },
  };
}

/**
 * #task:1608 rev 3 — the backend workspaces-root contract is RETIRED
 * (docs/app-data-layout-v2.md §2: "the target intentionally has no
 * backend-managed workspaces root"; managed workspace paths are minted by
 * the owning daemon). Acceptance (Cindy): a fresh boot creates NO
 * `workspaces/` directory, and nothing recreates one that was removed —
 * the boot itself is the only code path that ever created it.
 */
describe('backend boot — no backend-managed workspaces root', () => {
  let running: RunningBackend | null = null;
  let tmp: string | null = null;

  afterEach(async () => {
    if (running) {
      await running.close().catch(() => undefined);
      running = null;
    }
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  it('a fresh boot leaves the data root free of workspaces/', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-no-wsroot-'));
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      logger: silentLogger,
      listen: { hostname: '127.0.0.1', port: 0 },
    });
    expect(existsSync(join(tmp, 'workspaces'))).toBe(false);

    // A removed legacy dir stays removed across a second boot.
    await running.close();
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      logger: silentLogger,
      listen: { hostname: '127.0.0.1', port: 0 },
    });
    expect(existsSync(join(tmp, 'workspaces'))).toBe(false);
  });
});
