/**
 * #task:1664 — the layout-v2 migration diagnostics contract.
 *
 * Pins, in the order they matter:
 *   1. The payload has NO string-shaped hole: an arbitrary `err.code` collapses
 *      to the `'unknown'` enum member, never a passthrough.
 *   2. Aggregation key = the whole identity except `count`; the version is part
 *      of it (merging versions would destroy attribution).
 *   3. `count` saturates instead of growing, and a new key at the entry cap is
 *      dropped rather than evicting an existing one.
 *   4. The parse is bounded and total: missing / oversized / non-JSON / unknown
 *      key / wrong shape all land in a tagged result, never a throw.
 *   5. Round trip: what the writer serializes, the reader classifies `valid`.
 */
import { describe, expect, it } from 'vitest';
import {
  LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
  LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT,
  LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES,
  aggregateLayoutMigrationFailure,
  daemonLayoutMigrationCode,
  desktopLayoutMigrationCode,
  layoutMigrationFailureKey,
  parseLayoutMigrationDiagnosticsReport,
  serializeLayoutMigrationDiagnosticsReport,
  type LayoutMigrationFailure,
  type LayoutMigrationFailureFact,
} from '../src/layout-migration-diagnostics.js';

const DESKTOP_FACT: LayoutMigrationFailureFact = {
  component: 'desktop',
  app_version: '0.2.0',
  stage: 'engine',
  code: 'layout_conflict',
  layout_version: 2,
};

const DAEMON_FACT: LayoutMigrationFailureFact = {
  component: 'daemon',
  daemon_version: '0.2.0',
  stage: 'workspace_data_convergence',
  code: 'flatten_conflict',
  layout_version: 2,
};

describe('code mapping', () => {
  it('passes through a known code and collapses everything else to unknown', () => {
    expect(desktopLayoutMigrationCode('layout_marker_corrupt')).toBe(
      'layout_marker_corrupt',
    );
    expect(daemonLayoutMigrationCode('flatten_move_failed')).toBe(
      'flatten_move_failed',
    );
    // The real leak vector: an arbitrary throw carrying a string `code`.
    expect(desktopLayoutMigrationCode('EPERM')).toBe('unknown');
    expect(desktopLayoutMigrationCode('/Users/someone/.silverhand/agents')).toBe(
      'unknown',
    );
    expect(daemonLayoutMigrationCode(undefined)).toBe('unknown');
    expect(daemonLayoutMigrationCode({ code: 'flatten_conflict' })).toBe('unknown');
    // Cross-component codes are NOT interchangeable: each arm has its own table.
    expect(daemonLayoutMigrationCode('layout_marker_corrupt')).toBe('unknown');
    expect(desktopLayoutMigrationCode('flatten_conflict')).toBe('unknown');
  });

  it('carries the store-root config code in BOTH tables under one name (#task:1815)', () => {
    // One condition (a non-absolute config-dir override), one user repair, so
    // the code must not depend on which process refused the launch.
    expect(daemonLayoutMigrationCode('session_store_root_unverifiable')).toBe(
      'session_store_root_unverifiable',
    );
    expect(desktopLayoutMigrationCode('session_store_root_unverifiable')).toBe(
      'session_store_root_unverifiable',
    );
  });
});

describe('aggregation', () => {
  it('increments the same key and keeps distinct keys apart', () => {
    let entries = aggregateLayoutMigrationFailure([], DESKTOP_FACT);
    entries = aggregateLayoutMigrationFailure(entries, DESKTOP_FACT);
    expect(entries).toEqual([{ ...DESKTOP_FACT, count: 2 }]);

    entries = aggregateLayoutMigrationFailure(entries, DAEMON_FACT);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ ...DAEMON_FACT, count: 1 });
  });

  it('treats a version change as a different key', () => {
    const first = aggregateLayoutMigrationFailure([], DESKTOP_FACT);
    const next = aggregateLayoutMigrationFailure(first, {
      ...DESKTOP_FACT,
      app_version: '0.3.0',
    });
    expect(next).toHaveLength(2);
    expect(next.map(e => e.count)).toEqual([1, 1]);
    expect(layoutMigrationFailureKey(DESKTOP_FACT)).not.toBe(
      layoutMigrationFailureKey({ ...DESKTOP_FACT, app_version: '0.3.0' }),
    );
  });

  it('saturates the count instead of growing past the ceiling', () => {
    const saturated: LayoutMigrationFailure[] = [
      { ...DESKTOP_FACT, count: LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT },
    ];
    const next = aggregateLayoutMigrationFailure(saturated, DESKTOP_FACT);
    expect(next[0]!.count).toBe(LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT);
  });

  it('drops a NEW key at the entry cap and never evicts an existing one', () => {
    let entries: LayoutMigrationFailure[] = [];
    for (let i = 0; i < LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES; i += 1) {
      entries = aggregateLayoutMigrationFailure(entries, {
        ...DESKTOP_FACT,
        app_version: `0.${i}.0`,
      });
    }
    expect(entries).toHaveLength(LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES);
    const overflowed = aggregateLayoutMigrationFailure(entries, {
      ...DESKTOP_FACT,
      app_version: '9.9.9',
    });
    expect(overflowed).toEqual(entries);
    // An EXISTING key still aggregates at the cap.
    const bumped = aggregateLayoutMigrationFailure(entries, {
      ...DESKTOP_FACT,
      app_version: '0.0.0',
    });
    expect(bumped).toHaveLength(LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES);
    expect(bumped[0]!.count).toBe(2);
  });

  it('does not mutate its input', () => {
    const entries = aggregateLayoutMigrationFailure([], DESKTOP_FACT);
    const snapshot = structuredClone(entries);
    aggregateLayoutMigrationFailure(entries, DESKTOP_FACT);
    expect(entries).toEqual(snapshot);
  });
});

describe('parse', () => {
  it('round-trips a serialized report', () => {
    const report = {
      reports: aggregateLayoutMigrationFailure(
        aggregateLayoutMigrationFailure([], DESKTOP_FACT),
        DAEMON_FACT,
      ),
    };
    const parsed = parseLayoutMigrationDiagnosticsReport(
      serializeLayoutMigrationDiagnosticsReport(report),
    );
    expect(parsed.status).toBe('valid');
    if (parsed.status === 'valid') expect(parsed.value).toEqual(report);
  });

  it('reports absence as missing, not invalid', () => {
    expect(parseLayoutMigrationDiagnosticsReport(undefined).status).toBe('missing');
    expect(parseLayoutMigrationDiagnosticsReport('').status).toBe('missing');
    expect(parseLayoutMigrationDiagnosticsReport('   \n').status).toBe('missing');
  });

  it('rejects non-JSON, an empty report, and an unknown key', () => {
    expect(parseLayoutMigrationDiagnosticsReport('{').status).toBe('invalid');
    expect(parseLayoutMigrationDiagnosticsReport('{"reports":[]}').status).toBe(
      'invalid',
    );
    expect(
      parseLayoutMigrationDiagnosticsReport(
        JSON.stringify({ reports: [{ ...DESKTOP_FACT, count: 1 }], note: 'hi' }),
      ).status,
    ).toBe('invalid');
    // An extra key INSIDE an entry is the one that would smuggle free text.
    expect(
      parseLayoutMigrationDiagnosticsReport(
        JSON.stringify({
          reports: [{ ...DESKTOP_FACT, count: 1, message: 'EACCES: /Users/me' }],
        }),
      ).status,
    ).toBe('invalid');
  });

  it('rejects a cross-arm field, a bad version, and an out-of-range count', () => {
    const cases = [
      { ...DESKTOP_FACT, daemon_version: '0.2.0', count: 1 },
      { ...DESKTOP_FACT, app_version: 'nightly', count: 1 },
      { ...DESKTOP_FACT, count: 0 },
      { ...DESKTOP_FACT, count: LAYOUT_MIGRATION_DIAGNOSTICS_MAX_COUNT + 1 },
      { ...DESKTOP_FACT, layout_version: 1, count: 1 },
      { ...DAEMON_FACT, stage: 'engine', count: 1 },
      { component: 'renderer', count: 1 },
    ];
    for (const entry of cases) {
      expect(
        parseLayoutMigrationDiagnosticsReport(JSON.stringify({ reports: [entry] })),
      ).toEqual({ status: 'invalid' });
    }
  });

  it('rejects an oversized body before parsing it', () => {
    const padded = `{"reports":[],"pad":"${'a'.repeat(
      LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
    )}"}`;
    expect(parseLayoutMigrationDiagnosticsReport(padded).status).toBe('invalid');
  });

  it('keeps a full-capacity report inside the byte cap', () => {
    let entries: LayoutMigrationFailure[] = [];
    for (let i = 0; i < LAYOUT_MIGRATION_DIAGNOSTICS_MAX_ENTRIES; i += 1) {
      entries = aggregateLayoutMigrationFailure(entries, {
        ...DESKTOP_FACT,
        app_version: `123456.${i}.999999-canary.20260727`,
      });
    }
    const serialized = serializeLayoutMigrationDiagnosticsReport({
      reports: entries,
    });
    expect(new TextEncoder().encode(serialized).length).toBeLessThan(
      LAYOUT_MIGRATION_DIAGNOSTICS_MAX_BYTES,
    );
    expect(parseLayoutMigrationDiagnosticsReport(serialized).status).toBe('valid');
  });
});
