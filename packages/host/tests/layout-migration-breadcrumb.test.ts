/**
 * #task:1664 — the local breadcrumb store.
 *
 * Pins:
 *   1. Write → read round trip through the ONE resolved coordinate
 *      (`<app-root>/diagnostics/`), which is layout-version independent, so a
 *      failure OF the migration is never stored where the migration moves bytes.
 *   2. Repeated failures aggregate on disk (count grows, file does not).
 *   3. Both components' facts coexist in one file.
 *   4. An unparseable file is DISCARDED (deleted) and reported as nothing
 *      pending — and its bytes are never handed to the logger.
 *   5. Every entry point is fail-open: an unwritable root produces a warn, not a
 *      throw, because the caller is already failing a startup.
 *   6. The file content IS the wire payload — no local-only field.
 *   7. The daemon code table covers every typed daemon migration error
 *      (compile-time; see the type assertions at the bottom).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLayoutMigrationDiagnosticsReport,
  type LayoutMigrationFailureFact,
} from '@silverhand/shared';
import { resolveDiagnosticsPaths } from '@silverhand/shared/app-data-layout';
import {
  clearLayoutMigrationFailures,
  readLayoutMigrationFailures,
  recordLayoutMigrationFailure,
} from '../src/diagnostics/layout-migration-breadcrumb.js';
import { FlattenLayoutError } from '../src/daemon/workspace-registry/flatten-layout.js';
import { SessionMigrationError } from '../src/daemon/workspace-registry/session-migration.js';
import type { DaemonLayoutMigrationCode } from '@silverhand/shared';

const DESKTOP_FACT: LayoutMigrationFailureFact = {
  component: 'desktop',
  app_version: '0.2.0',
  stage: 'engine',
  code: 'layout_conflict',
  layout_version: 2,
};

const DAEMON_FACT: LayoutMigrationFailureFact = {
  component: 'daemon',
  daemon_version: '0.2.1',
  stage: 'workspace_data_convergence',
  code: 'flatten_move_failed',
  layout_version: 2,
};

function collectingLogger(): {
  warnings: { fields: Record<string, unknown>; msg: string }[];
  warn(fields: Record<string, unknown>, msg: string): void;
} {
  const warnings: { fields: Record<string, unknown>; msg: string }[] = [];
  return {
    warnings,
    warn(fields, msg) {
      warnings.push({ fields, msg });
    },
  };
}

let appRoot: string;

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), 'sh-breadcrumb-'));
});

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

describe('recordLayoutMigrationFailure', () => {
  it('writes a report readable through the resolved coordinate', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    const path = resolveDiagnosticsPaths(appRoot).layoutMigrationFailures;
    expect(path).toBe(join(appRoot, 'diagnostics', 'layout-migration-failures.json'));

    // The on-disk bytes ARE the wire payload: parsing them with the wire parser
    // must succeed and yield exactly the fact, with no extra key.
    const parsed = parseLayoutMigrationDiagnosticsReport(readFileSync(path, 'utf8'));
    expect(parsed).toEqual({
      status: 'valid',
      value: { reports: [{ ...DESKTOP_FACT, count: 1 }] },
    });
    expect(readLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [{ ...DESKTOP_FACT, count: 1 }],
    });
  });

  it('aggregates repeated failures and keeps both components in one file', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    recordLayoutMigrationFailure({ appRoot, fact: DAEMON_FACT });
    expect(readLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [
        { ...DESKTOP_FACT, count: 2 },
        { ...DAEMON_FACT, count: 1 },
      ],
    });
  });

  it('leaves no temp file behind', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    recordLayoutMigrationFailure({ appRoot, fact: DAEMON_FACT });
    expect(readdirSync(resolveDiagnosticsPaths(appRoot).root)).toEqual([
      'layout-migration-failures.json',
    ]);
  });

  it('is fail-open when the diagnostics dir cannot be written', () => {
    const logger = collectingLogger();
    // A FILE where the diagnostics dir must go: mkdir and rename both fail.
    mkdirSync(appRoot, { recursive: true });
    writeFileSync(resolveDiagnosticsPaths(appRoot).root, 'not a dir');
    expect(() =>
      recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT, logger }),
    ).not.toThrow();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.fields.action).toBe(
      'layout_v2_migration_breadcrumb_write_failed',
    );
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });
});

describe('readLayoutMigrationFailures', () => {
  it('returns null when nothing was ever written', () => {
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
  });

  it('discards an unparseable file without surfacing its bytes', () => {
    const logger = collectingLogger();
    const path = resolveDiagnosticsPaths(appRoot).layoutMigrationFailures;
    mkdirSync(resolveDiagnosticsPaths(appRoot).root, { recursive: true });
    const secret = '/Users/someone/private/notes.txt';
    writeFileSync(path, JSON.stringify({ reports: [{ oops: secret }] }));

    expect(readLayoutMigrationFailures({ appRoot, logger })).toBeNull();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.fields.action).toBe(
      'layout_v2_migration_breadcrumb_invalid',
    );
    expect(JSON.stringify(logger.warnings[0])).not.toContain(secret);
    // Discarded, so a crash loop can't re-read the same rejected bytes forever.
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('recovers by folding the next failure into a fresh file', () => {
    const path = resolveDiagnosticsPaths(appRoot).layoutMigrationFailures;
    mkdirSync(resolveDiagnosticsPaths(appRoot).root, { recursive: true });
    writeFileSync(path, 'not json at all');
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
    recordLayoutMigrationFailure({ appRoot, fact: DAEMON_FACT });
    expect(readLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [{ ...DAEMON_FACT, count: 1 }],
    });
  });

  it('treats an unreadable file as nothing pending', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    const path = resolveDiagnosticsPaths(appRoot).layoutMigrationFailures;
    chmodSync(path, 0o000);
    try {
      expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

describe('clearLayoutMigrationFailures', () => {
  it('removes the file and is idempotent', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    clearLayoutMigrationFailures({ appRoot });
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
    expect(() => clearLayoutMigrationFailures({ appRoot })).not.toThrow();
    expect(() => clearLayoutMigrationFailures({ appRoot: join(appRoot, 'nope') })).not.toThrow();
  });
});

/**
 * Compile-time coverage: every code the daemon's typed migration errors can
 * carry must exist in the closed wire table. If a new `FlattenLayoutError` /
 * `SessionMigrationError` code is added without extending
 * `DaemonLayoutMigrationCodeSchema`, this fails to typecheck — instead of
 * silently degrading that code to `'unknown'` in production.
 */
type Assert<T extends true> = T;
export type _DaemonCodesCovered = Assert<
  FlattenLayoutError['code'] | SessionMigrationError['code'] extends DaemonLayoutMigrationCode
    ? true
    : false
>;
