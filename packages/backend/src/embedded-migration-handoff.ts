// #task:2343 — the embedded launcher's DB migration handoff.
//
// The out-of-process Rust backend VERIFIES the schema ledger but does NOT migrate; the
// TypeScript `@silverhand/backend` remains the canonical migration + backup + FK/integrity
// authority. Before the Desktop launcher spawns the Rust child, it runs this handoff:
// open the database (which runs the canonical migrations + pre-migration backup + FK
// escapes), run the SAME post-migration address-integrity audits `startBackend` runs, and
// then FULLY CLOSE the handle — so the Rust child is the SOLE opener of the SQLite file
// (no dual-open) and only ever sees an already-migrated, integrity-clean schema.
//
// This reuses the ONE authority (`openDatabase` + the two audit scanners + their typed
// errors) rather than re-implementing the sequence launcher-side.

import { openDatabase } from './db.js';
import type { MigrationRunResult } from './db.js';
import {
  ConversationTitleAddressDefectError,
  scanConversationTitleAddresses,
} from './read-model/conversation-title-audit.js';
import {
  WorkspaceNameAddressDefectError,
  scanWorkspaceNameAddresses,
} from './read-model/workspace-name-audit.js';

export interface EmbeddedMigrationHandoffOptions {
  /** Whether a behind-schema database may be upgraded. Mirrors `startBackend`'s
   * `schemaUpgrade.allow`; for embedded this is the launcher's migrate setting. */
  allowSchemaUpgrade: boolean;
  /** Observe the migration run result (for logging the applied epoch/steps/backup). */
  onMigrationResult?: (result: MigrationRunResult) => void;
}

/**
 * Run the canonical migration + backup + FK/integrity audits against `dbPath`, then close
 * the handle. Throws the SAME typed errors `startBackend` throws on a defect
 * (`DatabaseMigrationError`, `ConversationTitleAddressDefectError`,
 * `WorkspaceNameAddressDefectError`) so the launcher fails loud identically. On success
 * the DB is migrated, audited clean, and CLOSED — ready for the Rust child to open.
 */
export function migrateAndCloseForEmbeddedHandoff(
  dbPath: string,
  opts: EmbeddedMigrationHandoffOptions,
): void {
  // openDatabase runs runMigrations (+ pre-migration backup + per-migration
  // foreign_key_check + ledger-prefix guard + schema_too_old/new guards) internally.
  const db = openDatabase(dbPath, {
    allowSchemaUpgrade: opts.allowSchemaUpgrade,
    onMigrationResult: opts.onMigrationResult,
  });
  try {
    // The SAME post-migration address-integrity audits startBackend runs, in the same
    // order, fail-closed. A defect means a stored address does not match what a person
    // reads; refusing (closed handle + typed throw) is the strictly safer failure and
    // lets the admin scan/repair against an unlocked file.
    const titleAudit = scanConversationTitleAddresses(db);
    if (titleAudit.defects.length > 0) {
      throw new ConversationTitleAddressDefectError(titleAudit);
    }
    const workspaceAudit = scanWorkspaceNameAddresses(db);
    if (workspaceAudit.defects.length > 0) {
      throw new WorkspaceNameAddressDefectError(workspaceAudit);
    }
  } finally {
    // This function owns the only handle throughout migration/audits; transfer to Rust
    // happens only after it is closed, including when an integrity audit throws.
    db.close();
  }
}
