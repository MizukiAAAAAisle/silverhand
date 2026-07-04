// CLI runner for the legacy isolated-thread fossil purge (#task:1303 phase 1).
//
//   node <dist>/maintenance/legacy-thread-purge-cli.js [--db <path>] [--apply]
//
// Prefer the standalone wrapper — `./scripts/legacy-thread-purge.sh [--db ...]
// [--apply]` — which handles the better-sqlite3 ABI swap + compile for you.
//
// Default is a read-only DRY RUN: the DB is opened `readonly` (a physical
// no-write guarantee, not just a logic-level one) and prints inventory + guard.
// `--apply` opens read-write, takes a `VACUUM INTO` backup first, then executes
// the purge inside one `BEGIN IMMEDIATE` transaction with post-proof (see
// legacy-thread-purge.ts).
//
// The binding ABI must match the node running this (use the Node-ABI binding —
// the wrapper swaps it; or run after `scripts/test.sh` has swapped it).
//
// Note: this file stays free of `node:fs` on purpose — the backend
// `dependency-guard-no-agent-host-fs` tripwire bans fs imports in
// `packages/backend/src`. Existence is enforced via better-sqlite3's
// `fileMustExist`, not an `existsSync` pre-check.
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runLegacyThreadPurge } from './legacy-thread-purge.js';

function parseArgs(argv: string[]): { dbPath: string; apply: boolean } {
  const apply = argv.includes('--apply');
  const dbIdx = argv.indexOf('--db');
  const dbPath =
    dbIdx >= 0 && argv[dbIdx + 1]
      ? argv[dbIdx + 1]!
      : join(homedir(), '.silverhand', 'silverhand.db');
  return { dbPath, apply };
}

function main(): void {
  const { dbPath, apply } = parseArgs(process.argv.slice(2));

  // Dry-run opens READ-ONLY: a physical guarantee the process cannot write,
  // independent of the logic-level dry-run path. Temp tables (used by the purge
  // to materialize its id sets) are verified to work on a readonly connection.
  // `fileMustExist` fails loud when the DB is missing (no `node:fs` pre-check).
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_CANTOPEN') {
      console.error(`[error] DB not found (or unreadable): ${dbPath}`);
    } else {
      console.error(`[error] cannot open DB: ${err instanceof Error ? err.message : err}`);
    }
    process.exitCode = 1;
    return;
  }
  db.pragma('foreign_keys = ON');
  // Short timeout: if the live app holds the write lock, BEGIN IMMEDIATE should
  // fail fast (SQLITE_BUSY) rather than block — fail-loud, no partial run.
  db.pragma('busy_timeout = 2000');

  try {
    if (apply) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = `${dbPath}.pre-legacy-thread-purge.${stamp}.bak`;
      console.error(`[backup] VACUUM INTO ${backup}`);
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    }

    const report = runLegacyThreadPurge(db, { apply });
    console.log(JSON.stringify(report, null, 2));

    if (!apply) {
      console.error('\n[dry-run] no changes written. Re-run with --apply to execute.');
    } else {
      console.error('\n[applied] purge committed; post-proof passed.');
    }
  } catch (err) {
    console.error('\n[abort] purge did not complete:', err instanceof Error ? err.message : err);
    if (err instanceof Error && 'detail' in err) {
      console.error(JSON.stringify((err as { detail: unknown }).detail, null, 2));
    }
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
