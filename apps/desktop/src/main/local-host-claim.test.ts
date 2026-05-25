import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiPaths } from '@silverhand/shared';
import {
  applyRevokeSideEffects,
  applyRotateSideEffects,
  buildHostClaimInput,
  daemonHostConfigPath,
  installationIdPath,
  isMainManagedHostPath,
  isTokenBearingHostClaimPath,
  loadOrCreateInstallationId,
  pathnameOf,
  readDaemonHostConfig,
  removeDaemonHostConfig,
  writeDaemonHostConfig,
} from './local-host-claim.js';

describe('desktop local host claim helpers', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it('creates and reuses an owner-only installation_id', () => {
    const dir = tempDir();

    const first = loadOrCreateInstallationId(dir);
    const second = loadOrCreateInstallationId(dir);

    expect(second).toBe(first);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(readFileSync(installationIdPath(dir), 'utf8')).toBe(`${first}\n`);
    expect(fileMode(installationIdPath(dir))).toBe(0o600);
  });

  it('writes daemon host config with the exact token-bearing shape and 0600 mode', () => {
    const dir = tempDir();
    const config = {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'host-token-cleartext',
    };

    writeDaemonHostConfig(dir, config);

    expect(readDaemonHostConfig(dir)).toEqual(config);
    expect(JSON.parse(readFileSync(daemonHostConfigPath(dir), 'utf8'))).toEqual(config);
    expect(fileMode(daemonHostConfigPath(dir))).toBe(0o600);
  });

  it('removes daemon host config idempotently', () => {
    const dir = tempDir();
    const config = {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'host-token-cleartext',
    };
    writeDaemonHostConfig(dir, config);

    removeDaemonHostConfig(dir);
    removeDaemonHostConfig(dir);

    expect(existsSync(daemonHostConfigPath(dir))).toBe(false);
    expect(readDaemonHostConfig(dir)).toBeNull();
  });

  it('includes current_host_id only when reusable daemon config exists', () => {
    expect(
      buildHostClaimInput({
        installationId: '55555555-5555-4555-8555-555555555555',
        existingConfig: null,
        label: 'Dev Mac',
      }),
    ).toEqual({
      installation_id: '55555555-5555-4555-8555-555555555555',
      label: 'Dev Mac',
    });

    expect(
      buildHostClaimInput({
        installationId: '55555555-5555-4555-8555-555555555555',
        existingConfig: {
          server_url: 'http://127.0.0.1:4321',
          host_id: 'host-local',
          host_token: 'host-token-cleartext',
        },
      }),
    ).toMatchObject({
      installation_id: '55555555-5555-4555-8555-555555555555',
      current_host_id: 'host-local',
    });
  });

  it('marks every main-managed host route as not renderer-proxyable', () => {
    // Stage B.4: claim + rotate + revoke all bypass the generic
    // backend proxy. Old `isTokenBearingHostClaimPath` is kept as a
    // deprecated alias.
    expect(isMainManagedHostPath(apiPaths.hostClaimOrCreate)).toBe(true);
    expect(isMainManagedHostPath(apiPaths.hostRotateToken('host-x'))).toBe(true);
    expect(isMainManagedHostPath(apiPaths.hostRevoke('host-x'))).toBe(true);
    expect(isMainManagedHostPath(apiPaths.hosts)).toBe(false);
    // Deprecated alias still exposes the same matcher (covers the
    // claim path; we rely on the active name for rotate/revoke).
    expect(isTokenBearingHostClaimPath(apiPaths.hostClaimOrCreate)).toBe(true);
    expect(isTokenBearingHostClaimPath(apiPaths.hosts)).toBe(false);
  });

  it('refuses query/hash bypass attempts on rotate-token / revoke', () => {
    // P0 regression: a naive `endsWith('/rotate-token')` against the
    // raw path would let `?x=1` slip past the matcher, and the
    // renderer could then read cleartext `host_token` via the generic
    // proxy. Matching MUST normalize to the URL pathname first.
    expect(isMainManagedHostPath(`${apiPaths.hostRotateToken('h')}?x=1`)).toBe(true);
    expect(isMainManagedHostPath(`${apiPaths.hostRevoke('h')}?x=1`)).toBe(true);
    expect(isMainManagedHostPath(`${apiPaths.hostClaimOrCreate}?bypass=1`)).toBe(true);

    // `fetch` strips the fragment before sending, but the guard must
    // still refuse — defense in depth against any code path that
    // forwards the raw string further.
    expect(isMainManagedHostPath(`${apiPaths.hostRotateToken('h')}#frag`)).toBe(true);
    expect(isMainManagedHostPath(`${apiPaths.hostRevoke('h')}#frag`)).toBe(true);

    // Combined query + fragment.
    expect(
      isMainManagedHostPath(`${apiPaths.hostRotateToken('h')}?x=1#frag`),
    ).toBe(true);
    expect(
      isMainManagedHostPath(`${apiPaths.hostRevoke('h')}?x=1#frag`),
    ).toBe(true);

    // GET /api/hosts (no token, no side-effect) is still proxyable
    // even with a query string — the `useQuery` cache key may add
    // params later.
    expect(isMainManagedHostPath(`${apiPaths.hosts}?cache=1`)).toBe(false);
  });

  it('pathnameOf strips query + fragment and falls back on malformed input', () => {
    expect(pathnameOf('/api/hosts')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts?x=1')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts#frag')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts/h/rotate-token?x=1#frag')).toBe(
      '/api/hosts/h/rotate-token',
    );
    // Malformed inputs fall through verbatim — the caller's own
    // allow-list (e.g. `assertApiProxyPath`'s `/api/` startsWith)
    // still rejects them.
    expect(pathnameOf('not-a-path-at-all')).toBe('/not-a-path-at-all');
  });

  it('rotate side-effect persists the new token to daemon-config 0o600', () => {
    const dir = tempDir();
    // Pre-existing config with the old token.
    writeDaemonHostConfig(dir, {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'old-token',
    });

    applyRotateSideEffects({
      silverhandDir: dir,
      serverUrl: 'http://127.0.0.1:4321',
      hostId: 'host-local',
      hostToken: 'new-token-cleartext',
    });

    expect(readDaemonHostConfig(dir)).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'new-token-cleartext',
    });
    expect(fileMode(daemonHostConfigPath(dir))).toBe(0o600);
  });

  it('revoke side-effect clears daemon-config when revoked host is the current local one', () => {
    const dir = tempDir();
    writeDaemonHostConfig(dir, {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });

    expect(
      applyRevokeSideEffects({ silverhandDir: dir, hostId: 'host-local' }),
    ).toBe('cleared');
    expect(readDaemonHostConfig(dir)).toBeNull();
  });

  it('revoke side-effect leaves daemon-config alone for non-current owned hosts', () => {
    const dir = tempDir();
    writeDaemonHostConfig(dir, {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });

    expect(
      applyRevokeSideEffects({ silverhandDir: dir, hostId: 'some-other-host' }),
    ).toBe('unchanged');
    expect(readDaemonHostConfig(dir)).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });
  });

  it('revoke side-effect is a no-op when no daemon-config exists', () => {
    const dir = tempDir();
    expect(
      applyRevokeSideEffects({ silverhandDir: dir, hostId: 'whatever' }),
    ).toBe('unchanged');
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-desktop-host-claim-'));
    cleanup.push(dir);
    return dir;
  }
});

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}
