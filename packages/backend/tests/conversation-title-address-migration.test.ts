import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import {
  canonicalizeStoredConversationTitle,
  describeConversationTitleAudit,
} from '@silverhand/shared';
import { scanConversationTitleAddresses } from '../src/read-model/conversation-title-audit.js';

// Migration v72 (conversation_title_address) falsifiers — agent-scoped-session-v1
// §8 P0-c (#task:2016).
//
// The claim the product makes is about the TITLE: two channels in one workspace
// cannot show the same name. The database can only state a weaker fact — no two
// workspace-placed rows hold the same STORED `title_key` — because SQLite has
// neither Unicode case folding nor NFC. So this file is organized around the gap
// between those two sentences, and it exists to keep anyone (including a later
// version of me) from citing the UNIQUE index as evidence of the product claim:
//
//   (1) backfill    — every pre-existing workspace row is keyed from its own
//                     title, the display form is canonicalized where it was not,
//                     and NOTHING else about the row changes. Inbox placements
//                     stay unkeyed.
//   (2) precondition— folded collisions are legal data below v72 and would be
//                     refused by the index with a message naming neither channel,
//                     so the migration stops FIRST, names both, and leaves the
//                     database untouched.
//   (3) the rule    — the index, the placement arc, and the weak ASCII CHECK,
//                     each probed by the illegal write it is supposed to refuse
//                     — plus the two writes that MUST still succeed, because a
//                     uniqueness rule that also forbids legal renames is a bug.
//   (4) half-states — three keys that pass the CHECK and are still wrong, one
//                     un-canonical display title, one missing key, and a folded
//                     collision that satisfies the UNIQUE index. Each is injected
//                     by direct SQL, which is the only way to produce it, and each
//                     is reported by the runtime scan. This is the section that
//                     makes the CHECK's weakness a stated floor instead of a
//                     surprise.
//   (5) shape probe — the same scan run against a v71 and a v68 database, because
//                     its first job is to be usable BEFORE this migration.
//
// All DBs are `:memory:` (shiki gate §6).

/** Apply every migration up to and including `maxVersion` onto a fresh
 *  in-memory DB, through the same escape semantics — and the same
 *  precondition-then-`up` order — the production runner uses. */
function openDbThrough(maxVersion: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
  const insertMigration = db.prepare(
    'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, 0)',
  );
  for (const m of migrations) {
    if (m.version > maxVersion) break;
    const apply = () => {
      m.precondition?.(db);
      db.exec(m.up);
      insertMigration.run(m.version, m.name);
    };
    if (m.foreignKeyEscape) {
      db.pragma('legacy_alter_table = ON');
      try {
        db.transaction(apply)();
      } finally {
        db.pragma('legacy_alter_table = OFF');
      }
    } else {
      db.transaction(apply)();
    }
  }
  return db;
}

/**
 * v72 exactly as the runner applies it: precondition and `up` in ONE
 * transaction, so a throwing precondition rolls back the `_migrations` row with
 * it and the upgrade retries on the next boot.
 */
function applyV72(db: Database.Database): void {
  const v72 = migrations.find(m => m.version === 72);
  expect(v72).toBeDefined();
  expect(v72!.foreignKeyEscape).toBe(true);
  db.pragma('legacy_alter_table = ON');
  try {
    db.transaction(() => {
      // The keys are minted in the precondition — SQL cannot fold — and staged in
      // a TEMP table the backfill INSERT joins. Skipping the hook is the same
      // failure the production runner would have: a NOT NULL arc violation with
      // every key NULL.
      v72!.precondition!(db);
      db.exec(v72!.up);
      db.prepare(
        'INSERT INTO _migrations (version, name, applied_at) VALUES (72, ?, 0)',
      ).run(v72!.name);
    })();
  } finally {
    db.pragma('legacy_alter_table = OFF');
  }
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

type Row = Record<string, unknown>;

function conversationRows(db: Database.Database): Row[] {
  return db.prepare<[], Row>('SELECT * FROM conversations ORDER BY id').all();
}

function hasColumn(db: Database.Database, column: string): boolean {
  return db
    .prepare<[string], { name: string }>(
      `SELECT name FROM pragma_table_info('conversations') WHERE name = ?`,
    )
    .get(column) !== undefined;
}

function seedPrincipals(db: Database.Database): void {
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'local', 'local', 1);
    INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u1', 'u1', 'U One', 1, 1);
    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode, created_by_user_id)
    VALUES
      ('a1', 'a1', 'claude', NULL, 'h1', NULL, 1, 1, 'A One', NULL, NULL, 'u1'),
      ('a2', 'a2', 'claude', NULL, 'h1', NULL, 1, 1, 'A Two', NULL, NULL, 'u1');
    INSERT INTO workspaces
      (id, name, description, workspace_kind, owner_agent_id,
       archived_at, pinned_at, created_at, updated_at, owner_user_id)
    VALUES
      ('w1', 'w1', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1'),
      ('w2', 'w2', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1');
  `);
}

interface SeedTitle {
  id: string;
  workspaceId: string;
  title: string;
  rosterPolicy?: 'open' | 'fixed';
  archivedAt?: number | null;
}

function insertV71Conversations(
  db: Database.Database,
  rows: readonly SeedTitle[],
): void {
  const insert = db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
        status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq, visibility)
     VALUES (@id, @workspace_id, NULL, 'workspace', @roster_policy, @title,
             'idle', NULL, NULL, NULL, NULL, 10, 11, @archived_at, 0, 'private')`,
  );
  for (const row of rows) {
    insert.run({
      id: row.id,
      workspace_id: row.workspaceId,
      roster_policy: row.rosterPolicy ?? 'open',
      title: row.title,
      archived_at: row.archivedAt ?? null,
    });
  }
}

/**
 * The whole legal state space of a v71 `title`, chosen so that a backfill which
 * folds, trims, or normalizes ANYTHING differently than the shared canonicalizer
 * produces a visibly wrong key:
 *
 *   - two titles that differ only in case, in DIFFERENT workspaces (same key,
 *     legal — the index is per workspace);
 *   - a padded title and an IDEOGRAPHIC-SPACE-padded one (trim is Unicode);
 *   - an NFD title whose NFC form is a different byte string;
 *   - a title whose fold emits a DECOMPOSED sequence (U+01F0 -> j + caron), which
 *     is why the canonicalizer re-normalizes AFTER folding;
 *   - a title the CURRENT validator would refuse (a ZWJ emoji sequence), because
 *     rows written under the old `trim().min(1).max(128)` rule are legal data and
 *     a backfill that could not key them would fail the upgrade;
 *   - an archived channel, which keeps its address.
 */
const V71_TITLES: readonly SeedTitle[] = [
  { id: 'c_general', workspaceId: 'w1', title: 'General' },
  { id: 'c_design', workspaceId: 'w1', title: '  design  ' },
  { id: 'c_ideographic', workspaceId: 'w1', title: '\u3000roadmap\u3000' },
  { id: 'c_nfd', workspaceId: 'w1', title: 'cafe\u0301' },
  { id: 'c_fold_decomposes', workspaceId: 'w1', title: 'ǰ-notes' },
  { id: 'c_zwj', workspaceId: 'w1', title: 'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}' },
  { id: 'c_archived', workspaceId: 'w1', title: 'Retired', archivedAt: 500 },
  { id: 'c_dm', workspaceId: 'w1', title: 'dm-a1', rosterPolicy: 'fixed' },
  // Same fold as `c_general`, other workspace: proves the index is per workspace.
  { id: 'c_general_w2', workspaceId: 'w2', title: 'general' },
];

/**
 * The two `agent_inbox` placements. v71 mints one per agent from the `agents`
 * table, but only for agents that existed WHEN it ran — these fixtures seed
 * principals afterwards, so the inbox rows are written here explicitly. They are
 * load-bearing rather than scenery: an inbox holds no address, so every count and
 * every scan in this file would be wrong by two if the placement predicate were
 * dropped anywhere.
 */
function insertV71InboxConversations(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
        status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq, visibility)
     VALUES (@id, NULL, @inbox_agent_id, 'agent_inbox', 'fixed', 'Mentions',
             'idle', NULL, NULL, NULL, NULL, 10, 11, NULL, 0, 'private')`,
  );
  insert.run({ id: 'c_inbox_a1', inbox_agent_id: 'a1' });
  insert.run({ id: 'c_inbox_a2', inbox_agent_id: 'a2' });
}

function seedV71(db: Database.Database): void {
  seedPrincipals(db);
  insertV71Conversations(db, V71_TITLES);
  insertV71InboxConversations(db);
}

describe('migration v72 title-as-address — backfill', () => {
  it('keys every workspace placement from its own title and canonicalizes the display form', () => {
    const db = openDbThrough(71);
    try {
      seedV71(db);
      const before = conversationRows(db);

      applyV72(db);

      const after = new Map(conversationRows(db).map(row => [row.id as string, row]));
      for (const seed of V71_TITLES) {
        const canonical = canonicalizeStoredConversationTitle(seed.title);
        const row = after.get(seed.id)!;
        expect({ id: seed.id, title: row.title, key: row.title_key }).toEqual({
          id: seed.id,
          title: canonical.title,
          key: canonical.key,
        });
      }
      // Every OTHER column of every row is byte-identical to what it was: a
      // rebuild's failure mode is silently losing one, not erroring. `title` is
      // excluded only for the WORKSPACE rows the backfill canonicalizes — an
      // inbox title is not an address and must come across untouched.
      const canonicalized = new Set(V71_TITLES.map(seed => seed.id));
      for (const prior of before) {
        const row = after.get(prior.id as string)!;
        for (const [column, value] of Object.entries(prior)) {
          if (column === 'title' && canonicalized.has(prior.id as string)) continue;
          expect({ id: prior.id, column, value: row[column] }).toEqual({
            id: prior.id,
            column,
            value,
          });
        }
      }
      // An inbox placement holds no address, and the arc CHECK is what keeps a
      // resolver that forgot its placement predicate from addressing one.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations
              WHERE placement_kind = 'agent_inbox' AND title_key IS NOT NULL`,
          )
          .get()?.n,
      ).toBe(0);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations
              WHERE placement_kind = 'agent_inbox' AND title = 'Mentions'`,
          )
          .get()?.n,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('is total, and the post-migration database is clean by the scan that judges it', () => {
    const db = openDbThrough(71);
    try {
      seedV71(db);
      applyV72(db);

      // Totality as a query the schema cannot state: the arc CHECK forbids a NULL
      // key on a workspace row, but "the key agrees with the title" is not
      // expressible in SQLite at all, which is why the scan below is the real
      // assertion.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations
              WHERE placement_kind = 'workspace' AND title_key IS NULL`,
          )
          .get()?.n,
      ).toBe(0);

      const report = scanConversationTitleAddresses(db);
      expect(report.keysExpected).toBe(true);
      expect(report.scanned).toBe(V71_TITLES.length);
      expect(report.defects).toEqual([]);
      expect(describeConversationTitleAudit(report)).toBe(
        `title addresses clean: ${V71_TITLES.length} workspace conversation(s) scanned`,
      );
    } finally {
      db.close();
    }
  });
});

describe('migration v72 title-as-address — precondition', () => {
  it('refuses the upgrade when two titles in a workspace fold together, naming both, and changes nothing', () => {
    const db = openDbThrough(71);
    try {
      seedPrincipals(db);
      insertV71Conversations(db, [
        { id: 'c_upper', workspaceId: 'w1', title: 'Design' },
        { id: 'c_padded', workspaceId: 'w1', title: ' design ' },
        { id: 'c_fine', workspaceId: 'w1', title: 'general' },
      ]);
      const before = conversationRows(db);

      // The index alone would say `UNIQUE constraint failed:
      // conversations.workspace_id, conversations.title_key` — no id, no title,
      // nothing to act on. This is the message an operator actually gets.
      let error: unknown;
      try {
        applyV72(db);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('migration v72');
      expect(message).toContain('folded_collision');
      expect(message).toContain('c_upper');
      expect(message).toContain('c_padded');
      // Titles are JSON-quoted in the report because the difference between two
      // colliding titles is usually invisible.
      expect(message).toContain('"Design"');
      expect(message).toContain('" design "');
      expect(message).not.toContain('c_fine');

      // The failure is atomic: no column, no `_migrations` row, no rewritten
      // title. The operator renames a channel and boots again.
      expect(hasColumn(db, 'title_key')).toBe(false);
      expect(
        db
          .prepare<[], { n: number }>(
            'SELECT COUNT(*) AS n FROM _migrations WHERE version = 72',
          )
          .get()?.n,
      ).toBe(0);
      expect(conversationRows(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('reports the same collision the on-demand scan reports on the un-upgraded database', () => {
    const db = openDbThrough(71);
    try {
      seedPrincipals(db);
      insertV71Conversations(db, [
        { id: 'c_upper', workspaceId: 'w1', title: 'Design' },
        { id: 'c_padded', workspaceId: 'w1', title: ' design ' },
      ]);

      // Same detector, two callers: this is what lets an operator run the probe
      // on a copy, clean up, and only then upgrade.
      const report = scanConversationTitleAddresses(db);
      expect(report.keysExpected).toBe(false);
      expect(report.defects).toEqual([
        {
          kind: 'folded_collision',
          workspaceId: 'w1',
          key: 'design',
          members: [
            { id: 'c_padded', title: ' design ' },
            { id: 'c_upper', title: 'Design' },
          ],
        },
      ]);

      let message = '';
      try {
        applyV72(db);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(describeConversationTitleAudit(report));
    } finally {
      db.close();
    }
  });
});

describe('title-as-address — what the database refuses', () => {
  function migratedDb(): Database.Database {
    const db = openDbThrough(71);
    seedPrincipals(db);
    insertV71Conversations(db, [{ id: 'c_design', workspaceId: 'w1', title: 'design' }]);
    insertV71InboxConversations(db);
    applyV72(db);
    return db;
  }

  const insertKeyed = (
    db: Database.Database,
    row: {
      id: string;
      workspaceId: string | null;
      inboxAgentId?: string | null;
      placementKind?: string;
      title: string;
      titleKey: string | null;
      archivedAt?: number | null;
    },
  ): void => {
    db.prepare(
      `INSERT INTO conversations
         (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
          title_key, status, spawned_by_agent_id, closed_at, close_summary,
          pinned_at, created_at, updated_at, archived_at, latest_message_seq,
          visibility)
       VALUES (@id, @workspace_id, @inbox_agent_id, @placement_kind, 'fixed',
               @title, @title_key, 'idle', NULL, NULL, NULL, NULL, 20, 21,
               @archived_at, 0, 'private')`,
    ).run({
      id: row.id,
      workspace_id: row.workspaceId,
      inbox_agent_id: row.inboxAgentId ?? null,
      placement_kind: row.placementKind ?? 'workspace',
      title: row.title,
      title_key: row.titleKey,
      archived_at: row.archivedAt ?? null,
    });
  };

  it('refuses a second row in the workspace holding the same key', () => {
    const db = migratedDb();
    try {
      expect(() =>
        insertKeyed(db, {
          id: 'c_dup',
          workspaceId: 'w1',
          title: 'Design',
          titleKey: 'design',
        }),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('keeps an ARCHIVED channel holding its address', () => {
    const db = migratedDb();
    try {
      db.prepare("UPDATE conversations SET archived_at = 99 WHERE id = 'c_design'").run();
      // A restore that failed — or worse, silently collided — because someone
      // took the name while the channel was archived is a worse surprise than
      // "that name is still in use". Hence no `archived_at IS NULL` on the index.
      expect(() =>
        insertKeyed(db, {
          id: 'c_dup',
          workspaceId: 'w1',
          title: 'design',
          titleKey: 'design',
        }),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('allows the same key in a different workspace, and holds no address for an inbox', () => {
    const db = migratedDb();
    try {
      insertKeyed(db, {
        id: 'c_other_ws',
        workspaceId: 'w2',
        title: 'design',
        titleKey: 'design',
      });
      // Inbox placements are outside the rule entirely: `title_key` is NULL, and
      // NULLs are distinct in a SQLite unique index, so two agents' inboxes may
      // share a title with each other and with a channel.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversations
              WHERE placement_kind = 'agent_inbox' AND title = 'Mentions'`,
          )
          .get()?.n,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('refuses a workspace placement with no key, and an inbox placement with one', () => {
    const db = migratedDb();
    try {
      expect(() =>
        insertKeyed(db, {
          id: 'c_unkeyed',
          workspaceId: 'w1',
          title: 'unkeyed',
          titleKey: null,
        }),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        insertKeyed(db, {
          id: 'c_inbox_keyed',
          workspaceId: null,
          inboxAgentId: 'a1',
          placementKind: 'agent_inbox',
          title: 'Mentions',
          titleKey: 'mentions',
        }),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('refuses the four unfolded spellings the CHECK can actually decide', () => {
    const db = migratedDb();
    try {
      // The CHECK is a spelling guard for a write path that forgot to fold or to
      // trim — the classic being `title` copied straight into `title_key`. It is
      // ASCII-only because that is all SQLite can decide; §"half-states" below
      // owns everything it cannot see.
      for (const [i, key] of ['', 'Design', ' design', 'design '].entries()) {
        expect(() =>
          insertKeyed(db, {
            id: `c_bad_${i}`,
            workspaceId: 'w1',
            title: 'whatever',
            titleKey: key,
          }),
        ).toThrow(/CHECK constraint failed/);
      }
    } finally {
      db.close();
    }
  });

  it('accepts every key the canonicalizer produces — the CHECK is unreachable from it', () => {
    const db = migratedDb();
    try {
      // A CHECK that refused a legal title would turn a rename into an insert
      // failure. The corpus is deliberately the awkward end of the domain.
      const corpus = [
        'General',
        '  padded  ',
        '\u3000ideographic\u3000',
        'cafe\u0301',
        'ǰ-notes',
        'STRASSE ß',
        'İstanbul',
        '中文频道',
        'family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
      ];
      for (const [i, title] of corpus.entries()) {
        const canonical = canonicalizeStoredConversationTitle(title);
        insertKeyed(db, {
          id: `c_ok_${i}`,
          workspaceId: 'w2',
          title: canonical.title,
          titleKey: canonical.key,
        });
      }
      expect(scanConversationTitleAddresses(db).defects).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('allows a re-casing rename (same key) and a release-then-retake in one transaction', () => {
    const db = migratedDb();
    try {
      // `design` -> `Design` is a legal rename whose key does not move. A
      // "title changed => key must change" trigger would refuse it, which is why
      // there is none.
      const recased = canonicalizeStoredConversationTitle('Design');
      db.prepare(
        'UPDATE conversations SET title = ?, title_key = ? WHERE id = ?',
      ).run(recased.title, recased.key, 'c_design');
      expect(
        db
          .prepare<[string], { title: string; title_key: string }>(
            'SELECT title, title_key FROM conversations WHERE id = ?',
          )
          .get('c_design'),
      ).toEqual({ title: 'Design', title_key: 'design' });

      // A rename RELEASES the old title immediately: nothing remembers it, so
      // another channel may take it in the very next statement.
      insertKeyed(db, {
        id: 'c_taker',
        workspaceId: 'w1',
        title: 'placeholder',
        titleKey: 'placeholder',
      });
      const renamed = canonicalizeStoredConversationTitle('Marketing');
      const taken = canonicalizeStoredConversationTitle('design');
      db.transaction(() => {
        const update = db.prepare(
          'UPDATE conversations SET title = ?, title_key = ? WHERE id = ?',
        );
        update.run(renamed.title, renamed.key, 'c_design');
        update.run(taken.title, taken.key, 'c_taker');
      })();
      expect(
        db
          .prepare<[string], { id: string }>(
            `SELECT id FROM conversations
              WHERE workspace_id = 'w1' AND title_key = ?`,
          )
          .get('design'),
      ).toEqual({ id: 'c_taker' });
      expect(scanConversationTitleAddresses(db).defects).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe('title-as-address — half-states the schema cannot see', () => {
  function migratedDb(titles: readonly SeedTitle[]): Database.Database {
    const db = openDbThrough(71);
    seedPrincipals(db);
    insertV71Conversations(db, titles);
    applyV72(db);
    return db;
  }

  /** Overwrite a stored key WITHOUT touching the title — the shape of every
   *  write path that brings its own fold. */
  function forceKey(db: Database.Database, id: string, key: string): void {
    db.prepare('UPDATE conversations SET title_key = ? WHERE id = ?').run(key, id);
  }

  it('reports a key that passes the CHECK and is still not the fold of its title', () => {
    // The three ways to be wrong that the ASCII CHECK cannot see, one row each:
    // NOT FOLDED (the uppercase is not ASCII, so `GLOB '*[A-Z]*'` never sees
    // it), NOT TRIMMED (the padding is U+3000, so `GLOB ' *'` never sees it),
    // and NOT DERIVED FROM THIS TITLE AT ALL.
    const db = migratedDb([
      { id: 'c_unfolded', workspaceId: 'w1', title: 'ЖУРНАЛ' },
      { id: 'c_untrimmed', workspaceId: 'w1', title: 'roadmap' },
      { id: 'c_foreign', workspaceId: 'w1', title: 'design' },
    ]);
    try {
      forceKey(db, 'c_unfolded', 'ЖУРНАЛ');
      forceKey(db, 'c_untrimmed', '\u3000roadmap');
      forceKey(db, 'c_foreign', 'marketing');

      const report = scanConversationTitleAddresses(db);
      expect(report.defects).toEqual([
        {
          kind: 'stale_key',
          id: 'c_foreign',
          workspaceId: 'w1',
          title: 'design',
          storedKey: 'marketing',
          expectedKey: 'design',
        },
        {
          kind: 'stale_key',
          id: 'c_unfolded',
          workspaceId: 'w1',
          title: 'ЖУРНАЛ',
          storedKey: 'ЖУРНАЛ',
          expectedKey: 'журнал',
        },
        {
          kind: 'stale_key',
          id: 'c_untrimmed',
          workspaceId: 'w1',
          title: 'roadmap',
          storedKey: '\u3000roadmap',
          expectedKey: 'roadmap',
        },
      ]);
      const description = describeConversationTitleAudit(report);
      expect(description).toContain('3 in 3 workspace conversation(s)');
      // The rendering quotes both sides, because "shows one name, answers to
      // another" is unreadable when the difference is an invisible character.
      expect(description).toContain('shows "design" but answers to "marketing"');
    } finally {
      db.close();
    }
  });

  it('reports an un-canonical display title even though its address still works', () => {
    const db = migratedDb([{ id: 'c_padded', workspaceId: 'w1', title: 'design' }]);
    try {
      // Correct key, padded title: addressing works, so the UNIQUE index and the
      // CHECK are both satisfied. It is still a defect — a write path produced a
      // title the canonicalizer did not, and the next one may produce a key to
      // match.
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(
        ' design ',
        'c_padded',
      );
      expect(scanConversationTitleAddresses(db).defects).toEqual([
        {
          kind: 'unnormalized_title',
          id: 'c_padded',
          workspaceId: 'w1',
          title: ' design ',
          canonicalTitle: 'design',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('reports a workspace placement with no address at all', () => {
    const db = migratedDb([{ id: 'c_design', workspaceId: 'w1', title: 'design' }]);
    try {
      // Unreachable through SQL as written — the arc CHECK forbids it — so the
      // only way to show the detector detecting is to suspend the CHECK for one
      // statement. That is also the honest statement of the risk: a future table
      // rebuild that dropped the arc, or a schema restored from elsewhere, would
      // produce exactly this row, and it would occupy no title and collide with
      // nothing, because the unique index treats NULLs as distinct.
      db.pragma('ignore_check_constraints = ON');
      try {
        db.prepare(
          'UPDATE conversations SET title_key = NULL WHERE id = ?',
        ).run('c_design');
      } finally {
        db.pragma('ignore_check_constraints = OFF');
      }

      expect(scanConversationTitleAddresses(db).defects).toEqual([
        {
          kind: 'missing_key',
          id: 'c_design',
          workspaceId: 'w1',
          title: 'design',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('reports two channels showing the same title while the UNIQUE index is satisfied', () => {
    // Note what it takes to build this state: the migration REFUSES to create it,
    // so the fixture starts legal and is broken afterwards by a rename that
    // brings its own key — the exact bug the branded pair makes unrepresentable
    // in TypeScript, done in SQL.
    const db = migratedDb([
      { id: 'c_design', workspaceId: 'w1', title: 'design' },
      { id: 'c_other', workspaceId: 'w1', title: 'placeholder' },
    ]);
    try {
      // THE point of this file. After this rename both rows DISPLAY the same
      // name; their STORED keys differ, so the unique index is content and the
      // CHECK is content. The product claim is broken and only the scan can say
      // so — which is why "the column has a UNIQUE index" is never evidence that
      // display titles are unique.
      db.prepare(
        `UPDATE conversations
            SET title = 'Design', title_key = 'design-renamed-badly'
          WHERE id = 'c_other'`,
      ).run();

      const report = scanConversationTitleAddresses(db);
      expect(
        report.defects.filter(defect => defect.kind === 'folded_collision'),
      ).toEqual([
        {
          kind: 'folded_collision',
          workspaceId: 'w1',
          key: 'design',
          members: [
            { id: 'c_design', title: 'design' },
            { id: 'c_other', title: 'Design' },
          ],
        },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('title-as-address — the scan runs before the migration it protects', () => {
  it('reads a v71 database (placement axis, no key column)', () => {
    const db = openDbThrough(71);
    try {
      seedPrincipals(db);
      insertV71Conversations(db, [
        { id: 'c_upper', workspaceId: 'w1', title: 'Design' },
        { id: 'c_lower', workspaceId: 'w1', title: 'design' },
        { id: 'c_other', workspaceId: 'w2', title: 'design' },
      ]);
      insertV71InboxConversations(db);

      const report = scanConversationTitleAddresses(db);
      // `keysExpected: false` is the whole reason this mode exists: reporting a
      // `missing_key` for every row of a pre-v72 database would bury the one
      // class that blocks the upgrade.
      expect(report.keysExpected).toBe(false);
      expect(report.scanned).toBe(3);
      expect(report.defects.map(defect => defect.kind)).toEqual(['folded_collision']);
    } finally {
      db.close();
    }
  });

  it('reads a v68 database, where "the workspace-placed rows" is spelled "all of them"', () => {
    const db = openDbThrough(68);
    try {
      db.exec(`
        INSERT INTO users (id, name, display_name, created_at, updated_at)
          VALUES ('u1', 'u1', 'U One', 1, 1);
        INSERT INTO workspaces
          (id, name, description, workspace_kind, owner_agent_id,
           archived_at, created_at, updated_at, pinned_at, owner_user_id)
          VALUES ('w1', 'w1', NULL, 'regular', NULL, NULL, 1, 1, NULL, 'u1');
        INSERT INTO conversations
          (id, workspace_id, kind, title, status, spawned_by_agent_id, closed_at,
           close_summary, pinned_at, created_at, updated_at, archived_at,
           latest_message_seq, visibility)
        VALUES
          ('c_upper', 'w1', 'channel', 'Design', 'idle', NULL, NULL, NULL, NULL,
           10, 11, NULL, 0, 'private'),
          ('c_lower', 'w1', 'dm_channel', ' design ', 'idle', NULL, NULL, NULL,
           NULL, 12, 13, NULL, 0, 'private');
      `);

      // v69 backfills EVERY pre-existing row to `placement_kind = 'workspace'`,
      // so scanning all of them here is the same SET the v72 index will cover —
      // and a DM's title participates in the address space exactly as a
      // channel's does.
      const report = scanConversationTitleAddresses(db);
      expect(report.keysExpected).toBe(false);
      expect(report.scanned).toBe(2);
      expect(report.defects.map(defect => defect.kind)).toEqual(['folded_collision']);
    } finally {
      db.close();
    }
  });
});
