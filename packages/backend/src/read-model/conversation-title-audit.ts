// The RUNTIME half of "display titles are unique" (#task:2016).
//
// `packages/shared/src/conversation-title-audit.ts` owns the whole definition of
// a half-state and knows no SQL. This module is the only thing between it and a
// database: it hands the audit the rows it judges, and nothing else. It writes
// nothing, ever — the report is the product.
//
// Why a read model and not a repo: it answers a question ABOUT the data rather
// than serving a domain operation, and its two callers are neither a route nor a
// service — boot (once, after migrations) and `silverhand-server admin
// scan-title-addresses` (on demand, on its own read-only connection). It is
// deliberately absent from `BackendReadModels`: that bag is composed for request
// handlers, and no handler asks this question.
//
// THE SHAPE PROBE. Every OTHER read model may assume the current schema, because
// the only way a process gets a handle is `openDatabase`, which migrates or
// refuses. This one may not: the ticket's cleanup order is "probe, rename the
// colliding channels by hand, THEN migrate", so the operator's database is
// legitimately older than the column being audited (see
// `openDatabaseUnmigratedReadOnly`). So the scan asks the catalog what it is
// looking at and picks one of three FIXED queries — never an assembled one:
//
//   keyed  (>= v72) `title_key` exists; every defect class is computable.
//   placed (v69-v71) placement axis but no key column: `keysExpected: false`,
//                    which reports folded collisions only — the class that must
//                    block the migration.
//   legacy (< v69)   neither column. v69 backfills EVERY pre-existing row to
//                    `placement_kind = 'workspace'`, so at these versions "the
//                    workspace-placed rows" is spelled "all of them", and that
//                    equality is what keeps the probe's answer the same set the
//                    v72 unique index will later cover.
//
// `keyed` names both columns, so the impossible fourth combination (a key column
// without a placement column — v72 rebuilt the table with both) surfaces as a
// plain SQLite "no such column" rather than as a silently narrower scan.
import type { Database as Db } from 'better-sqlite3';

import {
  auditConversationTitleAddresses,
  type ConversationTitleAuditReport,
  type ConversationTitleAuditRow,
} from '@silverhand/shared';

/**
 * Rows are ordered so two runs over an unchanged database produce a
 * byte-identical report: the audit emits defects in input order, and an operator
 * comparing "before my cleanup" with "after" should see only what they changed.
 */
const KEYED_QUERY = `
  SELECT id, workspace_id AS workspaceId, title, title_key AS titleKey
    FROM conversations
   WHERE placement_kind = 'workspace'
   ORDER BY workspace_id, id
`;

const PLACED_QUERY = `
  SELECT id, workspace_id AS workspaceId, title, NULL AS titleKey
    FROM conversations
   WHERE placement_kind = 'workspace'
   ORDER BY workspace_id, id
`;

const LEGACY_QUERY = `
  SELECT id, workspace_id AS workspaceId, title, NULL AS titleKey
    FROM conversations
   ORDER BY workspace_id, id
`;

/**
 * Judge every title-bearing conversation in the database. Read-only.
 *
 * A plain function, not a port object: both callers hold a `Db` and want one
 * answer, and a factory returning `{ scan }` would only exist so that a bag could
 * hold it — which is exactly what the header says this is not.
 */
export function scanConversationTitleAddresses(
  db: Db,
): ConversationTitleAuditReport {
  const keysExpected = hasConversationsColumn(db, 'title_key');
  const query = keysExpected
    ? KEYED_QUERY
    : hasConversationsColumn(db, 'placement_kind')
      ? PLACED_QUERY
      : LEGACY_QUERY;
  const rows = db.prepare<[], ConversationTitleAuditRow>(query).all();
  return auditConversationTitleAddresses(rows, { keysExpected });
}

function hasConversationsColumn(db: Db, column: string): boolean {
  return (
    db
      .prepare<
        [string],
        { name: string }
      >(`SELECT name FROM pragma_table_info('conversations') WHERE name = ?`)
      .get(column) !== undefined
  );
}

/**
 * Why boot refused to compose a server.
 *
 * A named error rather than a bare `Error`, because the two callers of the scan
 * want opposite things from a defect: the admin command PRINTS it and exits, and
 * boot must FAIL CLOSED. The distinction is not stylistic. `stale_key` means a
 * conversation shows one name and answers to another, so a resolver on a database
 * in that state routes a message by the name the sender did not type; a
 * `folded_collision` means two channels answer to one address. Serving those is
 * worse than not starting: the failure is silent, it is a MISDELIVERY, and the
 * operator learns about it from a `warn` line nobody read.
 *
 * The report travels with the error so the caller need not re-scan to report it,
 * and `silverhand-server admin scan-title-addresses` stays read-only and
 * non-throwing — diagnosis has to remain possible on a database that cannot boot.
 */
export class ConversationTitleAddressDefectError extends Error {
  readonly code = 'conversation_title_address_defects';

  constructor(readonly report: ConversationTitleAuditReport) {
    super(
      `refusing to start: ${report.defects.length} conversation title address `
        + `defect(s) in ${report.scanned} workspace conversation(s). A channel `
        + `that shows one name and answers to another misroutes messages. Run `
        + `\`silverhand-server admin scan-title-addresses\` for the full report, `
        + `repair the titles, then restart.`,
    );
    this.name = 'ConversationTitleAddressDefectError';
  }
}
