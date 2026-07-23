/**
 * D4.c C1 Cindy round-1 P2 — direct pin that `startBackend({ mode:
 * 'standalone' })` now wires the real `RuntimeHostPlacementResolver`
 * into `context.placement`, NOT `DisabledRuntimeHostPlacement`.
 *
 * Pre-D4.c the standalone branch returned `host_runtime_disabled`
 * (409) from every placement method because the original Stage B/C
 * sketch treated standalone as "no host placement at all". D4.c C1
 * inverts that: standalone has a real hosts table populated by
 * remote daemons attaching over outbound WSS, so placement is the
 * same authoritative DB lookup either way.
 *
 * Why a separate boot-level test (not just a unit on the resolver):
 * the unit tests in `tests/runtime/host-placement.test.ts` construct
 * the resolver directly, so they cannot catch a regression where
 * `src/index.ts` accidentally re-wires `DisabledRuntimeHostPlacement`
 * for standalone. This file boots the real backend in standalone
 * mode and asserts behavior through `running.context.placement`.
 */
import {
  resolveBackendDataPaths,
} from '@silverhand/shared/app-data-layout';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerConfig } from '@silverhand/shared';
import { startBackend, type RunningBackend } from '../../src/index.js';
import { HostRepo } from '../../src/repos/host-repo.js';

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

describe('startBackend(standalone).context.placement — D4.c C1 wiring', () => {
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

  it('returns 0 / 1 / N typed placement responses, NOT host_runtime_disabled', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-d4c-c1-placement-'));
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: true, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      listen: { hostname: '127.0.0.1', port: 0 },
    });

    const { placement, db } = running.context;
    const hosts = new HostRepo(db);

    // Insert a real user row so subsequent host.user_id FK references
    // resolve. The migration-time `users` table is empty in production,
    // so this test mints one inline.
    const userId = 'wired-test-user';
    const otherId = 'wired-other-user';
    const now = Date.now();
    const insertUser = db.prepare(
      `INSERT INTO users (id, name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertUser.run(userId, 'wired-test', 'Wired Test', now, now);
    insertUser.run(otherId, 'wired-other', 'Other Wired Test', now, now);

    // 0 hosts → must be `local_host_unbound` (NOT
    // `host_runtime_disabled`, which is the pre-D4.c signal that the
    // standalone bootstrap forgot to switch to the real resolver).
    expect(() => placement.resolveOwnedLocalForUser(userId)).toThrowError(
      expect.objectContaining({ code: 'local_host_unbound' }),
    );

    // 1 host → resolves.
    const one = hosts.create('host-1', 'local', {
      userId,
      installationId: 'install-1',
    });
    expect(placement.resolveOwnedLocalForUser(userId).id).toBe(one.id);

    // ≥2 hosts → `local_host_ambiguous` (NEW D4.c C1 typed code).
    hosts.create('host-2', 'local', {
      userId,
      installationId: 'install-2',
    });
    expect(() => placement.resolveOwnedLocalForUser(userId)).toThrowError(
      expect.objectContaining({ code: 'local_host_ambiguous' }),
    );

    // Cross-tenant pin at the bootstrap level: other user's hosts
    // must not contribute to userId's count (would otherwise be a
    // multi-tenant disaster surface). Add one for the other user
    // then revoke userId's host-2; userId should be back to 1 → resolves.
    hosts.create('other-host', 'local', {
      userId: otherId,
      installationId: 'install-other',
    });
    const allUser = hosts.listForUser(userId);
    const second = allUser.find(h => h.id !== one.id)!;
    hosts.revoke(second.id, Date.now());
    expect(placement.resolveOwnedLocalForUser(userId).id).toBe(one.id);
  });

  it('placement.listOwnedActiveLocalForUser exposes 0 / 1 / N visibility without leaking other tenants', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'silverhand-d4c-c1-placement-list-'));
    running = await startBackend({
      mode: 'standalone',
      dbPath: join(tmp, 'silverhand.db'),
      ...resolveBackendDataPaths(tmp),
      serverConfig: makeServerConfig(),
      authConfig: { signupEnabled: true, sessionTtlMs: 1_000 * 60 * 60 * 24 },
      listen: { hostname: '127.0.0.1', port: 0 },
    });

    const { placement, db } = running.context;
    const hosts = new HostRepo(db);

    const userId = 'list-test-user';
    const otherId = 'list-other-user';
    const now = Date.now();
    const insertUser = db.prepare(
      `INSERT INTO users (id, name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertUser.run(userId, 'list-test', 'List Test', now, now);
    insertUser.run(otherId, 'list-other', 'Other List Test', now, now);

    expect(placement.listOwnedActiveLocalForUser(userId)).toEqual([]);

    const a = hosts.create('list-a', 'local', {
      userId,
      installationId: 'install-list-a',
    });
    expect(
      placement.listOwnedActiveLocalForUser(userId).map(h => h.id),
    ).toEqual([a.id]);

    const b = hosts.create('list-b', 'local', {
      userId,
      installationId: 'install-list-b',
    });
    const ids = placement
      .listOwnedActiveLocalForUser(userId)
      .map(h => h.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));

    // Other user's host must not surface in this user's list — the
    // cross-tenant negative pin at the bootstrap level.
    hosts.create('list-other', 'local', {
      userId: otherId,
      installationId: 'install-list-other',
    });
    const stillOurs = placement
      .listOwnedActiveLocalForUser(userId)
      .map(h => h.id);
    expect(stillOurs).toHaveLength(2);
    expect(new Set(stillOurs)).toEqual(new Set([a.id, b.id]));
  });
});
