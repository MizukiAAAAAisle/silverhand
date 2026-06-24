import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  migrations,
} from '@silverhand/shared';
import { runMigrations } from '../src/db.js';

/**
 * Continuous drift guard for the #task:1213 baseline compaction
 * (docs/db-migration-baseline-compaction-v1.md §5.2.1-2). The baseline is a
 * DERIVED artifact (a snapshot of the deleted historical chain v1..v44); these
 * tests keep it honest WITHOUT a second hand-maintained source of truth.
 *
 * Two stages, deliberately NOT a tautology:
 *  (a) apply ONLY the baseline migration → normalized schema == the FROZEN v44
 *      oracle. Catches: baseline-schema.ts edited, or its DDL not executable.
 *      The oracle was captured once from the real chain (gen test) and never
 *      changes — the chain is gone.
 *  (b) apply the FULL current plan (baseline + v45..) → normalized schema ==
 *      the current oracle. Catches: a retained migration edited, or the
 *      compaction changing the historical end state. The current oracle is a
 *      LIVING golden — regenerate it when you add a migration:
 *        UPDATE_SCHEMA_SNAPSHOT=1 ./scripts/test.sh --scope backend \
 *          tests/migration-baseline.test.ts
 *
 * The one-time "old chain v1..v44 == baseline" proof is NOT here; it ran in the
 * compaction PR (migration-baseline-gen.test.ts) against the still-present chain
 * and is preserved in git history. All DBs are `:memory:` (shiki gate §6).
 *
 * Both stages drive the REAL migration runner (runMigrations, the production
 * path in packages/backend/src/db.ts) — not a bespoke replay — so the guard
 * exercises the exact ledger / version-skip semantics that ship: `_migrations`
 * rows written, plan filtered against applied versions, floor guard honored.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'migration-baseline');
const V44_ORACLE = join(FX, 'schema-baseline-v44.normalized.txt');
const CURRENT_ORACLE = join(FX, 'schema-current.normalized.txt');

/** Order-independent, whitespace-collapsed schema fingerprint. Must match the
 *  generator's normalizeSchema (migration-baseline-gen.test.ts) byte-for-byte. */
function normalizeSchema(db: Database.Database): string {
  const rows = db
    .prepare<[], { type: string; name: string; sql: string }>(
      `SELECT type, name, sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
       ORDER BY type, name`,
    )
    .all();
  return (
    rows
      .map(r => `${r.type} ${r.name}: ${r.sql.replace(/\s+/g, ' ').trim()}`)
      .join('\n') + '\n'
  );
}

describe('baseline compaction drift guard (#task:1213)', () => {
  it('baseline migration is at the floor version', () => {
    // The whole safety argument (§3.1) rests on these three being equal: the
    // baseline's version IS the minimum supported version.
    expect(BASELINE_SCHEMA_VERSION).toBe(44);
    expect(MIN_SUPPORTED_SCHEMA_VERSION).toBe(BASELINE_SCHEMA_VERSION);
    expect(migrations[0]?.version).toBe(BASELINE_SCHEMA_VERSION);
    expect(migrations[0]?.name).toBe('baseline');
  });

  it('(a) applying only the baseline reproduces the frozen v44 schema', () => {
    const db = new Database(':memory:');
    try {
      // Run JUST the baseline through the real runner on a fresh DB (isEmpty
      // bypass → applies; writes the _migrations row at 44).
      const result = runMigrations(db, {
        migrations: [migrations[0]!],
        expectedVersion: BASELINE_SCHEMA_VERSION,
        minimumSupportedVersion: BASELINE_SCHEMA_VERSION,
      });
      expect(result.appliedVersions).toEqual([BASELINE_SCHEMA_VERSION]);
      expect(normalizeSchema(db)).toBe(readFileSync(V44_ORACLE, 'utf8'));
    } finally {
      db.close();
    }
  });

  it('(b) applying baseline + retained increments reproduces current schema', () => {
    const db = new Database(':memory:');
    try {
      // The default plan (baseline + v45..) through the real runner.
      const result = runMigrations(db, {
        expectedVersion: CURRENT_SCHEMA_VERSION,
        minimumSupportedVersion: MIN_SUPPORTED_SCHEMA_VERSION,
      });
      expect(result.appliedVersions).toEqual(migrations.map(m => m.version));
      const got = normalizeSchema(db);
      if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') {
        writeFileSync(CURRENT_ORACLE, got);
      }
      expect(got).toBe(readFileSync(CURRENT_ORACLE, 'utf8'));
      expect(CURRENT_SCHEMA_VERSION).toBe(migrations[migrations.length - 1]!.version);
    } finally {
      db.close();
    }
  });
});
