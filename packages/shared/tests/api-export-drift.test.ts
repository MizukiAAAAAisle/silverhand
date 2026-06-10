import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as api from '../src/api/index.js';
import goldenSnapshot from './api-barrel-export-snapshot.json' with { type: 'json' };

/**
 * Export-drift guard for the #task:963 DTO/context split. `api/dto.ts` was
 * a 2398-line monolith; it is now ~14 per-context modules re-exported through
 * `api/index.ts` → `@silverhand/shared`. The one real risk of a re-export
 * split is *stranding a symbol*: a schema defined in a new module but never
 * re-added to the barrel, or a name typo'd on the way out.
 *
 * Two guards, per spec §5:
 *  1. Runtime-key snapshot — the sorted list of enumerable barrel exports
 *     (every `*Schema`, enum, const, fn) must equal a golden list captured
 *     independently from the pre-split source. Pure `type` aliases are erased
 *     at runtime and cannot be enumerated; they are covered transitively
 *     because every DTO type is paired with a same-module `*Schema` value
 *     (re-export one, re-export both) and any dropped *type* fails `tsc` in a
 *     consuming package, which CI already runs.
 *  2. Source-import guard — no file may import the deleted `api/dto` path,
 *     so the per-context barrel can never be bypassed by a resurrected
 *     deep-import.
 */
describe('api barrel export drift (#task:963)', () => {
  it('re-exports exactly the same runtime value set as before the split', () => {
    const liveKeys = Object.keys(api)
      .filter(k => typeof (api as Record<string, unknown>)[k] !== 'undefined')
      .sort();
    // Object.keys on a namespace also surfaces re-export *values* only;
    // pure `type` exports are not present. Compare against the golden set.
    expect(liveKeys).toEqual([...goldenSnapshot].sort());
  });
});

describe('no file imports the deleted api/dto path (#task:963)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const BAD = /from\s+['"][^'"]*\bapi\/dto(?:\.(?:js|ts))?['"]/;

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) yield full;
    }
  }

  it('finds zero residual ./api/dto deep-imports under packages/** and apps/**', () => {
    const offenders: string[] = [];
    for (const base of ['packages', 'apps']) {
      const root = join(repoRoot, base);
      for (const file of walk(root)) {
        // Skip this guard test itself (it names the path in a regex/comment).
        if (file.endsWith('api-export-drift.test.ts')) continue;
        if (BAD.test(readFileSync(file, 'utf8'))) offenders.push(relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
