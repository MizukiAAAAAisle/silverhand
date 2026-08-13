/**
 * Gate 7 — driver-dialect decoding.
 *
 * SQLite error codes, the driver's `... constraint failed: ...` message shape
 * and the schema's trigger text are DIALECT. Reading them is how an engine
 * detail leaks upward into decisions: a route that branches on
 * `SQLITE_CONSTRAINT_UNIQUE` has silently made the driver part of its contract.
 * Decoding is therefore confined to an EXACT file set — the schema modules that
 * define trigger text, the one error-translation module, and the adapters whose
 * job is turning a driver failure into a domain result or a metric label. No
 * directory-level waiver exists: every file × signal is a ledger row.
 *
 * The trigger-message authority is HARVESTED from the schema modules'
 * `RAISE(ABORT, '...')` literals, so a newly added trigger message is fenced
 * without anyone remembering to list it.
 *
 * Coverage boundary: only string/template/regex LITERALS are inspected, never
 * comments — documenting the driver's message shape is not decoding it.
 */
import { describe, expect, it } from 'vitest';
import { harvestTriggerMessages, scanDriverDialect, type DialectSignal } from './scan.js';
import { DIALECT_DECODING_INVENTORY, SQL_CALLER_INVENTORY } from './inventory.js';
import { adapterInternalViolations, zoneSurfaceViolations } from './zones.js';
import { allProductionSources, asInventoryLines } from './sources.js';

/** The schema modules that DEFINE trigger text; also the harvest source. */
const SCHEMA_AUTHORITY = [
  'packages/shared/src/db/baseline-schema.ts',
  'packages/shared/src/db/migrations.ts',
];

describe('db-boundary: driver-dialect decoding', () => {
  const sources = allProductionSources();
  const schemaSources = sources.filter(e => SCHEMA_AUTHORITY.includes(e.path));
  const triggerMessages = harvestTriggerMessages(schemaSources);
  const findings = sources.flatMap(e => scanDriverDialect(e, triggerMessages));

  it('the trigger-message authority is non-empty (the harvest cannot vacuously pass)', () => {
    expect(schemaSources.map(e => e.path).sort()).toEqual([...SCHEMA_AUTHORITY].sort());
    expect(triggerMessages.length).toBeGreaterThan(20);
    expect(triggerMessages.some(m => m.includes('collides with an existing'))).toBe(true);
  });

  it('every dialect-decoding site matches the ledger exactly', () => {
    // Keyed as a nested map (file -> signal -> count) rather than a joined
    // string: neither a path nor a signal should ever need a separator
    // character, and a source file must stay plain text for review tooling.
    const byFile = new Map<string, Map<DialectSignal, number>>();
    for (const f of findings) {
      const perSignal = byFile.get(f.file) ?? new Map<DialectSignal, number>();
      perSignal.set(f.signal, (perSignal.get(f.signal) ?? 0) + 1);
      byFile.set(f.file, perSignal);
    }
    const actual = [...byFile.entries()]
      .flatMap(([file, perSignal]) =>
        [...perSignal.entries()].map(([signal, count]) => ({ file, signal, count })),
      )
      .sort((a, b) => (a.file + a.signal < b.file + b.signal ? -1 : 1));
    const expected = DIALECT_DECODING_INVENTORY.map(e => ({
      file: e.file,
      signal: e.signal,
      count: e.count,
    })).sort((a, b) => (a.file + a.signal < b.file + b.signal ? -1 : 1));
    expect(
      actual,
      'driver-dialect decoding drifted from the ledger. Fewer sites: delete/decrement the row (celebrated). ' +
        'A NEW file decoding dialect is refused — translate the driver failure at the persistence boundary and ' +
        'return a domain outcome instead. Current tree state:\n' +
        asInventoryLines(actual),
    ).toEqual(expected);
  });

  it('every ledger row names its zone and why decoding belongs there', () => {
    const empty = DIALECT_DECODING_INVENTORY.filter(e => !e.reason.trim());
    expect(empty.map(e => `${e.file}:${e.signal}`)).toEqual([]);
    const keys = DIALECT_DECODING_INVENTORY.map(e => `${e.file}:${e.signal}`);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it('a decoding zone is bound to its owner surface, and the adapter arm must own the SQL (#task:1983 W8)', () => {
    // Two ways a label could have bought dialect decoding, both closed here.
    // First: any file that added a row could call itself `error-translation`.
    // That zone is now exactly the two dedicated modules, by path.
    expect(
      zoneSurfaceViolations(DIALECT_DECODING_INVENTORY, 'dialect'),
      'a dialect row claims a zone it is not on. Deciding on driver codes or constraint text makes the engine ' +
        'part of that module contract — translate at the persistence boundary and return a domain outcome',
    ).toEqual([]);
    // Second: `adapter-internal` could have become a waiver for the whole of
    // `src/repos/`. It is a claim that the file is the adapter for the very
    // constraint it decodes, so it is checked against the SQL-sink ledger.
    expect(
      adapterInternalViolations(
        DIALECT_DECODING_INVENTORY,
        SQL_CALLER_INVENTORY.map(e => e.file),
      ),
      'an adapter-internal row does not own the SQL it claims to translate',
    ).toEqual([]);
  });

  it('fence self-test: real decoding is detected in every form', () => {
    const triggers = ['users.name collides with an existing agent name'];
    const probes: Array<[string, DialectSignal, string]> = [
      ['error-code equality', 'sqlite_error_code', "if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return 'dup';"],
      ['error-code prefix', 'sqlite_error_code', "if (code.startsWith('SQLITE_BUSY')) return 'busy';"],
      ['error-code in a template', 'sqlite_error_code', 'const m = `${code} was SQLITE_LOCKED`;'],
      [
        'constraint text via regex',
        'constraint_failed_text',
        'if (/UNIQUE constraint failed: users\\.name/.test(message)) return true;',
      ],
      [
        'constraint text via includes',
        'constraint_failed_text',
        "if (message.includes('CHECK constraint failed')) return true;",
      ],
      [
        'full trigger message',
        'trigger_text',
        "if (message.includes('users.name collides with an existing agent name')) return 'name';",
      ],
      [
        'trigger message fragment via regex',
        'trigger_text',
        'if (/collides with an existing agent name/.test(message)) return true;',
      ],
    ];
    for (const [label, signal, src] of probes) {
      const got = scanDriverDialect({ path: 'probe.ts', src }, triggers);
      expect(
        got.map(f => f.signal),
        `not detected: ${label}`,
      ).toContain(signal);
    }
  });

  it('fence self-test: ordinary prose and unrelated SQL are not flagged', () => {
    const triggers = ['users.name collides with an existing agent name'];
    const negatives: Array<[string, string]> = [
      [
        'a comment quoting the driver message',
        '// a UNIQUE constraint failed: users.name error is translated in sqlite-user-conflicts\nconst x = 1;',
      ],
      [
        'a doc comment quoting trigger text',
        '/** `name` collides with an existing `agents.name`; the column UNIQUE covers it. */\nconst x = 1;',
      ],
      ['the word constraint in prose', "const doc = 'callers must satisfy the membership constraint first';"],
      ['a constraint-shaped domain message', "const msg = 'validation constraint violated for this field';"],
      ['plain SQL', "const sql = 'SELECT id FROM users WHERE name = ?';"],
      ['a short trigger fragment', "const label = 'nested threads';"],
    ];
    for (const [label, src] of negatives) {
      expect(scanDriverDialect({ path: 'probe.ts', src }, triggers), `false positive: ${label}`).toEqual(
        [],
      );
    }
  });
});
