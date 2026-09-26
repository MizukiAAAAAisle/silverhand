import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectRuntimeCatalog, platformBinaryCandidates } from '../src/runtimes.js';

const roots: string[] = [];

function makeBin(name: string, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'silverhand-runtime-'));
  roots.push(root);
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, name);
  writeFileSync(path, body, 'utf-8');
  chmodSync(path, 0o755);
  return binDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime detection', () => {
  it('uses unconditional candidate dirs when login-shell PATH discovery fails', async () => {
    const binDir = makeBin(
      'claude',
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 1.2.3"; fi\n',
    );

    const result = await detectRuntimeCatalog({
      force: true,
      detectKinds: ['claude'],
      pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin',
      shellPath: '/definitely/missing/shell',
      pathHelperPath: '/definitely/missing/path_helper',
      extraCandidateDirs: [binDir],
    });

    expect(result.runtimes).toEqual([
      {
        kind: 'claude',
        state: 'present',
        reason: 'resolved',
        installed: true,
        binary: join(binDir, 'claude'),
        version: '1.2.3',
      },
    ]);
  });

  it('returns explicit absent entries for every probed runtime', async () => {
    const result = await detectRuntimeCatalog({
      force: true,
      detectKinds: ['claude', 'codex'],
      pathEnv: '',
      platform: 'linux',
      shellPath: null,
      pathHelperPath: null,
      extraCandidateDirs: [],
      includeDefaultCandidateDirs: false,
    });

    expect(result.runtimes.map((r) => r.kind)).toEqual(['claude', 'codex']);
    expect(result.runtimes.every((r) => r.state === 'absent')).toBe(true);
  });

  it('treats version probe failure as present_unverified, not absent', async () => {
    const binDir = makeBin('qodercli', '#!/bin/sh\nexit 1\n');

    const result = await detectRuntimeCatalog({
      force: true,
      detectKinds: ['qoder'],
      pathEnv: '',
      shellPath: null,
      pathHelperPath: null,
      extraCandidateDirs: [binDir],
    });

    expect(result.runtimes).toEqual([
      {
        kind: 'qoder',
        state: 'present_unverified',
        reason: 'version_unavailable',
        installed: true,
        binary: join(binDir, 'qodercli'),
        version: null,
      },
    ]);
  });
});

describe('platformBinaryCandidates', () => {
  // The array order IS the resolution priority (resolveBinary probes
  // candidates in order before PATH). Pin the exact macOS codex order so a
  // reorder — which would silently change which bundle wins — fails loudly.
  it('resolves the macOS codex bundle order: ChatGPT.app before Codex.app', () => {
    expect(platformBinaryCandidates('codex', 'darwin')).toEqual([
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    ]);
  });

  it('has no hard-preferred bundle candidates off macOS (PATH wrapper only)', () => {
    expect(platformBinaryCandidates('codex', 'linux')).toEqual([]);
  });
});
