import { describe, expect, it } from 'vitest';

import {
  defaultAppRoot,
  resolveDesktopAppPaths,
} from '@silverhand/shared/app-data-layout';

// SINGLE path authority. The Desktop `resolveDesktopAppPaths` resolver is
// the ONLY interpreter of the app-data root (from `SILVERHAND_DIR`, via `defaultAppRoot`).
// The launcher passes the resolver's fine-grained backend paths (database / blobs /
// logs / bootstrap-token) to the out-of-process Rust child as explicit env; the Rust
// binary never re-derives a root of its own. This proves the transfer relation: changing
// `SILVERHAND_DIR` relocates ALL FOUR backend paths consistently under the new root.

describe('SILVERHAND_DIR → resolver backend paths (single path authority)', () => {
  const homedir = () => '/Users/x';

  it('relocates the four backend paths consistently when SILVERHAND_DIR changes', () => {
    const rootA = defaultAppRoot({ SILVERHAND_DIR: '/a' }, homedir);
    const rootB = defaultAppRoot({ SILVERHAND_DIR: '/b' }, homedir);
    expect(rootA).toBe('/a');
    expect(rootB).toBe('/b');

    const a = resolveDesktopAppPaths(rootA);
    const b = resolveDesktopAppPaths(rootB);

    // The four backend paths the launcher hands the Rust child.
    const backendPathsA = [
      a.embeddedServer.database,
      a.embeddedServer.blobs,
      a.logs,
      a.embeddedServer.bootstrap,
    ];
    const backendPathsB = [
      b.embeddedServer.database,
      b.embeddedServer.blobs,
      b.logs,
      b.embeddedServer.bootstrap,
    ];

    // Every one is under its own root, and B is A with the root swapped — the whole
    // layout relocates together (no path escapes the resolver's root).
    for (const p of backendPathsA) expect(p.startsWith('/a')).toBe(true);
    for (const p of backendPathsB) expect(p.startsWith('/b')).toBe(true);
    for (let i = 0; i < backendPathsA.length; i += 1) {
      expect(backendPathsB[i]).toBe(backendPathsA[i]!.replace(/^\/a/, '/b'));
    }
  });

  it('falls back to ~/.silverhand when SILVERHAND_DIR is unset', () => {
    expect(defaultAppRoot({}, homedir)).toBe('/Users/x/.silverhand');
  });
});
