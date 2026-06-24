import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  type Migration,
  migrations,
} from '@silverhand/shared';

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
 */

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, 'migration-baseline');
const V44_ORACLE = join(FX, 'schema-baseline-v44.normalized.txt');
const CURRENT_ORACLE = join(FX, 'schema-current.normalized.txt');

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Faithful replay of a migration list (escape/precondition aware), matching
 *  runMigrations semantics, without writing the `_migrations` ledger. */
function applyPlan(db: Database.Database, plan: Migration[]): void {
  for (const m of plan) {
    const apply = () => {
      if (m.precondition) m.precondition(db);
      db.exec(m.up);
    };
    if (m.foreignKeyEscape) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
    } else {
      db.transaction(apply)();
    }
  }
}

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
    const db = freshDb();
    applyPlan(db, [migrations[0]!]);
    expect(normalizeSchema(db)).toBe(readFileSync(V44_ORACLE, 'utf8'));
  });

  it('(b) applying baseline + retained increments reproduces current schema', () => {
    const db = freshDb();
    applyPlan(db, migrations);
    const got = normalizeSchema(db);
    if (process.env.UPDATE_SCHEMA_SNAPSHOT === '1') {
      writeFileSync(CURRENT_ORACLE, got);
    }
    expect(got).toBe(readFileSync(CURRENT_ORACLE, 'utf8'));
    expect(CURRENT_SCHEMA_VERSION).toBe(migrations[migrations.length - 1]!.version);
  });
});
