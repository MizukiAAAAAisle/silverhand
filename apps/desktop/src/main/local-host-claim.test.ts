import { afterEach, describe, expect, it } from 'vitest';
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
import {
  HOST_DISPLAY_LABEL_MAX_LENGTH,
  HostClaimOrCreateInputSchema,
  apiPaths,
} from '@silverhand/shared';
import {
  applyRevokeSideEffects,
  applyRotateSideEffects,
  assertApiProxyPath,
  buildHostClaimInput,
  defaultClaimLabel,
  isMainManagedHostPath,
  isTokenBearingHostClaimPath,
  loadOrCreateInstallationId,
  pathnameOf,
  readDaemonHostConfig,
  removeDaemonHostConfig,
  writeDaemonHostConfig,
} from './local-host-claim.js';

const installationIdPath = (dir: string) => join(dir, 'installation_id');
const daemonHostConfigPath = (dir: string) => join(dir, 'daemon-config.json');

describe('desktop local host claim helpers', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it('creates and reuses an owner-only installation_id', () => {
    const dir = tempDir();

    const first = loadOrCreateInstallationId(installationIdPath(dir));
    const second = loadOrCreateInstallationId(installationIdPath(dir));

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

    writeDaemonHostConfig(daemonHostConfigPath(dir), config);

    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toEqual(config);
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
    writeDaemonHostConfig(daemonHostConfigPath(dir), config);

    removeDaemonHostConfig(daemonHostConfigPath(dir));
    removeDaemonHostConfig(daemonHostConfigPath(dir));

    expect(existsSync(daemonHostConfigPath(dir))).toBe(false);
    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toBeNull();
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

  it('fits a system hostname to the claim label bound', () => {
    const long = `${'h'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH + 40)}.corp.example.com`;
    expect(defaultClaimLabel(long)).toBe(
      'h'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH),
    );
    // Whatever it returns must satisfy the schema the claim input parses
    // against — that is the property that actually protects claiming.
    expect(
      HostClaimOrCreateInputSchema.safeParse({
        installation_id: '66666666-6666-4666-8666-666666666666',
        label: defaultClaimLabel(long),
      }).success,
    ).toBe(true);

    // A short name passes through untouched; padding is trimmed.
    expect(defaultClaimLabel('  Studio Mac  ')).toBe('Studio Mac');
    // Cutting at the bound can land mid-whitespace — don't send that.
    expect(
      defaultClaimLabel(`${'a'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH - 1)} tail`),
    ).toBe('a'.repeat(HOST_DISPLAY_LABEL_MAX_LENGTH - 1));
    // Nothing usable → null, so the caller omits `label` rather than
    // sending an empty string the schema's `min(1)` would refuse.
    expect(defaultClaimLabel('   ')).toBeNull();
    expect(defaultClaimLabel('')).toBeNull();
  });

  it('marks every main-managed host route as not renderer-proxyable', () => {
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

  it('pathnameOf strips query + fragment and resolves relative paths against a fake base', () => {
    expect(pathnameOf('/api/hosts')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts?x=1')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts#frag')).toBe('/api/hosts');
    expect(pathnameOf('/api/hosts/h/rotate-token?x=1#frag')).toBe(
      '/api/hosts/h/rotate-token',
    );
    // Bare strings get resolved as relative paths against the
    // synthetic base, NOT rejected — the helper is intentionally
    // lossy. The caller's own raw allow-list (e.g.
    // `assertApiProxyPath`'s `/api/` startsWith on the *raw* input)
    // is what rejects non-API strings, not pathnameOf.
    expect(pathnameOf('not-a-path-at-all')).toBe('/not-a-path-at-all');
  });

  it('assertApiProxyPath rejects absolute / protocol-relative URLs even when their pathname looks like /api/', () => {
    expect(() => assertApiProxyPath('http://evil.example/api/workspaces')).toThrow(
      /only accepts \/api\/\*/,
    );
    expect(() => assertApiProxyPath('https://evil.example/api/hosts')).toThrow(
      /only accepts \/api\/\*/,
    );
    expect(() => assertApiProxyPath('//evil.example/api/workspaces')).toThrow(
      /only accepts \/api\/\*/,
    );
    expect(() => assertApiProxyPath('not-a-path')).toThrow(
      /only accepts \/api\/\*/,
    );
    // Empty + control inputs.
    expect(() => assertApiProxyPath('')).toThrow(/only accepts \/api\/\*/);
    expect(() => assertApiProxyPath('/foo')).toThrow(/only accepts \/api\/\*/);
  });

  it('assertApiProxyPath refuses main-managed routes including query/hash bypass attempts', () => {
    // Sensitive routes — bare and with query/hash — all rejected.
    expect(() => assertApiProxyPath(apiPaths.hostClaimOrCreate)).toThrow(
      /main-managed host route/,
    );
    expect(() => assertApiProxyPath(apiPaths.hostRotateToken('h'))).toThrow(
      /main-managed host route/,
    );
    expect(() => assertApiProxyPath(apiPaths.hostRevoke('h'))).toThrow(
      /main-managed host route/,
    );
    expect(() =>
      assertApiProxyPath(`${apiPaths.hostRotateToken('h')}?x=1`),
    ).toThrow(/main-managed host route/);
    expect(() =>
      assertApiProxyPath(`${apiPaths.hostRevoke('h')}?x=1#frag`),
    ).toThrow(/main-managed host route/);

    // Non-sensitive `/api/*` routes pass cleanly.
    expect(() => assertApiProxyPath(apiPaths.hosts)).not.toThrow();
    expect(() => assertApiProxyPath(`${apiPaths.hosts}?cache=1`)).not.toThrow();
    expect(() => assertApiProxyPath('/api/workspaces')).not.toThrow();
  });

  it('rotate side-effect persists the new token to daemon-config 0o600', () => {
    const dir = tempDir();
    // Pre-existing config with the old token.
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'old-token',
    });

    applyRotateSideEffects({
      daemonConfigPath: daemonHostConfigPath(dir),
      serverUrl: 'http://127.0.0.1:4321',
      hostId: 'host-local',
      hostToken: 'new-token-cleartext',
    });

    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'new-token-cleartext',
    });
    expect(fileMode(daemonHostConfigPath(dir))).toBe(0o600);
  });

  // rotate must NOT silently drop `profile_version`. Rotate doesn't
  // change the profile generation, so the new daemon-config reflects
  // the same generation as before — otherwise the daemon's
  // `<none>` ↔ value distinction would mis-attribute fingerprint
  // changes to the rotate, not to the next legitimate profile commit.
  it('rotate preserves profile_version when the existing config carries one', () => {
    const dir = tempDir();
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'old-token',
      profile_version: 7,
    });

    applyRotateSideEffects({
      daemonConfigPath: daemonHostConfigPath(dir),
      serverUrl: 'http://127.0.0.1:4321',
      hostId: 'host-local',
      hostToken: 'new-token-cleartext',
    });

    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'new-token-cleartext',
      profile_version: 7,
    });
  });

  it('rotate preserves allow_insecure_remote when the existing config carries it', () => {
    const dir = tempDir();
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://215.192.147.162:8080',
      host_id: 'host-local',
      host_token: 'old-token',
      allow_insecure_remote: true,
    });

    applyRotateSideEffects({
      daemonConfigPath: daemonHostConfigPath(dir),
      serverUrl: 'http://215.192.147.162:8080',
      hostId: 'host-local',
      hostToken: 'new-token-cleartext',
    });

    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toEqual({
      server_url: 'http://215.192.147.162:8080',
      host_id: 'host-local',
      host_token: 'new-token-cleartext',
      allow_insecure_remote: true,
    });
  });

  it('rotate omits profile_version when the existing config has none', () => {
    const dir = tempDir();
    // Legacy D3.x config — no profile_version field.
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'old-token',
    });

    applyRotateSideEffects({
      daemonConfigPath: daemonHostConfigPath(dir),
      serverUrl: 'http://127.0.0.1:4321',
      hostId: 'host-local',
      hostToken: 'new-token-cleartext',
    });

    const after = readDaemonHostConfig(daemonHostConfigPath(dir));
    // Field is absent — NOT explicit `undefined`. The daemon
    // fingerprint encodes absent as `<none>` and explicit `0` as `0`,
    // so we must not slip a `profile_version: undefined` key into the
    // serialized JSON either.
    expect(after).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'new-token-cleartext',
    });
    expect(after && 'profile_version' in after).toBe(false);
  });

  it('revoke side-effect clears daemon-config when revoked host is the current local one', () => {
    const dir = tempDir();
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });

    expect(
      applyRevokeSideEffects({ daemonConfigPath: daemonHostConfigPath(dir), hostId: 'host-local' }),
    ).toBe('cleared');
    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toBeNull();
  });

  it('revoke side-effect leaves daemon-config alone for non-current owned hosts', () => {
    const dir = tempDir();
    writeDaemonHostConfig(daemonHostConfigPath(dir), {
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });

    expect(
      applyRevokeSideEffects({ daemonConfigPath: daemonHostConfigPath(dir), hostId: 'some-other-host' }),
    ).toBe('unchanged');
    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toEqual({
      server_url: 'http://127.0.0.1:4321',
      host_id: 'host-local',
      host_token: 'live-token',
    });
  });

  it('revoke side-effect is a no-op when no daemon-config exists', () => {
    const dir = tempDir();
    expect(
      applyRevokeSideEffects({ daemonConfigPath: daemonHostConfigPath(dir), hostId: 'whatever' }),
    ).toBe('unchanged');
  });

  // Cindy `#task:634` re-review P1 — `readDaemonHostConfig` is now
  // called on every `backend:info` IPC because Settings exposes
  // `local_host_server_url` to the renderer. A non-regular file at
  // the daemon-config path (FIFO / directory / socket) would have
  // either hung `readFileSync` indefinitely (renderer-triggered
  // hang of the desktop main process) or surfaced as a confusing
  // parse error. Stat-first / `isFile()` guard makes the desktop
  // side fail-closed with null, same fail mode as a missing file.
  //
  // Portable proxy: substitute a directory at the config path. Same
  // `!isFile()` branch as FIFO/socket without requiring `mkfifo` or
  // platform-specific tooling.
  it('readDaemonHostConfig returns null (not throw) when path is a directory', () => {
    const dir = tempDir();
    mkdirSync(daemonHostConfigPath(dir), { recursive: true });
    expect(statSync(daemonHostConfigPath(dir)).isDirectory()).toBe(true);
    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toBeNull();
  });

  it('readDaemonHostConfig returns null for missing path', () => {
    const dir = tempDir();
    expect(existsSync(daemonHostConfigPath(dir))).toBe(false);
    expect(readDaemonHostConfig(daemonHostConfigPath(dir))).toBeNull();
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
