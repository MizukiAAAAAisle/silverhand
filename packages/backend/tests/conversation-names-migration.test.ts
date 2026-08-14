import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ConversationNameSchema } from '@silverhand/shared';
import { migrations } from '@silverhand/shared/db/migrations';

// Migration v72 (conversation_names) falsifiers — agent-scoped-session-v1 §8
// P0-c (#task:2016).
//
// A workspace conversation gains a stable ADDRESS. The whole point is that the
// address survives what the display title does not, so what has to be pinned is
// not "a name column appeared" but the four properties the model claims:
//
//   (1) A name, once allocated, is PERMANENT. The primary key spans current and
//       retired allocations, so reuse is impossible by construction — but a key
//       only blocks a conflicting INSERT. `UPDATE name`, `UPDATE workspace_id`,
//       a plain `DELETE` and resetting `retired_at` back to NULL each release an
//       allocated name, and each is executed here as DIRECT SQL: a repo that
//       happens not to write those statements today proves nothing about the
//       next repo.
//   (2) An allocation is BORN VALID. Dropping the FK (the retired row must
//       outlive its conversation) removes the only structural birth check, so
//       the trigger has to refuse a nonexistent target, an `agent_inbox` target
//       and — the one that is a cross-workspace addressing hole rather than
//       dirty data — a target belonging to another workspace.
//   (3) SINGLE-VALUEDNESS is a DB fact; TOTALITY is not. The partial UNIQUE
//       proves at most one current name per conversation. That every live
//       workspace conversation HAS one is a property of the backfill and of the
//       create/rename units of work, so it is asserted over the data here rather
//       than claimed of the schema.
//   (4) The backfill invents nothing. Names come from titles through the one
//       production deriver, collisions resolve by `(created_at, id)`, and every
//       pre-existing `conversations` row is untouched.
//   (5) An allocation is BORN CURRENT (@Cindy's B2). The retirement TRANSITION
//       was already guarded; birth was not, and a row inserted already retired
//       is seen by neither the partial UNIQUE (current rows only) nor the
//       immutability trigger (UPDATE only) — so the guard is asserted the only
//       way that means anything: by dropping it and showing what lands.
//   (6) The name DOMAIN is a database fact (@Cindy's B1). The CHECK is a second
//       transcription of shared's grammar, so what is pinned is that it decides
//       exactly what `ConversationNameSchema` decides — a name outside the
//       grammar is unspellable by the tokenizer AND unreleasable, the one bad
//       write no later fix can undo.
//
// The whole-schema fingerprint lives in migration-baseline.test.ts's living
// golden; this file owns the behavioral half. All DBs are `:memory:`.

/** Apply every migration up to and including `maxVersion`, through the same
 *  escape semantics the production runner uses. */
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

function applyV72(db: Database.Database): void {
  const v72 = migrations.find(m => m.version === 72);
  expect(v72).toBeDefined();
  db.transaction(() => {
    // The names are minted in the precondition — inside the migration's own
    // transaction, on the same connection — because SQL cannot derive a slug.
    // Skipping the hook fails exactly as the production runner would:
    // `no such table: temp.conversation_name_backfill`.
    v72!.precondition!(db);
    db.exec(v72!.up);
    db.prepare(
      'INSERT INTO _migrations (version, name, applied_at) VALUES (72, ?, 0)',
    ).run(v72!.name);
  })();
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
}

type Row = Record<string, unknown>;

/**
 * A v71 fixture whose titles are the ones that decide the derivation, not
 * decorative ones: two titles that differ only by case (one namespace, one
 * collision), two titles with nothing admissible in them at all (the CJK/emoji
 * majority, which all collapse onto the same fallback stem), a digit-leading
 * title (inadmissible as an address — `#42` is a TASK reference), a mixed
 * ASCII/CJK title, and the SAME title in a second workspace, which must get the
 * same name because namespaces are per workspace.
 *
 * `wsah_a1` is an agent-home workspace: its conversations are workspace-PLACED
 * and therefore do get names. `a1`'s inbox is placed on the AGENT, so it must
 * get none — the difference the domain rests on. It is written here exactly as
 * v71's backfill and the production aggregate factory write it (`workspace_id`
 * NULL, `inbox_agent_id` set), because a fixture seeded after v71 has no agent
 * for that migration's backfill to have found.
 */
function seedV71(db: Database.Database): void {
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'local', 'local', 1);
    INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u1', 'u1', 'U One', 1, 1);
    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode, created_by_user_id)
    VALUES ('a1', 'a1', 'claude', NULL, 'h1', NULL, 1, 1, 'A One', NULL, NULL, 'u1');
    INSERT INTO workspaces
      (id, name, description, workspace_kind, owner_agent_id,
       archived_at, pinned_at, created_at, updated_at, owner_user_id)
    VALUES
      ('ws_a', 'A', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1'),
      ('ws_b', 'B', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1'),
      ('wsah_a1', 'a1 home', NULL, 'agent_home', 'a1', NULL, NULL, 1, 1, 'u1');
    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
       status, spawned_by_agent_id, closed_at, close_summary, pinned_at,
       created_at, updated_at, archived_at, latest_message_seq, visibility)
    VALUES ('c_inbox_a1', NULL, 'a1', 'agent_inbox', 'fixed', 'Inbox', 'idle',
            NULL, NULL, NULL, NULL, 1, 1, NULL, 0, 'private');
  `);
  const insertConversation = db.prepare(
    `INSERT INTO conversations
       (id, workspace_id, placement_kind, roster_policy, title, status,
        spawned_by_agent_id, closed_at, close_summary, pinned_at,
        created_at, updated_at, archived_at, latest_message_seq, visibility)
     VALUES (@id, @workspace_id, 'workspace', @roster_policy, @title, 'idle',
             NULL, NULL, NULL, NULL, @created_at, @created_at,
             NULL, 0, 'private')`,
  );
  const rows = [
    { id: 'c_design', workspace_id: 'ws_a', roster_policy: 'open', title: 'Design', created_at: 100 },
    { id: 'c_design_dup', workspace_id: 'ws_a', roster_policy: 'open', title: 'design', created_at: 200 },
    { id: 'c_cjk', workspace_id: 'ws_a', roster_policy: 'open', title: '优化', created_at: 300 },
    { id: 'c_emoji', workspace_id: 'ws_a', roster_policy: 'open', title: '🎨', created_at: 400 },
    { id: 'c_digits', workspace_id: 'ws_a', roster_policy: 'open', title: '2026 roadmap', created_at: 500 },
    { id: 'c_mixed', workspace_id: 'ws_a', roster_policy: 'fixed', title: 'UI/UX 优化', created_at: 600 },
    { id: 'c_b_design', workspace_id: 'ws_b', roster_policy: 'open', title: 'Design', created_at: 150 },
    { id: 'c_home_dm', workspace_id: 'wsah_a1', roster_policy: 'fixed', title: 'dm-a1', created_at: 700 },
  ];
  for (const row of rows) insertConversation.run(row);
}

function currentNames(db: Database.Database): Record<string, string> {
  const rows = db
    .prepare<[], { conversation_id: string; name: string }>(
      `SELECT conversation_id, name FROM conversation_names
        WHERE retired_at IS NULL ORDER BY conversation_id`,
    )
    .all();
  return Object.fromEntries(rows.map(r => [r.conversation_id, r.name]));
}

/** `expect(...).toThrow()` around a direct statement, so the assertion reads as
 *  "the DATABASE refuses this", not "no code path writes it". */
function refuses(db: Database.Database, sql: string): () => unknown {
  return () => db.prepare(sql).run();
}

function conversationRows(db: Database.Database): Row[] {
  return db
    .prepare<[], Row>(
      `SELECT * FROM conversations WHERE placement_kind = 'workspace' ORDER BY id`,
    )
    .all();
}

function migratedDb(): Database.Database {
  const db = openDbThrough(71);
  seedV71(db);
  applyV72(db);
  return db;
}

describe('v72 backfill (#task:2016)', () => {
  it('gives every workspace-placed conversation exactly one current name, and no other conversation any', () => {
    const db = migratedDb();
    try {
      const placed = db
        .prepare<[], { n: number }>(
          `SELECT count(*) AS n FROM conversations WHERE placement_kind = 'workspace'`,
        )
        .get()!.n;
      // Totality, stated over the data because the schema cannot state it:
      // no workspace conversation without a current name, and no current name
      // without a workspace conversation.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversations c
              WHERE c.placement_kind = 'workspace'
                AND NOT EXISTS (
                  SELECT 1 FROM conversation_names n
                   WHERE n.conversation_id = c.id AND n.retired_at IS NULL
                )`,
          )
          .get()!.n,
      ).toBe(0);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_names`,
          )
          .get()!.n,
      ).toBe(placed);
      // The inbox is not workspace-placed, so the domain excludes it. This is
      // the assertion that fails if a predicate is written over
      // `conversations.kind` — which is GENERATED and reads `dm_channel` for an
      // inbox too.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_names n
               JOIN conversations c ON c.id = n.conversation_id
              WHERE c.placement_kind != 'workspace'`,
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('derives names from titles through the production deriver, resolving collisions by (created_at, id)', () => {
    const db = migratedDb();
    try {
      expect(currentNames(db)).toEqual({
        c_design: 'design',
        // Same slug as `c_design`, created later ⇒ the ordinal, not the bare
        // stem. Only the backfill may suffix; creation refuses instead.
        c_design_dup: 'design-2',
        // Nothing admissible in either title: both collapse onto the fallback
        // stem, and the earlier one keeps it.
        c_cjk: 'channel',
        c_emoji: 'channel-2',
        // Digit-leading slugs get the stable letter prefix: `#2026-roadmap`
        // would be unspellable as a channel and `#42` is a TASK reference.
        c_digits: 'channel-2026-roadmap',
        c_mixed: 'ui-ux',
        // Same title as `c_design`, different workspace ⇒ same name. Namespaces
        // are per workspace; this is not a collision.
        c_b_design: 'design',
        c_home_dm: 'dm-a1',
      });
    } finally {
      db.close();
    }
  });

  it('derives only admissible names', () => {
    const db = migratedDb();
    try {
      const names = db
        .prepare<[], { name: string }>(`SELECT name FROM conversation_names`)
        .all();
      expect(names.length).toBeGreaterThan(0);
      for (const { name } of names) {
        expect(ConversationNameSchema.safeParse(name).success, name).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('assigns the conversation’s own birth timestamp, not the migration’s clock', () => {
    const db = migratedDb();
    try {
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_names n
               JOIN conversations c ON c.id = n.conversation_id
              WHERE n.assigned_at != c.created_at`,
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('leaves every pre-existing conversations row byte-identical', () => {
    const before = openDbThrough(71);
    let after: Database.Database | null = null;
    try {
      seedV71(before);
      const expected = conversationRows(before);
      after = migratedDb();
      expect(conversationRows(after)).toEqual(expected);
    } finally {
      before.close();
      after?.close();
    }
  });
});

describe('v72 allocation is born valid (#task:2016, B2)', () => {
  it('refuses a target that is not a workspace conversation of THIS workspace', () => {
    const db = migratedDb();
    try {
      const inboxId = db
        .prepare<[], { id: string }>(
          `SELECT id FROM conversations WHERE placement_kind = 'agent_inbox'`,
        )
        .get()!.id;
      // A nonexistent target: what the dropped FK used to refuse.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'ghost', 'no-such-conversation', 1, NULL)`,
        ),
      ).toThrow(/workspace-placed conversation/);
      // An inbox: addressed by its principal, never through a workspace
      // namespace.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'inbox', '${inboxId}', 1, NULL)`,
        ),
      ).toThrow(/workspace-placed conversation/);
      // The one that is an authorization hole rather than dirty data: allocating
      // in `ws_a`'s namespace to a conversation that lives in `ws_b`.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'stolen', 'c_b_design', 1, NULL)`,
        ),
      ).toThrow(/workspace-placed conversation/);
    } finally {
      db.close();
    }
  });

  it('resolves a name only within its own workspace', () => {
    const db = migratedDb();
    try {
      // The resolver's join must conjoin the workspace, not just the id. Both
      // workspaces own the name `design`; joining on id alone would make either
      // row answer for either workspace.
      const resolve = db.prepare<[string, string], { conversation_id: string }>(
        `SELECT n.conversation_id
           FROM conversation_names n
           JOIN conversations c
             ON c.id = n.conversation_id
            AND c.workspace_id = n.workspace_id
            AND c.placement_kind = 'workspace'
          WHERE n.workspace_id = ? AND n.name = ? AND n.retired_at IS NULL`,
      );
      expect(resolve.get('ws_a', 'design')!.conversation_id).toBe('c_design');
      expect(resolve.get('ws_b', 'design')!.conversation_id).toBe('c_b_design');
      // A name allocated in another workspace is simply unknown here — not a
      // hit, and not an error either.
      expect(resolve.get('ws_b', 'ui-ux')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('v72 allocation is permanent (#task:2016, B1)', () => {
  it('refuses every mutation except retirement, as direct SQL', () => {
    const db = migratedDb();
    try {
      const immutable = /allocation is immutable/;
      expect(
        refuses(db, `UPDATE conversation_names SET name = 'design-x' WHERE name = 'design'`),
      ).toThrow(immutable);
      expect(
        refuses(
          db,
          `UPDATE conversation_names SET workspace_id = 'ws_b' WHERE workspace_id = 'ws_a' AND name = 'design'`,
        ),
      ).toThrow(immutable);
      expect(
        refuses(
          db,
          `UPDATE conversation_names SET conversation_id = 'c_mixed' WHERE name = 'design' AND workspace_id = 'ws_a'`,
        ),
      ).toThrow(immutable);
      expect(
        refuses(db, `UPDATE conversation_names SET assigned_at = 999 WHERE name = 'design'`),
      ).toThrow(immutable);
      // Retirement itself is the one legal write.
      db.prepare(
        `UPDATE conversation_names SET retired_at = 1000
          WHERE workspace_id = 'ws_a' AND name = 'design'`,
      ).run();
      // And it happens once: neither resurrection nor a rewritten death stamp.
      expect(
        refuses(
          db,
          `UPDATE conversation_names SET retired_at = NULL WHERE workspace_id = 'ws_a' AND name = 'design'`,
        ),
      ).toThrow(immutable);
      expect(
        refuses(
          db,
          `UPDATE conversation_names SET retired_at = 2000 WHERE workspace_id = 'ws_a' AND name = 'design'`,
        ),
      ).toThrow(immutable);
    } finally {
      db.close();
    }
  });

  it('refuses an ordinary DELETE but lets the namespace go with its workspace', () => {
    const db = migratedDb();
    db.pragma('foreign_keys = ON');
    try {
      expect(
        refuses(db, `DELETE FROM conversation_names WHERE workspace_id = 'ws_a'`),
      ).toThrow(/allocation is permanent/);
      // A workspace's namespace has no meaning without the workspace. When
      // SQLite runs this trigger for an `ON DELETE CASCADE` the parent row is
      // already gone, so the guard admits the cascade and nothing else — the
      // property the single `WHEN EXISTS (workspaces …)` clause rests on.
      db.prepare(`DELETE FROM conversations WHERE workspace_id = 'ws_b'`).run();
      db.prepare(`DELETE FROM workspaces WHERE id = 'ws_b'`).run();
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_names WHERE workspace_id = 'ws_b'`,
          )
          .get()!.n,
      ).toBe(0);
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT count(*) AS n FROM conversation_names WHERE workspace_id = 'ws_a'`,
          )
          .get()!.n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('never lets a retired name be allocated again, to anyone', () => {
    const db = migratedDb();
    try {
      db.prepare(
        `UPDATE conversation_names SET retired_at = 1000
          WHERE workspace_id = 'ws_a' AND name = 'design'`,
      ).run();
      // Not to the conversation that gave it up...
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'design', 'c_design', 2000, NULL)`,
        ),
      ).toThrow(/UNIQUE constraint failed/);
      // ...and not to another conversation in the same namespace either. This is
      // the property the key exists for: the retired row still occupies it.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'design', 'c_mixed', 2000, NULL)`,
        ),
      ).toThrow(/UNIQUE constraint failed/);
      // The retired row keeps its coordinate, so a resolver can name the
      // successor instead of merely reporting "unknown".
      expect(
        db
          .prepare<[], { conversation_id: string }>(
            `SELECT conversation_id FROM conversation_names
              WHERE workspace_id = 'ws_a' AND name = 'design'`,
          )
          .get()!.conversation_id,
      ).toBe('c_design');
    } finally {
      db.close();
    }
  });

  it('allows at most one current name per conversation, which forces retire-then-insert', () => {
    const db = migratedDb();
    try {
      // Single-valuedness — the half the schema really does prove.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'design-later', 'c_design', 2000, NULL)`,
        ),
      ).toThrow(/UNIQUE constraint failed: conversation_names.conversation_id/);
      // Which is why a rename retires first and inserts second, in one
      // transaction. The reverse order cannot even be written.
      db.transaction(() => {
        db.prepare(
          `UPDATE conversation_names SET retired_at = 1000
            WHERE workspace_id = 'ws_a' AND name = 'design'`,
        ).run();
        db.prepare(
          `INSERT INTO conversation_names VALUES ('ws_a', 'design-later', 'c_design', 2000, NULL)`,
        ).run();
      })();
      expect(currentNames(db).c_design).toBe('design-later');
    } finally {
      db.close();
    }
  });
});

describe('v72 an allocation is born current (#task:2016, B2)', () => {
  it('refuses an allocation inserted already retired', () => {
    const db = migratedDb();
    try {
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names VALUES ('ws_a', 'stillborn', 'c_design', 1, 2)`,
        ),
      ).toThrow(/born current/);
      // Not a formatting quibble about `retired_at`: the row would be a name
      // that was never held and can never be held, since the primary key spans
      // retired rows too.
      expect(
        db
          .prepare<[], { n: number }>(
            `SELECT COUNT(*) AS n FROM conversation_names WHERE name = 'stillborn'`,
          )
          .get()!.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is refused by the born-current trigger, which is the ONLY guard that sees it', () => {
    const db = migratedDb();
    try {
      // Fault injection, because the value of a guard is exactly what happens
      // without it. Drop it and the same statement lands — the partial UNIQUE
      // indexes current rows only, and the immutability trigger fires on UPDATE,
      // so neither is watching this door.
      db.exec('DROP TRIGGER trg_conversation_names_born_current');
      const insertRetired = db.prepare(
        `INSERT INTO conversation_names VALUES ('ws_a', ?, 'c_design', 1, 2)`,
      );
      insertRetired.run('phantom-1');
      // And it lands arbitrarily many times for ONE conversation, on top of the
      // current name that conversation legitimately holds — the shape the model
      // says is impossible: a history of retirements that never happened.
      insertRetired.run('phantom-2');
      expect(
        db
          .prepare<[], { name: string }>(
            `SELECT name FROM conversation_names
              WHERE conversation_id = 'c_design' ORDER BY name`,
          )
          .all()
          .map(r => r.name),
      ).toEqual(['design', 'phantom-1', 'phantom-2']);
      // Both names are now permanently unavailable: the DELETE guard keeps them,
      // and the primary key keeps anyone from re-allocating them.
      expect(
        refuses(db, `DELETE FROM conversation_names WHERE name = 'phantom-1'`),
      ).toThrow(/allocation is permanent/);
    } finally {
      db.close();
    }
  });
});

describe('v72 the name domain is a database fact (#task:2016, B1)', () => {
  /** A workspace-placed conversation in an EMPTY namespace, so a probe can
   *  attempt any name against it and meet the CHECK rather than the primary key
   *  (the backfilled workspaces already own several of the names below) or the
   *  partial UNIQUE (this conversation holds no current name). */
  function nameProbeTarget(db: Database.Database): {
    workspaceId: string;
    conversationId: string;
  } {
    db.exec(`
      INSERT INTO workspaces
        (id, name, description, workspace_kind, owner_agent_id,
         archived_at, pinned_at, created_at, updated_at, owner_user_id)
      VALUES ('ws_probe', 'Probe', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1');
      INSERT INTO conversations
        (id, workspace_id, placement_kind, roster_policy, title, status,
         spawned_by_agent_id, closed_at, close_summary, pinned_at,
         created_at, updated_at, archived_at, latest_message_seq, visibility)
      VALUES ('c_probe', 'ws_probe', 'workspace', 'open', 'Probe', 'idle',
              NULL, NULL, NULL, NULL, 900, 900, NULL, 0, 'private');
    `);
    return { workspaceId: 'ws_probe', conversationId: 'c_probe' };
  }


  // Every case the DB must decide, with the JS schema as the oracle. GLOB's own
  // metacharacters are in here on purpose: `*`, `?` and `[` are the characters a
  // transcription is most likely to mis-handle, and `[` in particular would open
  // an unterminated set if the negated class were written carelessly.
  const CORPUS = [
    'x',
    'roadmap',
    'ui-ux_2',
    'a1',
    'channel-2026-roadmap',
    'a'.repeat(64),
    '',
    'Roadmap',
    'ROADMAP',
    'road map',
    'road\tmap',
    '-roadmap',
    '_roadmap',
    '9roadmap',
    'roadmap-',
    'roadmap_',
    'road.map',
    'road/map',
    'road*map',
    'road?map',
    'road[map',
    'a'.repeat(65),
    '优化',
    'design🎨',
  ];

  it('admits exactly the names ConversationNameSchema admits', () => {
    const db = migratedDb();
    try {
      const target = nameProbeTarget(db);
      const insert = db.prepare(
        `INSERT INTO conversation_names
           VALUES ('${target.workspaceId}', ?, '${target.conversationId}', 1, NULL)`,
      );
      // One probe per name, each rolled back, so the namespace stays clean and a
      // second admissible name never meets the primary key instead of the CHECK.
      // What is being compared is the DECISION, not the error text: two
      // transcriptions of one grammar (a regex and a GLOB expression) can only be
      // trusted if something asserts they classify the same set. A rejection for
      // any OTHER reason is recorded too — that is what caught this probe
      // colliding with a backfilled name and reading it as a grammar refusal.
      const disagreements: string[] = [];
      for (const name of CORPUS) {
        const admissible = ConversationNameSchema.safeParse(name).success;
        db.exec('SAVEPOINT probe');
        let accepted = true;
        let reason = '';
        try {
          insert.run(name);
        } catch (err) {
          accepted = false;
          reason = err instanceof Error ? err.message : String(err);
        }
        db.exec('ROLLBACK TO probe');
        db.exec('RELEASE probe');
        if (accepted !== admissible) {
          disagreements.push(
            `${JSON.stringify(name)}: db=${accepted} schema=${admissible}`,
          );
        } else if (!accepted && !/CHECK constraint failed/.test(reason)) {
          disagreements.push(
            `${JSON.stringify(name)}: refused, but not by the CHECK: ${reason}`,
          );
        }
      }
      expect(disagreements).toEqual([]);
      // The corpus must actually exercise both answers, or the loop above is
      // vacuous.
      expect(
        CORPUS.filter(n => ConversationNameSchema.safeParse(n).success).length,
      ).toBeGreaterThan(0);
      expect(
        CORPUS.filter(n => !ConversationNameSchema.safeParse(n).success).length,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('refuses an unspellable name as direct SQL, so the refusal survives the writer', () => {
    const db = migratedDb();
    try {
      const target = nameProbeTarget(db);
      // The point of the CHECK rather than only a repo assertion: an address
      // outside the grammar cannot be referenced by anyone and cannot be
      // released, so the one place the rule must hold is the place no future
      // caller can bypass.
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names
             VALUES ('${target.workspaceId}', 'Design', '${target.conversationId}', 1, NULL)`,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(
        refuses(
          db,
          `INSERT INTO conversation_names
             VALUES ('${target.workspaceId}', '42', '${target.conversationId}', 1, NULL)`,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(currentNames(db)[target.conversationId]).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
