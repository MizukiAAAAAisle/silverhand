// Runtime integrity proof for workspace display-name addresses (#task:2027).
// The unique index compares stored keys; this audit proves each key is the
// shipped canonicalizer's key and that regular display names do not fold
// together. Agent-home rows are outside the namespace and must carry no key.
import { canonicalizeStoredWorkspaceName } from './workspace-name.js';

export interface WorkspaceNameAuditRow {
  readonly id: string;
  /** The home agent, or `null` for a regular workspace — the same ownership
   *  relation every workspace decision now reads. A row is agent_home (outside
   *  the name namespace, must carry no key) exactly when this is non-null;
   *  #task:2080 dropped the redundant stored `workspace_kind` word. */
  readonly ownerAgentId: string | null;
  readonly name: string;
  readonly nameKey: string | null;
}

export type WorkspaceNameDefect =
  | { readonly kind: 'missing_key'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'stale_key';
      readonly id: string;
      readonly name: string;
      readonly storedKey: string;
      readonly expectedKey: string;
    }
  | {
      readonly kind: 'unnormalized_name';
      readonly id: string;
      readonly name: string;
      readonly canonicalName: string;
    }
  | {
      readonly kind: 'folded_collision';
      readonly key: string;
      readonly members: readonly { readonly id: string; readonly name: string }[];
    }
  | { readonly kind: 'agent_home_has_key'; readonly id: string; readonly key: string };

export interface WorkspaceNameAuditReport {
  readonly scanned: number;
  readonly regularScanned: number;
  readonly keysExpected: boolean;
  readonly defects: readonly WorkspaceNameDefect[];
}

export function auditWorkspaceNameAddresses(
  rows: readonly WorkspaceNameAuditRow[],
  options: { readonly keysExpected: boolean },
): WorkspaceNameAuditReport {
  const defects: WorkspaceNameDefect[] = [];
  const byKey = new Map<string, { key: string; members: { id: string; name: string }[] }>();
  let regularScanned = 0;

  for (const row of rows) {
    if (row.ownerAgentId !== null) {
      if (options.keysExpected && row.nameKey !== null) {
        defects.push({ kind: 'agent_home_has_key', id: row.id, key: row.nameKey });
      }
      continue;
    }
    regularScanned += 1;
    const canonical = canonicalizeStoredWorkspaceName(row.name);
    const group = byKey.get(canonical.key);
    if (group) group.members.push({ id: row.id, name: row.name });
    else byKey.set(canonical.key, { key: canonical.key, members: [{ id: row.id, name: row.name }] });

    if (!options.keysExpected) continue;
    if (row.nameKey === null) {
      defects.push({ kind: 'missing_key', id: row.id, name: row.name });
    } else if (row.nameKey !== canonical.key) {
      defects.push({
        kind: 'stale_key',
        id: row.id,
        name: row.name,
        storedKey: row.nameKey,
        expectedKey: canonical.key,
      });
    }
    if (row.name !== canonical.name) {
      defects.push({
        kind: 'unnormalized_name',
        id: row.id,
        name: row.name,
        canonicalName: canonical.name,
      });
    }
  }

  for (const group of byKey.values()) {
    if (group.members.length > 1) {
      defects.push({ kind: 'folded_collision', key: group.key, members: group.members });
    }
  }
  return { scanned: rows.length, regularScanned, keysExpected: options.keysExpected, defects };
}

export function describeWorkspaceNameAudit(report: WorkspaceNameAuditReport): string {
  if (report.defects.length === 0) {
    return `workspace addresses clean: ${report.regularScanned} regular workspace(s) scanned`;
  }
  const samples = report.defects.slice(0, 20).map(defect => `  ${describeDefect(defect)}`);
  const omitted = report.defects.length - samples.length;
  return [
    `workspace address defects: ${report.defects.length} in ${report.regularScanned} regular workspace(s) scanned`,
    ...samples,
    ...(omitted > 0 ? [`  … ${omitted} further defect(s) not listed`] : []),
  ].join('\n');
}

function describeDefect(defect: WorkspaceNameDefect): string {
  switch (defect.kind) {
    case 'missing_key':
      return `missing_key workspace=${defect.id} name=${JSON.stringify(defect.name)}`;
    case 'stale_key':
      return `stale_key workspace=${defect.id} name=${JSON.stringify(defect.name)} stored=${JSON.stringify(defect.storedKey)} expected=${JSON.stringify(defect.expectedKey)}`;
    case 'unnormalized_name':
      return `unnormalized_name workspace=${defect.id} stored=${JSON.stringify(defect.name)} canonical=${JSON.stringify(defect.canonicalName)}`;
    case 'folded_collision':
      return `folded_collision key=${JSON.stringify(defect.key)} members=${defect.members.map(member => `${member.id}:${JSON.stringify(member.name)}`).join(',')}`;
    case 'agent_home_has_key':
      return `agent_home_has_key workspace=${defect.id} key=${JSON.stringify(defect.key)}`;
  }
}
