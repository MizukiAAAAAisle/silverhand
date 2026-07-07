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
  if (args.localLauncher) return args.localLauncher;
  if (args.serverLauncher) return args.serverLauncher;
  throw new Error(
    'runtime_start: no silverhand CLI launcher supplied by server and no daemon-local launcher was resolved',
  );
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
  const candidates: Array<{ entry: string; env?: Record<string, string> }> = [
    // NPM package layout:
    //   node_modules/@silverhand-ai/daemon/dist/daemon.js
    //   node_modules/@silverhand-ai/daemon/dist/cli.js
    { entry: resolve(entryDir, 'cli.js') },
    // Release layout:
    //   Resources/silverhand-daemon/daemon.mjs
    //   Resources/silverhand-cli/cli.mjs
    {
      entry: resolve(entryDir, '..', 'silverhand-cli', 'cli.mjs'),
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  ];

  const candidate = candidates.find(item => exists(item.entry));
  if (!candidate) return null;

  return {
    command: hostExecPath,
    args: [candidate.entry],
    ...(candidate.env ? { env: candidate.env } : {}),
  };
}
