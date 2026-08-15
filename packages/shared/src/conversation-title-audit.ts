// The INTEGRITY half of title-as-address (#task:2016).
//
// `conversations.title_key` carries a UNIQUE index, and that index proves
// exactly one thing: no two workspace-placed rows in a workspace hold the same
// STORED key. It knows nothing about `title` — SQLite has no Unicode case
// folding and no NFC, so the relationship "key = fold(title)" is maintained by
// the writer, not by the schema. The claim the product makes to a user is about
// the TITLE ("two channels here cannot show the same name"), and that claim is a
// conjunction of three properties: one canonicalizer, a terminal writer that can
// only be handed an unforgeable pair, and — because the first two are code and
// code can be bypassed — a half-state that is DETECTABLE AT RUNTIME.
//
// This module is the third property. It is the whole definition of a half-state,
// in one place, with no SQL and no I/O, so that the three callers cannot drift:
//
//   - the v72 migration precondition, BEFORE the column exists: folded
//     collisions among existing titles are a hard stop, because the unique index
//     it is about to create would refuse them with a message naming neither
//     channel;
//   - the boot scan, AFTER migrations: anything the writer let through FAILS
//     CLOSED — every class means the address a person reads is not the address
//     the row answers to, so serving would misdeliver silently;
//   - `silverhand-server admin scan-title-addresses`: the same report on demand,
//     read-only, so the answer to "is this database clean?" does not require a
//     restart.
//
// A detector that has never been shown detecting is not evidence, so each defect
// class below is fault-injected in the tests by direct SQL — the only way to
// produce them, which is the point.
import {
  canonicalizeStoredConversationTitle,
} from './conversation-title.js';

/**
 * One workspace-placed conversation, as the audit needs to see it.
 *
 * The caller supplies rows already filtered to `placement_kind = 'workspace'`:
 * placement is a persistence concern and an inbox or DirectPair holds no title
 * address at all (the schema keeps `title_key` NULL for them, so there is
 * nothing here to judge).
 */
export interface ConversationTitleAuditRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  /** `null` when the column does not exist yet (pre-v72) or was never written. */
  readonly titleKey: string | null;
}

export type ConversationTitleDefect =
  /** A workspace placement with no address at all. Invisible to the unique
   *  index — SQLite treats NULLs as distinct — so this row occupies no title and
   *  collides with nothing. */
  | {
      readonly kind: 'missing_key';
      readonly id: string;
      readonly workspaceId: string;
      readonly title: string;
    }
  /** The key does not match the title: the row SHOWS one name and ANSWERS to
   *  another. The exact bug the branded pair exists to make unrepresentable. */
  | {
      readonly kind: 'stale_key';
      readonly id: string;
      readonly workspaceId: string;
      readonly title: string;
      readonly storedKey: string;
      readonly expectedKey: string;
    }
  /** The key is right but the display title is not canonical (un-normalized or
   *  padded). Addressing still works — a padded title folds to the same key — so
   *  this is the mildest class, and it is still a defect: it means a write path
   *  produced a title the canonicalizer did not, and the next one may produce a
   *  key to match. */
  | {
      readonly kind: 'unnormalized_title';
      readonly id: string;
      readonly workspaceId: string;
      readonly title: string;
      readonly canonicalTitle: string;
    }
  /** Two or more rows whose titles FOLD together in one workspace. Reachable
   *  only through a wrong stored key, which is why it is computed from the
   *  titles rather than from the keys the index already made unique. */
  | {
      readonly kind: 'folded_collision';
      readonly workspaceId: string;
      readonly key: string;
      readonly members: readonly { readonly id: string; readonly title: string }[];
    };

export interface ConversationTitleAuditReport {
  readonly scanned: number;
  /** `false` pre-v72: only `folded_collision` is computable, and it is the class
   *  that must block the migration. */
  readonly keysExpected: boolean;
  readonly defects: readonly ConversationTitleDefect[];
}

/**
 * Judge a set of workspace placements. Pure, total, and order-independent in its
 * verdict: defects are emitted in input order per class so a report is stable
 * enough to diff, but no defect depends on where a row sits in the scan.
 *
 * `keysExpected: false` is the pre-migration mode — the column does not exist,
 * every `titleKey` is `null`, and reporting 400 `missing_key` defects would bury
 * the one class that matters. The migration REPAIRS un-normalized titles as it
 * keys them, so that class is not a pre-migration defect either.
 */
export function auditConversationTitleAddresses(
  workspacePlacements: readonly ConversationTitleAuditRow[],
  options: { readonly keysExpected: boolean },
): ConversationTitleAuditReport {
  const defects: ConversationTitleDefect[] = [];
  const byKey = new Map<
    string,
    { workspaceId: string; key: string; members: { id: string; title: string }[] }
  >();

  for (const row of workspacePlacements) {
    const canonical = canonicalizeStoredConversationTitle(row.title);
    // Grouped on the workspace + the key the TITLE derives, never on the stored
    // key: a collision only becomes possible once a stored key is wrong, so
    // trusting it here would make the detector blind to exactly the fault it
    // exists to find.
    const group = byKey.get(`${row.workspaceId}\u0000${canonical.key}`);
    if (group) {
      group.members.push({ id: row.id, title: row.title });
    } else {
      byKey.set(`${row.workspaceId}\u0000${canonical.key}`, {
        workspaceId: row.workspaceId,
        key: canonical.key,
        members: [{ id: row.id, title: row.title }],
      });
    }

    if (!options.keysExpected) continue;

    if (row.titleKey === null) {
      defects.push({
        kind: 'missing_key',
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
      });
    } else if (row.titleKey !== canonical.key) {
      defects.push({
        kind: 'stale_key',
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        storedKey: row.titleKey,
        expectedKey: canonical.key,
      });
    }
    if (row.title !== canonical.title) {
      defects.push({
        kind: 'unnormalized_title',
        id: row.id,
        workspaceId: row.workspaceId,
        title: row.title,
        canonicalTitle: canonical.title,
      });
    }
  }

  for (const group of byKey.values()) {
    if (group.members.length < 2) continue;
    defects.push({
      kind: 'folded_collision',
      workspaceId: group.workspaceId,
      key: group.key,
      members: group.members,
    });
  }

  return {
    scanned: workspacePlacements.length,
    keysExpected: options.keysExpected,
    defects,
  };
}

/** How many defects a rendered report prints per class before summarizing. A
 *  report is read by a human in a log line or a terminal; the COUNTS are always
 *  exact, only the enumeration is bounded. */
const SAMPLE_LIMIT = 20;

/**
 * Render a report for a log message or a terminal. Titles are JSON-quoted
 * because a defect is usually about characters you cannot see — an unquoted
 * `"  design"` and `"design"` print identically, which would make the report
 * useless precisely where it matters.
 */
export function describeConversationTitleAudit(
  report: ConversationTitleAuditReport,
): string {
  if (report.defects.length === 0) {
    return `title addresses clean: ${report.scanned} workspace conversation(s) scanned`;
  }
  const lines: string[] = [
    `title address defects: ${report.defects.length} in ${report.scanned} workspace conversation(s) scanned`,
  ];
  const counted = new Map<ConversationTitleDefect['kind'], number>();
  for (const defect of report.defects) {
    const seen = (counted.get(defect.kind) ?? 0) + 1;
    counted.set(defect.kind, seen);
    if (seen > SAMPLE_LIMIT) continue;
    lines.push(`  ${describeDefect(defect)}`);
  }
  for (const [kind, total] of counted) {
    if (total > SAMPLE_LIMIT) {
      lines.push(`  … ${total - SAMPLE_LIMIT} further ${kind} defect(s) not listed`);
    }
  }
  return lines.join('\n');
}

function describeDefect(defect: ConversationTitleDefect): string {
  switch (defect.kind) {
    case 'missing_key':
      return `missing_key: conversation ${defect.id} in workspace ${defect.workspaceId} shows ${JSON.stringify(defect.title)} and has no address`;
    case 'stale_key':
      return `stale_key: conversation ${defect.id} in workspace ${defect.workspaceId} shows ${JSON.stringify(defect.title)} but answers to ${JSON.stringify(defect.storedKey)} (expected ${JSON.stringify(defect.expectedKey)})`;
    case 'unnormalized_title':
      return `unnormalized_title: conversation ${defect.id} in workspace ${defect.workspaceId} stores ${JSON.stringify(defect.title)}, canonical form is ${JSON.stringify(defect.canonicalTitle)}`;
    case 'folded_collision':
      return `folded_collision: workspace ${defect.workspaceId} key ${JSON.stringify(defect.key)} claimed by ${defect.members
        .map(member => `${member.id} ${JSON.stringify(member.title)}`)
        .join(', ')}`;
  }
}
