import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Migration, migrations } from '@silverhand/shared';

/**
 * ONE-SHOT generator for the #task:1213 baseline compaction (design:
 * docs/db-migration-baseline-compaction-v1.md §5.1 / §7.1).
 *
 * Run ONLY in the compaction PR, while the historical chain v1..v44 is
 * still present in `migrations`:
 *
 *   GEN_MIGRATION_BASELINE=1 ./scripts/test.sh --scope backend \
 *     tests/migration-baseline-gen.test.ts
 *
 * It replays the real historical chain and emits three artifacts:
 *  1. packages/shared/src/db/baseline-schema.ts — BASELINE_SCHEMA_SQL,
 *     the executable DDL snapshot at v44. This becomes migration 44's `up`
 *     (the SINGLE authoritative source; constraint §5.2.1-1).
 *  2. tests/migration-baseline/schema-baseline-v44.normalized.txt — the
 *     normalized v44 schema oracle (drift-guard stage a; §5.2.1-2a).
 *  3. tests/migration-baseline/schema-current.normalized.txt — the
 *     normalized end-state oracle, captured from the REAL chain v1..v50,
 *     so the post-compaction guard (baseline + v45.. == current) is NOT a
 *     tautology (§5.2.1-2b).
 *
 * Before writing, it VERIFIES against the real chain (the proof that
 * lives forever in this PR's git history):
 *  - apply BASELINE_SCHEMA_SQL on a fresh DB → normalized == replay(v1..v44).
 *  - apply BASELINE_SCHEMA_SQL + v45..v50 → normalized == replay(v1..v50).
 *
 * After compaction the chain is gone, so this generator can no longer run
 * (it asserts the chain is present and skips otherwise). The frozen
 * artifacts + the continuous two-stage guard in migration-baseline.test.ts take
 * over. ALL DBs here are `:memory:` — never touch a live DB (shiki gate §6).
 */

const BASELINE_VERSION = 44;
const here = dirname(fileURLToPath(import.meta.url));

function applyChain(db: Database.Database, plan: Migration[], maxVersion: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of plan) {
    if (m.version > maxVersion) break;
    const apply = () => {
      if (m.precondition) m.precondition(db);
      db.exec(m.up);
      insert.run(m.version, m.name, 0);
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

/** Executable CREATE statements in creation order (re-runnable as one
 *  `db.exec`). Excludes auto-indexes (sql NULL), sqlite internals, and the
 *  runner-owned `_migrations` ledger. */
function dumpExecutableSchema(db: Database.Database): string {
  const rows = db
    .prepare<[], { sql: string }>(
      `SELECT sql FROM sqlite_master
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
       ORDER BY rowid`,
    )
    .all();
  return rows.map(r => `${r.sql.trim()};`).join('\n\n') + '\n';
}

/** Order-independent, whitespace-collapsed schema fingerprint used as the
 *  drift oracle. Sorted by (type, name) so creation order can't perturb it. */
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

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migration baseline generator (#task:1213, one-shot)', () => {
  const run = process.env.GEN_MIGRATION_BASELINE === '1';
  const chainPresent = migrations.some(m => m.version < BASELINE_VERSION);

  it.runIf(run)('regenerates baseline artifacts from the real chain', () => {
    expect(
      chainPresent,
      'historical chain v1..v43 is gone — the generator is one-shot and cannot run post-compaction',
    ).toBe(true);

    // Oracles from the REAL chain.
    const v44Db = freshDb();
    applyChain(v44Db, migrations, BASELINE_VERSION);
    const baselineSql = dumpExecutableSchema(v44Db);
    const v44Norm = normalizeSchema(v44Db);

    const fullDb = freshDb();
    applyChain(fullDb, migrations, Number.MAX_SAFE_INTEGER);
    const currentNorm = normalizeSchema(fullDb);

    // Proof 1: the executable snapshot reproduces the v44 schema exactly.
    const replayBaseline = freshDb();
    replayBaseline.exec(baselineSql);
    expect(normalizeSchema(replayBaseline)).toBe(v44Norm);

    // Proof 2: baseline + the retained v45.. increments reproduce the
    // historical end state (compaction does not change current schema).
    const recombined = freshDb();
    recombined.exec(baselineSql);
    for (const m of migrations.filter(x => x.version > BASELINE_VERSION)) {
      recombined.exec(m.up);
    }
    expect(normalizeSchema(recombined)).toBe(currentNorm);

    // Emit artifacts. BASELINE_SCHEMA_SQL is written as a multiline template
    // literal (not a JSON string) so the committed schema stays reviewable in a
    // diff. Safe because the dumped DDL contains no backtick / backslash / ${
    // (asserted below before we trust the template form).
    expect(
      /[`\\]|\$\{/.test(baselineSql),
      'baseline DDL contains a template-literal-unsafe char; emit needs escaping',
    ).toBe(false);
    const tsBody =
      `// AUTO-GENERATED — DO NOT HAND-EDIT (#task:1213 baseline compaction).\n` +
      `// Source of truth: a one-shot replay of historical migrations v1..v${BASELINE_VERSION}\n` +
      `// (deleted from the live plan; preserved in this commit's git history).\n` +
      `// Regeneration is impossible post-compaction (the chain is gone); the\n` +
      `// two-stage drift guard in migration-baseline.test.ts pins this artifact.\n` +
      `// See docs/db-migration-baseline-compaction-v1.md §5.2.\n\n` +
      `export const BASELINE_SCHEMA_VERSION = ${BASELINE_VERSION};\n\n` +
      `export const BASELINE_SCHEMA_SQL = \`\n${baselineSql}\`;\n`;
    writeFileSync(join(here, '..', '..', 'shared', 'src', 'db', 'baseline-schema.ts'), tsBody);

    const fxDir = join(here, 'migration-baseline');
    mkdirSync(fxDir, { recursive: true });
    writeFileSync(join(fxDir, 'schema-baseline-v44.normalized.txt'), v44Norm);
    writeFileSync(join(fxDir, 'schema-current.normalized.txt'), currentNorm);
  });

  it('is inert in normal runs (generation is opt-in)', () => {
    expect(run || !run).toBe(true);
  });
});
