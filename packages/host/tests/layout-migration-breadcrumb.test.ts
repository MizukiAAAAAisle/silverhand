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
 *   7. `take` CONSUMES: the breadcrumb is gone when it returns, and a failure
 *      recorded after the claim survives for the next start (at-most-once
 *      reporting, no pending state). A claim file left by a start that crashed
 *      mid-delivery is swept — its bytes are neither read nor sent, and it does
 *      not keep a failure payload on disk across starts. A sweep that could not
 *      be performed is logged as a failure, never as "swept".
 *   8. The daemon code table covers every typed daemon migration error
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
import { basename, join } from 'node:path';
import {
  parseLayoutMigrationDiagnosticsReport,
  type LayoutMigrationFailureFact,
} from '@silverhand/shared';
import { resolveDiagnosticsPaths } from '@silverhand/shared/app-data-layout';
import {
  readLayoutMigrationFailures,
  recordLayoutMigrationFailure,
  takeLayoutMigrationFailures,
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

describe('takeLayoutMigrationFailures', () => {
  it('returns the report and the breadcrumb is gone afterwards', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    expect(takeLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [{ ...DESKTOP_FACT, count: 1 }],
    });
    // Consumed: the sample's lifetime on disk ended here, not when a server
    // answered — so nothing can be sent twice and nothing is left pending.
    expect(readLayoutMigrationFailures({ appRoot })).toBeNull();
    expect(readdirSync(resolveDiagnosticsPaths(appRoot).root)).toEqual([]);
  });

  it('returns null when there is nothing pending, and never throws', () => {
    expect(takeLayoutMigrationFailures({ appRoot })).toBeNull();
    expect(() =>
      takeLayoutMigrationFailures({ appRoot: join(appRoot, 'nope') }),
    ).not.toThrow();
    expect(takeLayoutMigrationFailures({ appRoot: join(appRoot, 'nope') })).toBeNull();
  });

  it('lets a failure recorded after the claim survive for the next start', () => {
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    expect(takeLayoutMigrationFailures({ appRoot })?.reports).toHaveLength(1);
    recordLayoutMigrationFailure({ appRoot, fact: DAEMON_FACT });
    expect(takeLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [{ ...DAEMON_FACT, count: 1 }],
    });
  });

  it('sweeps a claim file left by an earlier start without sending its bytes', () => {
    const logger = collectingLogger();
    const paths = resolveDiagnosticsPaths(appRoot);
    mkdirSync(paths.root, { recursive: true });
    const secret = '/Users/someone/private/notes.txt';
    // A crash between claim and delivery leaves exactly this, with no main file.
    writeFileSync(
      `${paths.layoutMigrationFailures}.claim.424242`,
      JSON.stringify({ reports: [{ ...DESKTOP_FACT, count: 1, oops: secret }] }),
    );

    expect(takeLayoutMigrationFailures({ appRoot, logger })).toBeNull();
    // The stale sample is DROPPED, not resurrected — and it does not linger.
    expect(readdirSync(paths.root)).toEqual([]);
    expect(JSON.stringify(logger.warnings)).not.toContain(secret);
    expect(logger.warnings.map(w => w.fields.action)).toEqual([
      'layout_v2_migration_breadcrumb_claim_swept',
    ]);
  });

  it('sweeps a stale claim and still consumes the current breadcrumb', () => {
    const paths = resolveDiagnosticsPaths(appRoot);
    recordLayoutMigrationFailure({ appRoot, fact: DESKTOP_FACT });
    writeFileSync(`${paths.layoutMigrationFailures}.claim.424242`, '{"reports":[]}');

    expect(takeLayoutMigrationFailures({ appRoot })).toEqual({
      reports: [{ ...DESKTOP_FACT, count: 1 }],
    });
    expect(readdirSync(paths.root)).toEqual([]);
  });

  it('reports a sweep it could not perform as a failure, not as swept', () => {
    const logger = collectingLogger();
    const paths = resolveDiagnosticsPaths(appRoot);
    mkdirSync(paths.root, { recursive: true });
    const claimName = `${basename(paths.layoutMigrationFailures)}.claim.424242`;
    writeFileSync(join(paths.root, claimName), '{"reports":[]}');
    // A read-only diagnostics dir: the unlink fails with EACCES, so the claim is
    // still on disk when the call returns — the log must not claim otherwise.
    chmodSync(paths.root, 0o500);
    try {
      expect(takeLayoutMigrationFailures({ appRoot, logger })).toBeNull();
      expect(readdirSync(paths.root)).toEqual([claimName]);
    } finally {
      chmodSync(paths.root, 0o700);
    }
    expect(logger.warnings.map(w => w.fields.action)).toEqual([
      'layout_v2_migration_breadcrumb_claim_sweep_failed',
    ]);
  });

  it('discards an unparseable file without surfacing its bytes', () => {
    const logger = collectingLogger();
    const path = resolveDiagnosticsPaths(appRoot).layoutMigrationFailures;
    mkdirSync(resolveDiagnosticsPaths(appRoot).root, { recursive: true });
    const secret = '/Users/someone/private/notes.txt';
    writeFileSync(path, JSON.stringify({ reports: [{ oops: secret }] }));

    expect(takeLayoutMigrationFailures({ appRoot, logger })).toBeNull();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.fields.action).toBe(
      'layout_v2_migration_breadcrumb_invalid',
    );
    expect(JSON.stringify(logger.warnings[0])).not.toContain(secret);
    // Neither the original nor the claim copy is left behind.
    expect(readdirSync(resolveDiagnosticsPaths(appRoot).root)).toEqual([]);
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
