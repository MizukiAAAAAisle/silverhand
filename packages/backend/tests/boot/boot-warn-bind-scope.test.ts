/**
 * D4.a Commit 4 — boot-time WARN on non-loopback bind + signup enabled
 * (per `docs/remote-backend-d4-design.md` §6.3 condition 3).
 *
 * The classifier itself is unit-tested in
 * `tests/shared/bind-address-scope.test.ts`. This file pins the
 * boot-level wiring: the WARN line must fire exactly when the
 * `(bindAddressScope, signupEnabled)` combination is the one the
 * runbook calls out, and stays silent otherwise.
 *
 * `startBackend` is invoked in `standalone` mode so the test does
 * not need a HostClient. The boot still binds an HTTP listener on
 * `127.0.0.1:0`; we synthesize a non-loopback bind by overriding
 * `listen.hostname` independently — the value the WARN line
 * reads is `bindAddressScope` (derived from the configured
 * `listenHostname`), not the OS-resolved socket address.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';
import type { BackendLogger } from '../../src/context.js';

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: unknown;
  msg: string | undefined;
}

function collectLogger(): { logger: BackendLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: BackendLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
  return { logger, entries };
}

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

describe('startBackend — bind_address_scope WARN wiring', () => {
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

  it('classifies loopback bind and stays silent even with signup enabled', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-boot-warn-loopback-'));
    const { logger, entries } = collectLogger();
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: true, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      logger,
      listen: { hostname: '127.0.0.1', port: 0 },
    });
    expect(running.context.bindAddressScope).toBe('loopback');
    const warn = entries.find(
      e => e.level === 'warn' && typeof e.msg === 'string' && e.msg.includes('signup ENABLED'),
    );
    expect(warn).toBeUndefined();
  });

  it('classifies a public-scope bind and emits the runbook WARN when signup is enabled', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-boot-warn-public-'));
    const { logger, entries } = collectLogger();
    // `0.0.0.0` is conservatively classified as `'public'` (see
    // `bind-address-scope.ts` JSDoc + classifier tests). We can bind
    // a real listener on it without needing additional privileges.
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: true, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      logger,
      listen: { hostname: '0.0.0.0', port: 0 },
    });
    expect(running.context.bindAddressScope).toBe('public');
    const warn = entries.find(e => e.level === 'warn' && typeof e.msg === 'string'
      && e.msg.includes('signup ENABLED')
      && e.msg.includes('SILVERHAND_DISABLE_SIGNUP=1'));
    expect(warn).toBeDefined();
    expect(warn?.obj).toMatchObject({
      bindAddressScope: 'public',
      signupEnabled: true,
      runbookSection: expect.stringContaining('lock-down'),
    });
  });

  it('does NOT emit the WARN when signup is disabled, even on a non-loopback bind', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-boot-warn-public-disabled-'));
    const { logger, entries } = collectLogger();
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      silverhandDir: tmp,
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: false, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      logger,
      listen: { hostname: '0.0.0.0', port: 0 },
    });
    expect(running.context.bindAddressScope).toBe('public');
    const warn = entries.find(
      e => e.level === 'warn' && typeof e.msg === 'string' && e.msg.includes('signup ENABLED'),
    );
    expect(warn).toBeUndefined();
  });
});
