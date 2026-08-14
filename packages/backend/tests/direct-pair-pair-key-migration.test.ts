import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '@silverhand/shared/db/migrations';
import { canonicalEndpointOrder } from '@silverhand/shared';

// Migration v74 (direct_pair_pair_key) falsifiers —
// agent-scoped-session-v1 §4.2 / §8 P3 (#task:2020).
//
// v73 gave the DirectPair placement its two endpoints; v74 turns that pair into
// the aggregate's NAME. Three claims carry the feature, and each of them is a
// database claim:
//
//   (1) The KEY IS A CONTRACT, so its bytes are pinned here as literals rather
//       than recomputed by the test. P0-f keys the task-board numbering space on
//       `'pair:' || pair_key`, so a future edit to the expression would silently
//       renumber a board that already exists. `a2:a1h2:u2` is not an
//       implementation detail — it is the format, and a test that derived the
//       expectation from the same rule as the schema could not detect a change
//       to it.
//   (2) The KEY IS INJECTIVE on the endpoint domain, which is the property the
//       uniqueness index is only worth anything under: two DISTINCT pairs sharing
//       a key would mean two DMs sharing one identity (and one task board). It is
//       proved the only way injectivity can be, by exhibiting a LEFT INVERSE — a
//       decoder that recovers the four coordinates from the bytes — and running
//       it over a corpus built to break naive formats: ids containing the
//       delimiter, ids that are pure digits, an id shared by a human and an agent,
//       and the concatenation-collision pair that a delimiter-free format maps to
//       one string. The last one is ALSO run against a sacrificial table carrying
//       that naive expression, so "the unique index would catch it" is a
//       demonstration and not an assurance.
//   (3) The KEY IS NOT WRITABLE, and not by convention: `GENERATED ALWAYS AS`
//       makes both the UPDATE and the INSERT a PARSE-TIME refusal, which is why
//       v74 adds no trigger to forget. VIRTUAL (not STORED) is what lets
//       `ADD COLUMN` do it, so v74 is the first placement migration that is NOT a
//       table rebuild — asserted through the absence of `foreignKeyEscape` and
//       through v73's guards surviving untouched.
//
// No fault injection in this file can produce a REAL collision, and that is the
// point: with (2) proved, a collision is unreachable, so what the `pair_key`
// unique index defends against is a future EDIT to the expression. The
// sacrificial-table probe is how that defense is shown to work without shipping
// a broken expression to prove it.
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

/** The principals every endpoint below names. Seeded at v74 rather than at v72,
 *  because v74 migrates no data: unlike v69/v71/v73 there is nothing for a
 *  pre-existing row to be carried ACROSS, so the fixture only has to be legal at
 *  the version under test. `u1` authors nothing here, so both users stay
 *  deletable — the tombstone half of the model is v73's file, not this one. */
function seedPrincipals(db: Database.Database): void {
  db.exec(`
    INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'local', 'local', 1);
    INSERT INTO users (id, name, display_name, created_at, updated_at)
      VALUES ('u1', 'u1', 'U One', 1, 1),
             ('u2', 'u2', 'U Two', 1, 1);
    INSERT INTO agents
      (id, name, runtime, model, host_id, description, created_at, updated_at,
       display_name, reasoning_effort, fast_mode, created_by_user_id)
    VALUES
      ('a1', 'a1', 'claude', NULL, 'h1', NULL, 1, 1, 'A One', NULL, NULL, 'u1'),
      ('a2', 'a2', 'claude', NULL, 'h1', NULL, 1, 1, 'A Two', NULL, NULL, 'u1');
    INSERT INTO workspaces
      (id, name, description, workspace_kind, owner_agent_id,
       archived_at, pinned_at, created_at, updated_at, owner_user_id)
    VALUES ('ws_reg', 'regular', NULL, 'regular', NULL, NULL, NULL, 1, 1, 'u1');
  `);
}

/** One row of each OTHER placement, so every "NULL exactly when not
 *  `direct_pair`" claim is asked of rows that actually exist. */
function seedOtherPlacements(db: Database.Database): void {
  db.exec(`
    INSERT INTO conversations
      (id, workspace_id, inbox_agent_id, placement_kind, roster_policy, title,
       status, created_at, updated_at, visibility)
    VALUES
      ('c_chan', 'ws_reg', NULL, 'workspace', 'open', 'general',
       'idle', 100, 100, 'public'),
      ('c_inbox_a1', NULL, 'a1', 'agent_inbox', 'fixed', 'Inbox',
       'idle', 300, 300, 'private');
  `);
}

const INSERT_PAIR = `
  INSERT INTO conversations
    (id, placement_kind, roster_policy,
     endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id,
     title, status, visibility, created_at, updated_at)
  VALUES
    (@id, 'direct_pair', 'fixed', @a_kind, @a_id, @b_kind, @b_id,
     '', 'idle', 'private', 1, 1)`;

interface Endpoint {
  kind: 'agent' | 'human';
  id: string;
}

function openV74(): Database.Database {
  const db = openDbThrough(74);
  seedPrincipals(db);
  seedOtherPlacements(db);
  return db;
}

function insertPair(db: Database.Database, id: string, a: Endpoint, b: Endpoint): void {
  db.prepare(INSERT_PAIR).run({
    id,
    a_kind: a.kind,
    a_id: a.id,
    b_kind: b.kind,
    b_id: b.id,
  });
}

function pairKeyOf(db: Database.Database, id: string): string | null {
  return (
    db
      .prepare<[string], { pair_key: string | null }>(
        `SELECT pair_key FROM conversations WHERE id = ?`,
      )
      .get(id)?.pair_key ?? null
  );
}

/**
 * The LEFT INVERSE of the v74 expression: recover the two endpoint coordinates
 * from the key. Its existence is the injectivity proof — if `decode(encode(p))`
 * is `p` for every `p`, then `encode` cannot map two pairs to one key.
 *
 * It reads exactly what the format writes, in the format's own terms: one kind
 * INITIAL, then the decimal length up to the FIRST `:`, then exactly that many
 * CHARACTERS. Characters, not UTF-16 units — SQLite's `length()` counts code
 * points, so the decoder splits with `Array.from` to speak the same unit the
 * encoder counted in. (Pinned by the astral-id row of the corpus: with `.length`
 * here, that row would over-read and the round trip would fail.)
 *
 * A parse failure THROWS rather than returning null: a key that cannot be decoded
 * is a broken format, and the corpus test must report which pair produced it, not
 * a bare `toEqual` mismatch.
 */
function decodePairKey(key: string): readonly [Endpoint, Endpoint] {
  const chars = Array.from(key);
  let at = 0;
  const one = (): Endpoint => {
    const initial = chars[at++];
    const kind = initial === 'a' ? 'agent' : initial === 'h' ? 'human' : null;
    if (kind === null) {
      throw new Error(`pair_key ${JSON.stringify(key)}: kind initial ${initial} is outside the closed enum`);
    }
    let digits = '';
    while (at < chars.length && chars[at] !== ':') digits += chars[at++];
    if (chars[at] !== ':' || digits === '' || !/^\d+$/.test(digits)) {
      throw new Error(`pair_key ${JSON.stringify(key)}: no length prefix at offset ${at}`);
    }
    at += 1;
    const length = Number(digits);
    const id = chars.slice(at, at + length).join('');
    if (Array.from(id).length !== length) {
      throw new Error(`pair_key ${JSON.stringify(key)}: length prefix ${length} over-reads the key`);
    }
    at += length;
    return { kind, id };
  };
  const a = one();
  const b = one();
  if (at !== chars.length) {
    throw new Error(`pair_key ${JSON.stringify(key)}: ${chars.length - at} trailing characters`);
  }
  return [a, b];
}

function countWhere(db: Database.Database, table: string, predicate: string): number {
  return db
    .prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${predicate}`)
    .get()!.n;
}

const V73_TRIGGERS = [
  'trg_conversations_endpoints_birth',
  'trg_conversations_endpoints_born_alive',
  'trg_conversations_endpoints_immutable',
  'trg_conversations_endpoint_tombstone_monotonic',
  'trg_agents_stamp_endpoint_deleted',
  'trg_users_stamp_endpoint_deleted',
];

function schemaSql(db: Database.Database, name: string): string {
  const row = db
    .prepare<[string], { sql: string }>(`SELECT sql FROM sqlite_master WHERE name = ?`)
    .get(name);
  return (row?.sql ?? '').replace(/\s+/g, ' ').trim();
}

describe('migration v74 pair_key — shape of the migration itself', () => {
  it('is an ADD COLUMN, so it declares no FK escape and no precondition', () => {
    const v74 = migrations.find(m => m.version === 74);
    expect(v74).toBeDefined();
    expect(v74!.name).toBe('direct_pair_pair_key');
    // The ABSENCE is the contract: `foreignKeyEscape` exists to stop
    // `DROP TABLE conversations` from cascading the children away, and needing it
    // means a rebuild happened. v74 must not be one — a rebuild would have to
    // re-declare v73's four guards and both stamping triggers, which is exactly
    // the risk `GENERATED … VIRTUAL` buys its way out of.
    expect(v74!.foreignKeyEscape).toBeUndefined();
    expect(v74!.precondition).toBeUndefined();
  });

  it('leaves every v73 guard and index in place', () => {
    const db = openV74();
    try {
      const triggers = db
        .prepare<[], { name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`,
        )
        .all()
        .map(t => t.name);
      expect(triggers).toEqual(expect.arrayContaining(V73_TRIGGERS));
      // …and they still REFUSE, not merely exist: a rebuild that dropped the
      // trigger bodies would keep the names if it recreated them wrongly.
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      expect(() =>
        db.prepare(`UPDATE conversations SET endpoint_a_id = 'a2' WHERE id = 'dp'`).run(),
      ).toThrow(/endpoint coordinates are immutable/);
      expect(() =>
        insertPair(db, 'ghost', { kind: 'agent', id: 'nobody' }, { kind: 'human', id: 'u2' }),
      ).toThrow(/must name an existing principal/);
    } finally {
      db.close();
    }
  });

  it('adds both partial UNIQUE indexes and keeps `pair_key` hidden from `table_info`', () => {
    const db = openV74();
    try {
      // Two indexes for two different jobs: the endpoint tuple is the IDENTITY
      // constraint and the get-or-create LOOKUP PATH (so no TypeScript ever has to
      // re-implement the byte format to find a pair), while the `pair_key` index
      // is what makes injectivity DB-enforced.
      expect(schemaSql(db, 'idx_conversations_direct_pair_endpoints')).toContain(
        `WHERE placement_kind = 'direct_pair'`,
      );
      expect(schemaSql(db, 'idx_conversations_pair_key')).toContain(
        `WHERE placement_kind = 'direct_pair'`,
      );
      // A VIRTUAL generated column is `hidden: 2` and absent from `table_info`,
      // exactly like the table's `kind`. That is what keeps `SELECT *` writers
      // (and the DTO strippers) from ever seeing it as an input column.
      expect(
        db.prepare<[], { name: string }>('PRAGMA table_info(conversations)').all().map(c => c.name),
      ).not.toContain('pair_key');
      expect(
        db
          .prepare<[], { name: string; hidden: number }>('PRAGMA table_xinfo(conversations)')
          .all()
          .find(c => c.name === 'pair_key'),
      ).toMatchObject({ hidden: 2, type: 'TEXT' });
    } finally {
      db.close();
    }
  });
});

describe('migration v74 pair_key — the bytes are the contract', () => {
  it('encodes the locked format, literal for literal', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      insertPair(db, 'dp2', { kind: 'agent', id: 'a1' }, { kind: 'agent', id: 'a2' });
      // `<kind-initial><char-length>:<id>`, a-side then b-side. Written out here
      // as the literal a future reader can diff against P0-f's stored
      // `board_key`; deriving it from the rule would make this test agree with
      // any change to the rule.
      expect(pairKeyOf(db, 'dp')).toBe('a2:a1h2:u2');
      expect(pairKeyOf(db, 'dp2')).toBe('a2:a1a2:a2');
    } finally {
      db.close();
    }
  });

  it('is NULL exactly when the placement is not `direct_pair`', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      // Not "NULL for the two rows we happen to have": the CASE guard makes
      // `pair_key IS NULL` and `placement_kind <> 'direct_pair'` the SAME SET, so
      // a caller may treat the scalar as the discriminator it looks like.
      expect(
        countWhere(
          db,
          'conversations',
          `(pair_key IS NULL) <> (placement_kind <> 'direct_pair')`,
        ),
      ).toBe(0);
      expect(countWhere(db, 'conversations', `pair_key IS NULL`)).toBe(2);
      expect(pairKeyOf(db, 'c_chan')).toBeNull();
      expect(pairKeyOf(db, 'c_inbox_a1')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses to be written, at parse time, on both INSERT and UPDATE', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      // `prepare` throws, not `run`: there is no statement that writes this
      // column, so no trigger has to be remembered and no code path has to be
      // trusted. This is the acceptance criterion "endpoint / pair_key UPDATE
      // 被 DB 拒" in its strongest available form.
      expect(() =>
        db.prepare(`UPDATE conversations SET pair_key = 'x' WHERE id = 'dp'`),
      ).toThrow(/cannot UPDATE generated column/i);
      expect(() =>
        db.prepare(
          `INSERT INTO conversations
             (id, placement_kind, roster_policy, endpoint_a_kind, endpoint_a_id,
              endpoint_b_kind, endpoint_b_id, pair_key,
              title, status, visibility, created_at, updated_at)
           VALUES ('x', 'direct_pair', 'fixed', 'agent', 'a2', 'human', 'u2', 'forged',
                   '', 'idle', 'private', 1, 1)`,
        ),
      ).toThrow(/cannot INSERT into generated column/i);
      // The key still says what the coordinates say.
      expect(pairKeyOf(db, 'dp')).toBe('a2:a1h2:u2');
    } finally {
      db.close();
    }
  });
});

describe('migration v74 pair_key — uniqueness', () => {
  it('refuses a second row with the same endpoint tuple', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      expect(() =>
        insertPair(db, 'dp_again', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(countWhere(db, 'conversations', `placement_kind = 'direct_pair'`)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('carries concurrent get-or-create through ON CONFLICT on the partial index', () => {
    const db = openV74();
    try {
      const insert = (id: string) =>
        db
          .prepare(
            `${INSERT_PAIR}
             ON CONFLICT (endpoint_a_kind, endpoint_a_id, endpoint_b_kind, endpoint_b_id)
               WHERE placement_kind = 'direct_pair'
               DO NOTHING`,
          )
          .run({ id, a_kind: 'agent', a_id: 'a1', b_kind: 'human', b_id: 'u2' });
      // The loser of the race is a NO-OP that then reads the winner's row: this
      // is why the aggregate needs no retry loop and no application lock. The
      // partial index is a legal conflict target only when the statement repeats
      // its WHERE clause, which is the half a hand-written upsert forgets.
      expect(insert('dp_first').changes).toBe(1);
      expect(insert('dp_second').changes).toBe(0);
      expect(countWhere(db, 'conversations', `placement_kind = 'direct_pair'`)).toBe(1);
      expect(countWhere(db, 'conversations', `id = 'dp_first'`)).toBe(1);
      expect(countWhere(db, 'conversations', `id = 'dp_second'`)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('refuses the reversed pair, so normalization is the only way in', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      // v73's canonical-order CHECK, re-asserted here because it is what makes
      // ONE unique index enough: without it `(x, y)` and `(y, x)` would be two
      // rows with two keys, and uniqueness would be satisfied by both.
      expect(() =>
        insertPair(db, 'dp_rev', { kind: 'human', id: 'u2' }, { kind: 'agent', id: 'a1' }),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('finds a pair by its four coordinates through the index, not a scan', () => {
    const db = openV74();
    try {
      insertPair(db, 'dp', { kind: 'agent', id: 'a1' }, { kind: 'human', id: 'u2' });
      // The get-or-create lookup path. If this ever degrades to a table scan the
      // format would be the cheaper way to look a pair up, and the TypeScript
      // copy of the byte format this feature refuses to have would start to look
      // reasonable.
      const plan = db
        .prepare<[string, string, string, string], { detail: string }>(
          `EXPLAIN QUERY PLAN
             SELECT id FROM conversations
              WHERE placement_kind = 'direct_pair'
                AND endpoint_a_kind = ? AND endpoint_a_id = ?
                AND endpoint_b_kind = ? AND endpoint_b_id = ?`,
        )
        .all('agent', 'a1', 'human', 'u2')
        .map(r => r.detail)
        .join(' | ');
      expect(plan).toContain('idx_conversations_direct_pair_endpoints');
      expect(plan).not.toContain('SCAN');
      // P0-f's own read — board by key — is an index seek too.
      const byKey = db
        .prepare<[string], { detail: string }>(
          `EXPLAIN QUERY PLAN
             SELECT id FROM conversations
              WHERE placement_kind = 'direct_pair' AND pair_key = ?`,
        )
        .all('a2:a1h2:u2')
        .map(r => r.detail)
        .join(' | ');
      expect(byKey).toContain('idx_conversations_pair_key');
      expect(byKey).not.toContain('SCAN');
    } finally {
      db.close();
    }
  });
});

/** Ids chosen to break every cheaper format: the delimiter itself, a pure-digit
 *  id that a length prefix could be confused with, a leading-digit id, an id
 *  shared by BOTH principal kinds (so only the kind initial separates the two
 *  pairs), an astral character (SQLite counts code points, JS `.length` does not),
 *  and the two ids whose naive concatenation collides. */
const ADVERSARIAL_IDS = [
  ':',
  '3:x',
  '12',
  '9',
  'shared',
  `${String.fromCodePoint(0x1f600)}x`,
  'xh',
  'x',
  'h9',
  // The two ids the UTF-16 and UTF-8 orders DISAGREE about: a lone noncharacter
  // U+FFFF and an astral code point. They are in the corpus, not in a special
  // case, because the corpus inserts every pair through `canonicalEndpointOrder`
  // and the v73 CHECK judges the result — so a comparator that disagreed with
  // SQLite's BINARY collation anywhere in here fails the corpus test outright
  // instead of being documented as a loud abort. Built with `fromCodePoint`, never
  // as literals: a noncharacter or an astral pair in a source file is exactly the
  // bytes a later editor or diff tool silently normalizes away.
  String.fromCodePoint(0xffff),
  String.fromCodePoint(0x1f600),
];

describe('migration v74 pair_key — injectivity on the endpoint domain', () => {
  /** Every adversarial id, minted as BOTH an agent and a user, so a corpus pair
   *  can name the same string under either kind. Names must stay unique while ids
   *  are the interesting part, hence the index-derived name. */
  function seedAdversarialPrincipals(db: Database.Database): void {
    const agent = db.prepare(
      `INSERT INTO agents
         (id, name, runtime, model, host_id, description, created_at, updated_at,
          display_name, reasoning_effort, fast_mode, created_by_user_id)
       VALUES (?, ?, 'claude', NULL, 'h1', NULL, 1, 1, ?, NULL, NULL, 'u1')`,
    );
    const user = db.prepare(
      `INSERT INTO users (id, name, display_name, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1)`,
    );
    ADVERSARIAL_IDS.forEach((id, i) => {
      agent.run(id, `adv_agent_${i}`, `adv_agent_${i}`);
      user.run(id, `adv_user_${i}`, `adv_user_${i}`);
    });
  }

  it('round-trips every pair in an adversarial corpus and gives each a distinct key', () => {
    const db = openV74();
    try {
      seedAdversarialPrincipals(db);
      // The corpus is every unordered pair of {agent, human} × ADVERSARIAL_IDS,
      // normalized the way the aggregate normalizes. `canonicalEndpointOrder`
      // rejects the self-pairs, which is why they are filtered rather than caught.
      const candidates: Endpoint[] = (['agent', 'human'] as const).flatMap(kind =>
        ADVERSARIAL_IDS.map(id => ({ kind, id })),
      );
      const pairs: Array<readonly [Endpoint, Endpoint]> = [];
      for (const [i, left] of candidates.entries()) {
        for (const right of candidates.slice(i + 1)) {
          const [a, b] = canonicalEndpointOrder(left, right);
          pairs.push([a as Endpoint, b as Endpoint]);
        }
      }
      expect(pairs.length).toBe((candidates.length * (candidates.length - 1)) / 2);

      const keys = new Map<string, readonly [Endpoint, Endpoint]>();
      pairs.forEach(([a, b], i) => {
        insertPair(db, `corpus_${i}`, a, b);
        const key = pairKeyOf(db, `corpus_${i}`);
        expect(key, `pair ${JSON.stringify([a, b])} produced no key`).not.toBeNull();
        // THE PROOF: the decoder is a left inverse on this pair. Distinctness of
        // the keys follows from it, and is asserted as well so a failure says
        // WHICH property broke — a collision reports the two colliding pairs
        // instead of a bare count mismatch.
        expect(decodePairKey(key!)).toEqual([a, b]);
        const clash = keys.get(key!);
        expect(
          clash,
          `key ${JSON.stringify(key)} is shared by ${JSON.stringify(clash)} and ${JSON.stringify([a, b])}`,
        ).toBeUndefined();
        keys.set(key!, [a, b]);
      });
      expect(keys.size).toBe(pairs.length);
    } finally {
      db.close();
    }
  });

  it('separates the pair a delimiter-free format collides, and that format is caught by the index', () => {
    const db = openV74();
    try {
      seedAdversarialPrincipals(db);
      // `agent:'xh' ↔ human:'y'` and `agent:'x' ↔ human:'hy'` are DIFFERENT DMs
      // that a kind-initial-concatenation format (`a`||id||`h`||id) maps to the
      // one string `axhhy`, because an id may contain the letters the initials use.
      insertPair(db, 'dp_xh', { kind: 'agent', id: 'xh' }, { kind: 'human', id: '9' });
      insertPair(db, 'dp_x', { kind: 'agent', id: 'x' }, { kind: 'human', id: 'h9' });
      expect(pairKeyOf(db, 'dp_xh')).toBe('a2:xhh1:9');
      expect(pairKeyOf(db, 'dp_x')).toBe('a1:xh2:h9');

      // …and if a future edit DID drop the length prefix, the `pair_key` unique
      // index is what turns that into a failed write instead of two DMs sharing a
      // task board. Demonstrated on a sacrificial table rather than by shipping
      // the broken expression: the point is that the index does the catching, and
      // the index is the same shape.
      db.exec(`
        CREATE TABLE probe_pairs (
          id TEXT PRIMARY KEY,
          a_kind TEXT, a_id TEXT, b_kind TEXT, b_id TEXT,
          naive_key TEXT GENERATED ALWAYS AS (
            substr(a_kind, 1, 1) || a_id || substr(b_kind, 1, 1) || b_id
          ) VIRTUAL
        );
        CREATE UNIQUE INDEX probe_pairs_key ON probe_pairs(naive_key);
        INSERT INTO probe_pairs (id, a_kind, a_id, b_kind, b_id)
          VALUES ('p1', 'agent', 'xh', 'human', 'y');
      `);
      expect(() =>
        db
          .prepare(
            `INSERT INTO probe_pairs (id, a_kind, a_id, b_kind, b_id)
             VALUES ('p2', 'agent', 'x', 'human', 'hy')`,
          )
          .run(),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      db.close();
    }
  });

  it('normalizes the UTF-16/UTF-8 disagreement into a pair the DB ACCEPTS, from either input order', () => {
    const db = openV74();
    try {
      // The pair the two orders disagree about: a lone U+FFFF sorts BELOW an
      // astral character in UTF-8 (SQLite BINARY) and ABOVE it in UTF-16 (JS `<`).
      // Both principals are legal and both endpoint tuples are legal, so the ONLY
      // acceptable outcome is a working DM — @Cindy's B1: a comparator that
      // disagreed here would leave a legal pair permanently unable to have one,
      // and "the CHECK aborts loudly" would be describing that hole, not closing
      // it. Ids via `fromCodePoint` for the reason given at ADVERSARIAL_IDS.
      const low = { kind: 'agent', id: String.fromCodePoint(0xffff) } as const;
      const high = { kind: 'agent', id: String.fromCodePoint(0x1f600) } as const;
      for (const [id, name] of [
        [low.id, 'adv_low'],
        [high.id, 'adv_high'],
      ] as const) {
        db.prepare(
          `INSERT INTO agents
             (id, name, runtime, model, host_id, description, created_at, updated_at,
              display_name, reasoning_effort, fast_mode, created_by_user_id)
           VALUES (?, ?, 'claude', NULL, 'h1', NULL, 1, 1, ?, NULL, NULL, 'u1')`,
        ).run(id, name, name);
      }

      // Naive JS `<` would have put the astral id first. That is the order SQLite
      // refuses, and asserting it here is what keeps `compareEndpointText` from
      // looking like a redundant wrapper: revert it to `<` and this line still
      // passes while the two below fail.
      expect(high.id < low.id).toBe(true);

      // Both INPUT orders normalize to the same accepted tuple…
      const forward = canonicalEndpointOrder(low, high);
      const reverse = canonicalEndpointOrder(high, low);
      expect(forward.map(e => e.id)).toEqual([low.id, high.id]);
      expect(reverse.map(e => e.id)).toEqual([low.id, high.id]);

      // …and that tuple INSERTS. No CHECK abort: the pair has a DM.
      insertPair(db, 'dp_astral', forward[0] as Endpoint, forward[1] as Endpoint);
      const key = pairKeyOf(db, 'dp_astral');
      expect(key).not.toBeNull();
      expect(decodePairKey(key!)).toEqual([forward[0], forward[1]]);
      // The second call is the same aggregate, refused by the UNIQUE index rather
      // than by the arc CHECK — "same row", not "second row rejected for the wrong
      // reason". `ON CONFLICT … DO NOTHING` is how get-or-create sees it: no error,
      // no second row.
      expect(() =>
        insertPair(db, 'dp_astral_again', reverse[0] as Endpoint, reverse[1] as Endpoint),
      ).toThrow(/UNIQUE constraint failed/);
      expect(countWhere(db, 'conversations', `placement_kind = 'direct_pair'`)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('refuses an endpoint id that has no UTF-8 encoding instead of mis-ordering it', () => {
    // A lone surrogate is the one string where code-point order stops being UTF-8
    // byte order, because there ARE no UTF-8 bytes for it: the driver would store a
    // replacement character and the row's id would no longer be the caller's id.
    // Refused at the boundary where the caller is still visible, so the coordinate
    // can never be silently rewritten.
    //
    // EVERY POSITION, not just the one the comparison happens to look at (@Cindy
    // B1.1). Refusal is a property of the input, so each case below fixes a
    // DIFFERENT reason the comparison would have stopped early, and the surrogate
    // sits where that stop leaves it unread. `\ud800` written as an escape, never
    // as a real byte.
    const surrogate = String.fromCodePoint(0xd800);
    const cases: ReadonlyArray<
      readonly [string, { kind: 'agent' | 'human'; id: string }, { kind: 'agent' | 'human'; id: string }]
    > = [
      // 1. First character: the case that was already covered — the loop's very
      //    first comparison reads it.
      ['leading', { kind: 'agent', id: surrogate }, { kind: 'agent', id: 'a1' }],
      // 2. PAST THE COMMON PREFIX: one id is a prefix of the other, so the order
      //    follows from the LENGTHS and no character past the prefix is ever
      //    compared. `'a'` vs `'a\ud800'`.
      ['past the common prefix', { kind: 'agent', id: 'a' }, { kind: 'agent', id: `a${surrogate}` }],
      // 3. PAST THE FIRST DIFFERENCE: the ids differ at index 0, so a comparison
      //    that returns as soon as it can never reaches index 1. `'a\ud800'` vs 'b'.
      ['past the first difference', { kind: 'agent', id: `a${surrogate}` }, { kind: 'agent', id: 'b' }],
      // 4. BEHIND THE KIND SHORT-CIRCUIT: different kinds settle the order without
      //    consulting either id at all — and that is EVERY human↔agent DM, i.e. the
      //    most reachable path in the product, not an exotic one.
      ['behind the kind short-circuit', { kind: 'agent', id: surrogate }, { kind: 'human', id: 'u1' }],
    ];
    for (const [where, left, right] of cases) {
      // Both argument orders: validation must not depend on which side the caller
      // passed the bad id on.
      expect(() => canonicalEndpointOrder(left, right), where).toThrow(/valid Unicode/);
      expect(() => canonicalEndpointOrder(right, left), where).toThrow(/valid Unicode/);
    }

    // …and the refusal is SPECIFIC: a legal astral id in the same positions still
    // orders fine, so the guard cannot be satisfied by refusing everything
    // non-ASCII (which would take the DM away from a legal pair — B1's hole).
    const astral = String.fromCodePoint(0x1f600);
    expect(
      canonicalEndpointOrder(
        { kind: 'agent', id: `a${astral}` },
        { kind: 'human', id: 'u1' },
      ).map(e => e.id),
    ).toEqual([`a${astral}`, 'u1']);
  });
});
