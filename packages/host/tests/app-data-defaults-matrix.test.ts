import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultDaemonIdentityPath } from '../src/daemon/identity.js';
import { defaultRuntimePidRootDir } from '../src/daemon/runtime-pidfiles.js';
import { defaultWorkspaceDataRootDir } from '../src/daemon/workspace-registry/state-dir.js';
import { defaultSilverhandStateRoot } from '../src/daemon/computer-profile.js';
import { deriveLocalOutboundFrameSocketPath } from '../src/daemon/local-outbound-frame-server.js';

/**
 * #task:1598 round 2 (Cindy P1-3) — the compatibility-floor env x home
 * matrix on the REAL host entry points, not just the pure helpers. The
 * historical host defaults never consulted SILVERHAND_DIR; this pins that
 * setting the env (unset / empty / whitespace / explicit) does NOT move
 * any of them — an env-sensitive regression here would silently relocate
 * connect profiles and fallback data roots (the exact first-version bug
 * this round exists to prevent).
 */
describe('host default paths are SILVERHAND_DIR-independent (historical contract)', () => {
  const HOME_ROOT = join(homedir(), '.silverhand');
  const original = process.env.SILVERHAND_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = original;
  });

  const ENV_VARIANTS: Array<string | undefined> = [
    undefined,
    '',
    '   ',
    '/tmp/explicit-silverhand-dir',
  ];

  it('identity / runtime-pids / workspace-data / state root / outbound socket never move with the env', () => {
    const expected = {
      identity: join(HOME_ROOT, 'daemon', 'identity.json'),
      runtimePids: join(HOME_ROOT, 'daemon', 'runtime-pids'),
      workspaceData: join(HOME_ROOT, 'workspace-data'),
      stateRoot: HOME_ROOT,
      outboundSocket: join(HOME_ROOT, 'run', 'daemon-outbound.sock'),
    };
    for (const variant of ENV_VARIANTS) {
      if (variant === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = variant;
      expect(defaultDaemonIdentityPath(), `env=${JSON.stringify(variant)}`).toBe(
        expected.identity,
      );
      expect(defaultRuntimePidRootDir(), `env=${JSON.stringify(variant)}`).toBe(
        expected.runtimePids,
      );
      expect(defaultWorkspaceDataRootDir(), `env=${JSON.stringify(variant)}`).toBe(
        expected.workspaceData,
      );
      expect(defaultSilverhandStateRoot(), `env=${JSON.stringify(variant)}`).toBe(
        expected.stateRoot,
      );
      expect(
        deriveLocalOutboundFrameSocketPath(),
        `env=${JSON.stringify(variant)}`,
      ).toBe(expected.outboundSocket);
    }
  });

  it('the identity default ignores the env even when set (no sibling derivation left)', () => {
    // #task:1598 round 4 — the historical `dirname(runtimePidRootDir)`
    // sibling derivation was removed; embedders pass the identity
    // coordinate explicitly and the bare fallback is fixed to the
    // env-independent home root.
    process.env.SILVERHAND_DIR = '/tmp/explicit-silverhand-dir';
    expect(defaultDaemonIdentityPath()).toBe(
      join(HOME_ROOT, 'daemon', 'identity.json'),
    );
  });
});
