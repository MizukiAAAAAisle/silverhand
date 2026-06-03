import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SilverhandCliLauncher } from './spawn-prep.js';

const FALLBACK_SILVERHAND_COMMAND = 'silverhand';

export type { SilverhandCliLauncher } from './spawn-prep.js';

export function isFallbackSilverhandCliLauncher(
  launcher: SilverhandCliLauncher,
): boolean {
  return (
    launcher.command === FALLBACK_SILVERHAND_COMMAND &&
    launcher.args.length === 0 &&
    Object.keys(launcher.env ?? {}).length === 0
  );
}

export function chooseSilverhandCliLauncher(args: {
  serverLauncher: SilverhandCliLauncher | null;
  localLauncher: SilverhandCliLauncher | null;
}): SilverhandCliLauncher {
  if (!args.serverLauncher) {
    if (args.localLauncher) return args.localLauncher;
    throw new Error(
      'runtime_start: no silverhand CLI launcher supplied by server and no daemon-local launcher was resolved',
    );
  }
  if (
    args.localLauncher &&
    isFallbackSilverhandCliLauncher(args.serverLauncher)
  ) {
    return args.localLauncher;
  }
  return args.serverLauncher;
}

export function resolveLocalSilverhandCliLauncher(input: {
  entryUrl?: string;
  execPath?: string;
  exists?: (path: string) => boolean;
} = {}): SilverhandCliLauncher | null {
  const entryUrl = input.entryUrl ?? import.meta.url;
  const hostExecPath = input.execPath ?? process.execPath;
  const exists = input.exists ?? existsSync;
  const entryDir = dirname(fileURLToPath(entryUrl));
  const candidates = [
    // Release layout:
    //   Resources/silverhand-daemon/daemon.mjs
    //   Resources/silverhand-cli/cli.mjs
    resolve(entryDir, '..', 'silverhand-cli', 'cli.mjs'),
    // Dev bundle layout:
    //   packages/host/dist/daemon.js
    //   packages/cli/dist/cli.js
    resolve(entryDir, '..', '..', 'cli', 'dist', 'cli.js'),
  ];

  const entry = candidates.find(candidate => exists(candidate));
  if (!entry) return null;

  return {
    command: hostExecPath,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
