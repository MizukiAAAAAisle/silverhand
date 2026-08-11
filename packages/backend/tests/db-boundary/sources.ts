/** Shared source-set definitions for the db-boundary gates. */
import { join } from 'node:path';
import { walkTsSources, type SourceEntry } from './scan.js';

export const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** Every package's production sources — the better-sqlite3 import gate walks all of them. */
export function allProductionSources(): SourceEntry[] {
  const roots = [
    'packages/backend/src',
    'packages/server/src',
    'packages/shared/src',
    'packages/host/src',
    'packages/cli/src',
    // silverhand-daemon is a dist-only publishing shell; its sources are host/cli.
    'apps/desktop/src',
  ];
  return roots.flatMap(r => walkTsSources(join(REPO_ROOT, r), REPO_ROOT, { includeTests: false }));
}

/** Where SQL legitimately lives: backend, server, and the shared schema modules. */
export function sqlScopeSources(all: SourceEntry[]): SourceEntry[] {
  return all.filter(
    e =>
      e.path.startsWith('packages/backend/src') ||
      e.path.startsWith('packages/server/src') ||
      e.path.startsWith('packages/shared/src/db/'),
  );
}

export function allTestSources(): SourceEntry[] {
  const roots = ['packages/backend/tests', 'packages/server/tests'];
  return roots.flatMap(r => walkTsSources(join(REPO_ROOT, r), REPO_ROOT, { includeTests: true }));
}

/** Render findings as copy-pasteable inventory lines for gate failure output. */
export function asInventoryLines<T extends object>(entries: readonly T[]): string {
  return entries
    .map(
      e =>
        '  {' +
        Object.entries(e)
          .map(([k, v]) => `${k}: ${JSON.stringify(v).replace(/"/g, "'")}`)
          .join(', ') +
        '},',
    )
    .join('\n');
}
