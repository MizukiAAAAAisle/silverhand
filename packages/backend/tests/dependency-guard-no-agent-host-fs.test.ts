/**
 * D4.e-5 A1 tripwire: `packages/backend/src/**` performs ZERO agent-host
 * filesystem operations.
 *
 * Invariant I6 / acceptance A1 (design `docs/remote-backend-d4e-design.md`
 * §4, §7): the daemon is the sole authority for host-local path resolution.
 * The backend control plane must never `mkdir`/`writeFile`/`rm`/`readFile` an
 * agent L1 home, an L2 workspace memory dir, or a workspace `.silverhand/`
 * skeleton — those all go through daemon intents (`agent_materialize`,
 * `agent_l2_seed`, `agent_files_purge`, `workspace_provision`,
 * `agent_workspace_read`). The pre-D4.e seeding/purge code
 * (`workspace-files.ts`, the DELETE `fs.rm` block, `agent-workspace.ts`,
 * `agent-profile.ts`) has been removed across D4.e-2…-5.
 *
 * This guard enforces the invariant STRUCTURALLY by banning any `node:fs`
 * (or `fs` / `fs/promises`) import from `packages/backend/src` except an
 * explicit allow-list of BACKEND-LOCAL infrastructure modules — db, logs,
 * blob/attachment storage, the managed-workspaces-root bootstrap, and the
 * embedded auth bootstrap. None of those resolve or write an agent-host
 * path; they own the server's own on-disk state. Any NEW fs importer trips
 * the guard and forces review: either it is more backend-local infra (extend
 * the allow-list with justification) or it is an agent-host fs op that must
 * move to the daemon.
 *
 * SCOPE — what this guard does NOT cover (deliberately): the SECOND half of
 * A1, "no `workspace_path`-derived path emitted to the daemon or agent", is
 * still open. `runtime/runtime-start-options.ts` emits a `workspace_path`-
 * derived agent-home path into `runtime_start` options; it builds path
 * STRINGS (imports `node:path`, not `fs`) so it is invisible to an fs-import
 * guard. That residue is closed by **D4.e-6** (`runtime_start` semantic-ids
 * migration), which revokes the path carve-out and pins `runtime_start`
 * params as semantic-only. Until -6 lands, I6 is NOT fully true — A7 (M1
 * closure) must not be claimed. See `docs/d4-e-acceptance.md` A1/A7.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BACKEND_ROOT = resolve(__dirname, '..');
const BACKEND_SRC = resolve(BACKEND_ROOT, 'src');
const REPO_ROOT = resolve(BACKEND_ROOT, '..', '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * Backend-local infrastructure modules permitted to touch the filesystem.
 * Paths are POSIX-relative to `packages/backend/src`. Each owns the server's
 * OWN on-disk state, never an agent-host (L1/L2/CONSENSUS/workspace) path:
 *   - db.ts                       → SQLite file open/WAL
 *   - logger.ts                   → JSONL log files under ~/.silverhand/logs
 *   - storage/blob-file-storage.ts→ attachment/blob storage (backend-local)
 *   - runtime/activity-log-writer.ts → per-conversation activity log files
 *   - workspaces-root.ts           → ensureWorkspacesRoot (managed root dir)
 *   - index.ts                    → boot wiring (ensureWorkspacesRoot, dirs)
 *   - auth/embedded-bootstrap.ts  → embedded identity/config bootstrap
 * Extend ONLY for genuine backend-local infra, with a comment saying why.
 */
const FS_ALLOWLIST = new Set<string>([
  'db.ts',
  'logger.ts',
  'storage/blob-file-storage.ts',
  'runtime/activity-log-writer.ts',
  'workspaces-root.ts',
  'index.ts',
  'auth/embedded-bootstrap.ts',
]);

interface FoundImport {
  file: string;
  statement: string;
}

function* walkSources(root: string): Generator<string> {
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.silverhand') {
      continue;
    }
    const abs = join(root, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkSources(abs);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extOf(entry))) continue;
    yield abs;
  }
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot);
}

// Match `import ... from '<spec>'` (static, incl. multi-line named blocks and
// `import type`) and dynamic `import('<spec>')`. A bare side-effect import
// `import 'fs'` is also matched. We then test the specifier against the fs
// module set.
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);

function relKey(absPath: string): string {
  return relative(BACKEND_SRC, absPath).split('\\').join('/');
}

function checkFile(absPath: string): FoundImport[] {
  const text = readFileSync(absPath, 'utf8');
  const out: FoundImport[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec === undefined || !FS_MODULES.has(spec)) continue;
    out.push({ file: absPath, statement: m[0].replace(/\s+/g, ' ').trim() });
  }
  return out;
}

describe('backend/src → filesystem import boundary (D4.e-5 A1 / I6)', () => {
  it('no file under packages/backend/src imports node:fs outside the backend-local-infra allow-list', () => {
    const violations: FoundImport[] = [];
    for (const file of walkSources(BACKEND_SRC)) {
      if (FS_ALLOWLIST.has(relKey(file))) continue;
      violations.push(...checkFile(file));
    }
    if (violations.length > 0) {
      const lines = violations.map(
        v => `  ${relative(REPO_ROOT, v.file)}  →  ${v.statement}`,
      );
      throw new Error(
        [
          'Forbidden node:fs import in packages/backend/src (outside the',
          'backend-local-infra allow-list).',
          '',
          'I6/A1: the daemon is the sole authority for host-local path',
          'resolution. Backend code must NOT mkdir/writeFile/rm/readFile an',
          'agent L1 home, an L2 workspace memory dir, or a workspace',
          '.silverhand/ skeleton — route it through a daemon intent',
          '(agent_materialize / agent_l2_seed / agent_files_purge /',
          'workspace_provision / agent_workspace_read).',
          '',
          'If this is genuine backend-local infrastructure (db / logs / blob',
          'storage / managed-root bootstrap), add it to FS_ALLOWLIST with a',
          'comment explaining why it is not an agent-host path.',
          '',
          'Violations:',
          ...lines,
        ].join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });

  it('every allow-list entry still exists as a source file (no stale allowance)', () => {
    const stale: string[] = [];
    for (const rel of FS_ALLOWLIST) {
      try {
        statSync(resolve(BACKEND_SRC, rel));
      } catch {
        stale.push(rel);
      }
    }
    expect(stale).toEqual([]);
  });

  // The fs-import guard above cannot catch a host-path AUTHORITY that resolves
  // paths with pure string ops (no fs). `validateWorkspacePath` was exactly
  // that — a backend-side workspace_path validator (root/home/state-root
  // rules) retired in D4.e-5 (its rule now lives only on the daemon registry).
  // Pin its name out of backend/src so a future change can't quietly
  // re-introduce a server-side path authority behind the fs allow-list (Cindy
  // D4.e-5 P1).
  it('no backend/src file re-introduces the retired validateWorkspacePath authority', () => {
    const offenders: string[] = [];
    for (const file of walkSources(BACKEND_SRC)) {
      if (/\bvalidateWorkspacePath\b/.test(readFileSync(file, 'utf8'))) {
        offenders.push(relKey(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  // Self-check: the matcher must catch every realistic fs import form and
  // must NOT false-positive on look-alike specifiers.
  it('checkFile recognises fs import forms and ignores look-alikes', () => {
    const probe = (text: string): boolean => {
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1];
        if (spec !== undefined && FS_MODULES.has(spec)) return true;
      }
      return false;
    };
    // Banned forms.
    expect(probe("import { promises as fs } from 'node:fs';")).toBe(true);
    expect(probe("import { mkdir } from 'node:fs/promises';")).toBe(true);
    expect(probe("import * as fs from 'fs';")).toBe(true);
    expect(probe("import { readFile } from 'fs/promises';")).toBe(true);
    expect(probe("const fs = await import('node:fs');")).toBe(true);
    expect(probe("import 'node:fs';")).toBe(true);
    // Allowed: not an fs module.
    expect(probe("import { join } from 'node:path';")).toBe(false);
    expect(probe("import { foo } from 'fs-extra';")).toBe(false);
    expect(probe("import { Hono } from 'hono';")).toBe(false);
  });
});
