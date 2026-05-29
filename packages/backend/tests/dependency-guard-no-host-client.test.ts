/**
 * D5.a-3 A1 tripwire: `packages/backend/src/**` MUST NOT import the
 * `HostClient` symbol from `@silverhand/host`.
 *
 * Why this is the acceptance point (Cindy D5.a-3 gate, msg
 * `Ixbm39eKMSQpZ-LW`): the R4 drift D5.a closes is the embedded backend
 * speaking a *different* runtime/materialize protocol (the local daemon
 * RPC `HostClient`) than standalone (the outbound WS envelope). The fix
 * routes both modes through the SAME `OutboundFrameAdapter` +
 * `OutboundRuntimeEventFanout`. Backend code therefore has no business
 * importing `HostClient` at all — it is a transport detail owned by the
 * desktop main process (host-control IPC) and the standalone server's
 * own wiring, not the backend request/runtime path.
 *
 * Scope is `src/` only. The acceptance point is "backend src carries
 * zero HostClient imports", NOT "no test fixture may ever name the
 * symbol" — tests are free to construct stubs typed against historical
 * shapes. (Today no backend test imports it either, but we deliberately
 * do not over-constrain the test tree.)
 *
 * The rule matches `HostClient` as a standalone identifier in the import
 * clause of any statement whose module specifier is `@silverhand/host`
 * (barrel) or a deep `@silverhand/host/...` path. `\bHostClient\b` does
 * NOT match longer identifiers like `HostClientOptions` /
 * `HostClientError` — those are distinct exports and not the banned
 * transport class.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BACKEND_ROOT = resolve(__dirname, '..');
const BACKEND_SRC = resolve(BACKEND_ROOT, 'src');
const REPO_ROOT = resolve(BACKEND_ROOT, '..', '..');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

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

// Match whole import statements (handles multi-line named-binding blocks)
// terminated by the module specifier. Covers `import ... from '...'` and
// `import type ... from '...'`. Dynamic `import('...')` cannot carry a
// named binding, so it can never pull in `HostClient` by name.
const IMPORT_STATEMENT_RE = /import\b[^;]*?from\s*['"]([^'"]+)['"]/gs;
const HOST_CLIENT_RE = /\bHostClient\b/;

function isHostModule(spec: string): boolean {
  return spec === '@silverhand/host' || spec.startsWith('@silverhand/host/');
}

function checkFile(absPath: string): FoundImport[] {
  const text = readFileSync(absPath, 'utf8');
  const out: FoundImport[] = [];
  for (const m of text.matchAll(IMPORT_STATEMENT_RE)) {
    const statement = m[0];
    const spec = m[1];
    if (spec === undefined || !isHostModule(spec)) continue;
    // Only inspect the import clause (everything before `from`), so a
    // module path that happened to contain the substring can't trip it.
    const clause = statement.slice(0, statement.lastIndexOf('from'));
    if (HOST_CLIENT_RE.test(clause)) {
      out.push({ file: absPath, statement: statement.replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

describe('backend/src → HostClient import boundary (D5.a-3 A1)', () => {
  it('no file under packages/backend/src imports HostClient from @silverhand/host', () => {
    const violations: FoundImport[] = [];
    for (const file of walkSources(BACKEND_SRC)) {
      violations.push(...checkFile(file));
    }
    if (violations.length > 0) {
      const lines = violations.map(
        v => `  ${relative(REPO_ROOT, v.file)}  →  ${v.statement}`,
      );
      throw new Error(
        [
          'Forbidden HostClient import detected in packages/backend/src.',
          '',
          'D5.a unified embedded + standalone runtime/materialize traffic on',
          'the OutboundFrameAdapter + OutboundRuntimeEventFanout. The local',
          'daemon RPC client (HostClient) is a transport detail owned by the',
          'desktop main process (host-control IPC) and the standalone wiring,',
          'NOT the backend runtime path. Route the call through',
          'ctx.outboundFrameAdapter() / ctx.runtimeHost instead.',
          '',
          'Violations:',
          ...lines,
        ].join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });

  // Self-check: the matcher must catch every realistic import form and
  // must NOT false-positive on neighbouring symbols / other modules.
  it('checkFile recognises banned forms and ignores look-alikes', () => {
    const tmp = resolve(BACKEND_SRC, '__guard_probe__.ts');
    const probe = (text: string): boolean => {
      // Exercise the same regex pipeline checkFile uses, in-memory.
      for (const m of text.matchAll(IMPORT_STATEMENT_RE)) {
        const spec = m[1];
        if (spec === undefined || !isHostModule(spec)) continue;
        const clause = m[0].slice(0, m[0].lastIndexOf('from'));
        if (HOST_CLIENT_RE.test(clause)) return true;
      }
      return false;
    };
    void tmp;
    // Banned: value + type imports, single-line and multi-line, barrel
    // and deep path.
    expect(probe("import { HostClient } from '@silverhand/host';")).toBe(true);
    expect(probe("import type { HostClient } from '@silverhand/host';")).toBe(true);
    expect(
      probe(
        "import {\n  EventFrame,\n  HostClient,\n} from '@silverhand/host';",
      ),
    ).toBe(true);
    expect(
      probe("import { HostClient } from '@silverhand/host/dist/index.js';"),
    ).toBe(true);
    // Allowed: longer identifiers are distinct exports, not the class.
    expect(probe("import type { HostClientOptions } from '@silverhand/host';")).toBe(false);
    // Allowed: other symbols from the same module.
    expect(
      probe("import { deriveLocalOutboundFrameSocketPath } from '@silverhand/host';"),
    ).toBe(false);
    // Allowed: HostClient named from a *different* module (not ours).
    expect(probe("import { HostClient } from 'some-other-pkg';")).toBe(false);
  });
});
