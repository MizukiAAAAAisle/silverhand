// The half-state detector (#task:2016).
//
// The DB proves stored keys unique; this module is what makes the DISPLAY-title
// claim checkable, so its own contract has to be evidenced rather than assumed.
// Two properties matter:
//
//  1. It reports each defect class the writer could let through — including the
//     one the unique index is structurally blind to (a NULL key), and the one it
//     cannot see at all (a key that does not match its title).
//  2. It is SILENT on clean data. A scan that cries on legal rows gets ignored,
//     and an ignored detector is not the third property of anything.
//
// Pre-migration mode is tested separately because it is a different question:
// with no column to read, only folded collisions exist, and reporting a missing
// key for every row would bury the one class that must block the upgrade.
import { describe, expect, it } from 'vitest';
import {
  auditConversationTitleAddresses,
  describeConversationTitleAudit,
  type ConversationTitleAuditRow,
} from '../src/index.js';

/** A clean row. The key is spelled with `toLowerCase`, NOT the canonicalizer:
 *  an expectation derived from the code under test proves nothing. That limits
 *  this helper to ASCII titles — every row whose fold is interesting is written
 *  out by hand below. */
function clean(id: string, title: string, workspaceId = 'w1'): ConversationTitleAuditRow {
  return { id, workspaceId, title, titleKey: title.normalize('NFC').trim().toLowerCase() };
}

describe('title address audit: clean data (#task:2016)', () => {
  it('is silent on rows the writer produced', () => {
    const report = auditConversationTitleAddresses(
      [
        clean('c1', 'design'),
        clean('c2', 'UI/UX 优化'),
        clean('c3', 'design', 'w2'),
        { id: 'c4', workspaceId: 'w1', title: '\u1E9E', titleKey: 'ss' },
        { id: 'c5', workspaceId: 'w1', title: '\u00C5', titleKey: '\u00E5' },
      ],
      { keysExpected: true },
    );
    expect(report.defects).toEqual([]);
    expect(report.scanned).toBe(5);
    expect(describeConversationTitleAudit(report)).toContain('clean');
  });

  it('does not treat the same title in two workspaces as a collision', () => {
    // The address is workspace-scoped. If this were reported, every deployment
    // with two workspaces named `general` would look broken.
    const report = auditConversationTitleAddresses(
      [clean('c1', 'general', 'w1'), clean('c2', 'general', 'w2')],
      { keysExpected: true },
    );
    expect(report.defects).toEqual([]);
  });
});

describe('title address audit: defect classes (#task:2016)', () => {
  it('reports a workspace placement with no key', () => {
    // Invisible to the UNIQUE index — SQLite treats NULLs as distinct — so this
    // row occupies no address and collides with nothing.
    const report = auditConversationTitleAddresses(
      [{ id: 'c1', workspaceId: 'w1', title: 'design', titleKey: null }],
      { keysExpected: true },
    );
    expect(report.defects).toEqual([
      { kind: 'missing_key', id: 'c1', workspaceId: 'w1', title: 'design' },
    ]);
  });

  it('reports a key that does not match its title', () => {
    // The row SHOWS `design` and ANSWERS to `archive`. No constraint in SQLite
    // can see this, which is the reason this module exists.
    const report = auditConversationTitleAddresses(
      [{ id: 'c1', workspaceId: 'w1', title: 'design', titleKey: 'archive' }],
      { keysExpected: true },
    );
    expect(report.defects).toEqual([
      {
        kind: 'stale_key',
        id: 'c1',
        workspaceId: 'w1',
        title: 'design',
        storedKey: 'archive',
        expectedKey: 'design',
      },
    ]);
  });

  it('reports an un-normalized stored title', () => {
    const report = auditConversationTitleAddresses(
      [{ id: 'c1', workspaceId: 'w1', title: '  design  ', titleKey: 'design' }],
      { keysExpected: true },
    );
    expect(report.defects).toEqual([
      {
        kind: 'unnormalized_title',
        id: 'c1',
        workspaceId: 'w1',
        title: '  design  ',
        canonicalTitle: 'design',
      },
    ]);
  });

  it('reports two titles that fold together even when the stored keys differ', () => {
    // How a collision survives a UNIQUE index: someone wrote a key that is not
    // the fold of its title, so the index saw two different strings.
    const report = auditConversationTitleAddresses(
      [
        { id: 'c1', workspaceId: 'w1', title: 'Design', titleKey: 'design' },
        { id: 'c2', workspaceId: 'w1', title: 'DESIGN', titleKey: 'DESIGN-typo' },
      ],
      { keysExpected: true },
    );
    const collision = report.defects.find((d) => d.kind === 'folded_collision');
    expect(collision).toEqual({
      kind: 'folded_collision',
      workspaceId: 'w1',
      key: 'design',
      members: [
        { id: 'c1', title: 'Design' },
        { id: 'c2', title: 'DESIGN' },
      ],
    });
  });

  it('names the offending rows in the rendered report', () => {
    // The report is the whole remedy: an operator has to know WHICH channel to
    // rename, and titles are JSON-quoted because the defect is often invisible
    // characters.
    const rendered = describeConversationTitleAudit(
      auditConversationTitleAddresses(
        [
          { id: 'c1', workspaceId: 'w1', title: '  design', titleKey: 'design' },
          { id: 'c2', workspaceId: 'w1', title: 'design', titleKey: 'design' },
        ],
        { keysExpected: true },
      ),
    );
    expect(rendered).toContain('c1');
    expect(rendered).toContain('c2');
    expect(rendered).toContain('"  design"');
    expect(rendered).toContain('folded_collision');
  });

  it('counts every defect even when it lists only a sample', () => {
    // No silent caps: the enumeration is bounded, the count never is.
    const rows = Array.from({ length: 25 }, (_, index) => ({
      id: `c${index}`,
      workspaceId: 'w1',
      title: `channel ${index}`,
      titleKey: null,
    }));
    const report = auditConversationTitleAddresses(rows, { keysExpected: true });
    expect(report.defects).toHaveLength(25);
    const rendered = describeConversationTitleAudit(report);
    expect(rendered).toContain('25 in 25 workspace conversation(s)');
    expect(rendered).toContain('5 further missing_key defect(s) not listed');
  });
});

describe('title address audit: pre-migration mode (#task:2016)', () => {
  const ROWS: readonly ConversationTitleAuditRow[] = [
    { id: 'c1', workspaceId: 'w1', title: 'Design', titleKey: null },
    { id: 'c2', workspaceId: 'w1', title: '  design  ', titleKey: null },
    { id: 'c3', workspaceId: 'w1', title: 'other', titleKey: null },
  ];

  it('reports only the class that must block the migration', () => {
    // Every key is null and one title is padded, and neither is a defect below
    // v72: the column does not exist, and the migration itself canonicalizes
    // the title as it keys it.
    const report = auditConversationTitleAddresses(ROWS, { keysExpected: false });
    expect(report.defects).toEqual([
      {
        kind: 'folded_collision',
        workspaceId: 'w1',
        key: 'design',
        members: [
          { id: 'c1', title: 'Design' },
          { id: 'c2', title: '  design  ' },
        ],
      },
    ]);
  });

  it('passes a database whose titles merely need normalizing', () => {
    // Padding and NFD are not collisions and not defects: the migration writes
    // the canonical form back as it keys each row. Blocking on them would refuse
    // an upgrade over data nobody has to fix.
    const report = auditConversationTitleAddresses(
      [
        { id: 'c1', workspaceId: 'w1', title: '  design  ', titleKey: null },
        { id: 'c2', workspaceId: 'w1', title: 'A\u030A', titleKey: null },
        { id: 'c3', workspaceId: 'w1', title: 'notes', titleKey: null },
      ],
      { keysExpected: false },
    );
    expect(report.defects).toEqual([]);
  });
});
