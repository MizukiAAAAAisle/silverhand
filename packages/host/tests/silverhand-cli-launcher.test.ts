import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  chooseSilverhandCliLauncher,
  isFallbackSilverhandCliLauncher,
  resolveLocalSilverhandCliLauncher,
} from '../src/daemon/silverhand-cli-launcher.js';

describe('daemon silverhand CLI launcher', () => {
  it('detects only the backend fallback launcher', () => {
    expect(
      isFallbackSilverhandCliLauncher({ command: 'silverhand', args: [] }),
    ).toBe(true);
    expect(
      isFallbackSilverhandCliLauncher({
        command: 'silverhand',
        args: ['--help'],
      }),
    ).toBe(false);
    expect(
      isFallbackSilverhandCliLauncher({
        command: 'node',
        args: ['cli.js'],
      }),
    ).toBe(false);
  });

  it('uses the daemon-local launcher only for backend fallback input', () => {
    const local = {
      command: '/Electron',
      args: ['/Resources/silverhand-cli/cli.mjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };

    expect(
      chooseSilverhandCliLauncher({
        serverLauncher: { command: 'silverhand', args: [] },
        localLauncher: local,
      }),
    ).toBe(local);

    expect(
      chooseSilverhandCliLauncher({
        serverLauncher: null,
        localLauncher: local,
      }),
    ).toBe(local);

    const explicit = { command: '/explicit-node', args: ['/explicit-cli.js'] };
    expect(
      chooseSilverhandCliLauncher({
        serverLauncher: explicit,
        localLauncher: local,
      }),
    ).toBe(explicit);
  });

  it('fails loudly when neither server nor daemon can supply a launcher', () => {
    expect(() =>
      chooseSilverhandCliLauncher({
        serverLauncher: null,
        localLauncher: null,
      }),
    ).toThrow(/no silverhand CLI launcher/);
  });

  it('resolves the release app sibling CLI bundle', () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-cli-release-'));
    try {
      const daemonDir = join(root, 'Resources', 'silverhand-daemon');
      const cliDir = join(root, 'Resources', 'silverhand-cli');
      mkdirSync(daemonDir, { recursive: true });
      mkdirSync(cliDir, { recursive: true });
      const daemonEntry = join(daemonDir, 'daemon.mjs');
      const cliEntry = join(cliDir, 'cli.mjs');
      writeFileSync(daemonEntry, '');
      writeFileSync(cliEntry, '');

      expect(
        resolveLocalSilverhandCliLauncher({
          entryUrl: pathToFileURL(daemonEntry).href,
          execPath: '/Electron',
        }),
      ).toEqual({
        command: '/Electron',
        args: [cliEntry],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the repo dev bundle sibling CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-cli-dev-'));
    try {
      const daemonDir = join(root, 'packages', 'host', 'dist');
      const cliDir = join(root, 'packages', 'cli', 'dist');
      mkdirSync(daemonDir, { recursive: true });
      mkdirSync(cliDir, { recursive: true });
      const daemonEntry = join(daemonDir, 'daemon.js');
      const cliEntry = join(cliDir, 'cli.js');
      writeFileSync(daemonEntry, '');
      writeFileSync(cliEntry, '');

      expect(
        resolveLocalSilverhandCliLauncher({
          entryUrl: pathToFileURL(daemonEntry).href,
          execPath: '/node',
        }),
      ).toEqual({
        command: '/node',
        args: [cliEntry],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
