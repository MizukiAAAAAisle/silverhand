import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiPaths } from '@silverhand/shared';
import {
  buildHostClaimInput,
  daemonHostConfigPath,
  installationIdPath,
  isTokenBearingHostClaimPath,
  loadOrCreateInstallationId,
  readDaemonHostConfig,
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

  it('marks the token-bearing claim route as not renderer-proxyable', () => {
    expect(isTokenBearingHostClaimPath(apiPaths.hostClaimOrCreate)).toBe(true);
    expect(isTokenBearingHostClaimPath(apiPaths.hosts)).toBe(false);
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
