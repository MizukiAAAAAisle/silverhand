import type { Database as Db } from 'better-sqlite3';
import {
  auditWorkspaceNameAddresses,
  type WorkspaceNameAuditReport,
  type WorkspaceNameAuditRow,
} from '@silverhand/shared';

const KEYED_QUERY = `
  SELECT id, workspace_kind AS kind, name, name_key AS nameKey
    FROM workspaces
   ORDER BY CASE workspace_kind WHEN 'regular' THEN 0 ELSE 1 END, id
`;

const LEGACY_QUERY = `
  SELECT id, workspace_kind AS kind, name, NULL AS nameKey
    FROM workspaces
   ORDER BY CASE workspace_kind WHEN 'regular' THEN 0 ELSE 1 END, id
`;

export function scanWorkspaceNameAddresses(db: Db): WorkspaceNameAuditReport {
  const keysExpected = hasColumn(db, 'name_key');
  const rows = db
    .prepare<[], WorkspaceNameAuditRow>(keysExpected ? KEYED_QUERY : LEGACY_QUERY)
    .all();
  return auditWorkspaceNameAddresses(rows, { keysExpected });
}

function hasColumn(db: Db, column: string): boolean {
  return db
    .prepare<[string], { name: string }>(
      `SELECT name FROM pragma_table_info('workspaces') WHERE name = ?`,
    )
    .get(column) !== undefined;
}

export class WorkspaceNameAddressDefectError extends Error {
  readonly code = 'workspace_name_address_defects';

  constructor(readonly report: WorkspaceNameAuditReport) {
    super(
      `refusing to start: ${report.defects.length} workspace name address defect(s). `
        + 'Run `silverhand-server admin scan-workspace-addresses`, repair the names, then restart.',
    );
    this.name = 'WorkspaceNameAddressDefectError';
  }
}
