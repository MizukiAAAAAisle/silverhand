import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultDaemonIdentityPath } from '../src/daemon/identity.js';
import { defaultRuntimePidRootDir } from '../src/daemon/runtime-pidfiles.js';
import { defaultSilverhandStateRoot } from '../src/daemon/computer-profile.js';
import { deriveLocalOutboundFrameSocketPath } from '../src/daemon/local-outbound-frame-server.js';

/**
 * #task:1603 — the v2 env × home matrix on the REAL host entry points,
 * not just the pure helpers. Since the v2 cutover every default root
 * consults the ONE unified `SILVERHAND_DIR` contract (trim; blank after
 * trim = unset; anything else = the root). The audit that permits the
 * flip: no released artifact ever
 * shipped the env-independent bare-daemon/connect defaults (users only
 * ever received the desktop/remote app, which passes every coordinate
 * explicitly), so there is no population whose data would appear to move.
 * An explicit `--data-root` always outranks these defaults.
 */
describe('host default paths follow SILVERHAND_DIR (v2 contract §8)', () => {
  const HOME_ROOT = join(homedir(), '.silverhand');
  const ENV_ROOT = '/tmp/explicit-silverhand-dir';
  const original = process.env.SILVERHAND_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.SILVERHAND_DIR;
    else process.env.SILVERHAND_DIR = original;
  });

  const expectedFor = (root: string) => ({
    identity: join(root, 'daemon', 'identity.json'),
    runtimePids: join(root, 'daemon', 'runtime-pids'),
    stateRoot: root,
    outboundSocket: join(root, 'run', 'daemon-outbound.sock'),
  });

  const readAll = () => ({
    identity: defaultDaemonIdentityPath(),
    runtimePids: defaultRuntimePidRootDir(),
    stateRoot: defaultSilverhandStateRoot(),
    outboundSocket: deriveLocalOutboundFrameSocketPath(),
  });

  it('identity / runtime-pids / state root / outbound socket all move with an explicit env root', () => {
    process.env.SILVERHAND_DIR = ENV_ROOT;
    expect(readAll()).toEqual(expectedFor(ENV_ROOT));
  });

  it('unset, empty, and whitespace env all fall back to the home root (blank after trim = unset)', () => {
    for (const variant of [undefined, '', '   '] as const) {
      if (variant === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = variant;
      expect(readAll(), `env=${JSON.stringify(variant)}`).toEqual(expectedFor(HOME_ROOT));
    }
  });

  it('a padded value is trimmed to the root (one contract for every entry point)', () => {
    process.env.SILVERHAND_DIR = '  /tmp/explicit-silverhand-dir  ';
    expect(readAll()).toEqual(expectedFor(ENV_ROOT));
  });
});
