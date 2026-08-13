/**
 * The wall behind the ledgers (#task:1983 W8) — zone labels are checked against
 * module surfaces, and the surfaces are checked against each other.
 *
 * Every gate in this directory compares an exact per-file ledger with the tree.
 * That refuses a SILENT change but not a DECLARED one: a new
 * `src/services/foo.ts` that calls `db.prepare()` and adds itself as
 * `zone: 'repository'` used to match its own row, and all nine gates stayed
 * green. `#task:1983` claims a hard wall, so this file makes the label
 * load-bearing in the only way it can be: a zone is legal on one surface, and
 * the surfaces themselves cannot reach a consumer layer.
 *
 * Three levels of self-test here, because each one can fail differently:
 *
 *  - the RULES: every zone has a surface, every surface matches a real module,
 *    surfaces of one family do not overlap unless a rule says who wins, and NO
 *    surface intersects the consumer layer (so a future edit to `zones.ts`
 *    cannot re-admit one quietly).
 *  - the LEDGERS: the real rows satisfy the rules today.
 *  - the FALSIFIERS: a forged row for a real illegal path — the exact shape a
 *    reviewer would wave through, since the ledger diff looks routine — is
 *    refused for every capability axis and every consumer layer.
 */
import { describe, expect, it } from 'vitest';
import {
  BETTER_SQLITE3_IMPORT_INVENTORY,
  DIALECT_DECODING_INVENTORY,
  SQL_CALLER_INVENTORY,
  TX_INVENTORY,
} from './inventory.js';
import {
  adapterInternalViolations,
  CONSUMER_LAYER,
  onSurface,
  txOwnershipViolations,
  TX_OWNER_SURFACES,
  ZONE_FAMILIES,
  ZONE_OVERLAP_RULES,
  ZONE_OWNER_SURFACES,
  zoneSurfaceViolations,
  type DbOwnerZone,
  type OwnerSurface,
  type TxOwner,
  type ZoneFamily,
} from './zones.js';
import { allProductionSources } from './sources.js';

/** One real file per consumer layer — the paths a violation would actually take. */
const CONSUMER_PROBES = [
  'packages/backend/src/routes.ts',
  'packages/backend/src/routes/hosts.ts',
  'packages/backend/src/services/task-service.ts',
  'packages/backend/src/application/create-agent.ts',
  'packages/backend/src/runtime/outbound-event-fanout.ts',
  'packages/backend/src/ws/ws-server.ts',
  'packages/backend/src/auth/user-auth-service.ts',
  'packages/backend/src/permissions.ts',
];

const ZONE_KEYS = Object.keys(ZONE_OWNER_SURFACES) as DbOwnerZone[];

describe('db-boundary: zone surfaces are the wall, labels are not', () => {
  const files = allProductionSources().map(e => e.path);

  it('the corpus and the consumer layer are both non-empty (nothing below is vacuous)', () => {
    // §CG: an absence claim proves its search domain first. Every assertion in
    // this file is of the form "no file/row does X"; if the corpus were empty or
    // the consumer-layer predicate matched nothing, they would all pass while
    // proving nothing.
    expect(files.length).toBeGreaterThan(200);
    const consumers = files.filter(f => onSurface(f, CONSUMER_LAYER));
    expect(consumers.length, 'the consumer-layer predicate matches no real file').toBeGreaterThan(50);
    for (const probe of CONSUMER_PROBES) {
      expect(files, `probe path is not a real production file: ${probe}`).toContain(probe);
      expect(onSurface(probe, CONSUMER_LAYER), `not recognised as a consumer layer: ${probe}`).toBe(true);
    }
  });

  it('no owner surface reaches into the consumer layer — the rule that cannot be edited away', () => {
    // The load-bearing meta-check. Everything else says "this row is on the
    // wrong surface"; this says "no surface may be widened to make a consumer
    // layer right". Adding `src/services/` to any zone reddens HERE, so the
    // wall cannot be moved by the same kind of edit that moves a ledger row.
    const breaches: string[] = [];
    for (const zone of ZONE_KEYS) {
      for (const file of files) {
        if (onSurface(file, ZONE_OWNER_SURFACES[zone]) && onSurface(file, CONSUMER_LAYER)) {
          breaches.push(`${zone} surface admits ${file}, which is in the consumer layer`);
        }
      }
    }
    expect(
      breaches,
      'a DB-capability surface overlaps the consumer layer. Routes / use cases / services / runtime / ws / auth / ' +
        'permissions do not hold statement, driver, native-transaction or dialect capability under ANY label — if a ' +
        'consumer needs persisted state it gets a repository under src/repos/ and asks it',
    ).toEqual([]);
  });

  it('every surface names a real module (no rule that matches nothing)', () => {
    // A surface matching zero files would be a dead rule: its zone could then
    // never be claimed legally, which reads as strictness but actually means the
    // next person deletes the check instead of the row.
    const dead = ZONE_KEYS.filter(z => !files.some(f => onSurface(f, ZONE_OWNER_SURFACES[z])));
    expect(dead, 'a zone surface matches no production file').toEqual([]);
    const deadTx = (Object.keys(TX_OWNER_SURFACES) as TxOwner[]).filter(
      o => !files.some(f => onSurface(f, TX_OWNER_SURFACES[o])),
    );
    expect(deadTx, 'a transaction-owner surface matches no production file').toEqual([]);
    const declared: OwnerSurface[] = [...ZONE_KEYS.map(z => ZONE_OWNER_SURFACES[z]), CONSUMER_LAYER];
    for (const surface of declared) {
      expect(surface.role.trim().length, 'every surface states the responsibility it is').toBeGreaterThan(10);
      for (const dir of surface.dirs ?? []) {
        expect(dir.endsWith('/'), `a module boundary must end in '/': ${dir}`).toBe(true);
        expect(files.some(f => f.startsWith(dir)), `no file under declared module: ${dir}`).toBe(true);
      }
      for (const file of surface.files ?? []) {
        expect(files, `declared surface file does not exist: ${file}`).toContain(file);
      }
    }
  });

  it('within one family, surfaces are disjoint unless a rule names the winner', () => {
    const unresolved: string[] = [];
    for (const family of Object.keys(ZONE_FAMILIES) as ZoneFamily[]) {
      const zones: readonly DbOwnerZone[] = ZONE_FAMILIES[family];
      for (const file of files) {
        const matching = zones.filter(z => onSurface(file, ZONE_OWNER_SURFACES[z]));
        if (matching.length < 2) continue;
        // An overlap is allowed only if exactly one of the matching zones is the
        // declared `specific` winner over every other matching zone.
        const winners = matching.filter(candidate =>
          matching
            .filter(other => other !== candidate)
            .every(other =>
              ZONE_OVERLAP_RULES.some(
                r => r.family === family && r.specific === candidate && r.general === other,
              ),
            ),
        );
        if (winners.length !== 1) {
          unresolved.push(`${family}: ${file} matches ${matching.join(' + ')} with no unique owner`);
        }
      }
    }
    expect(
      unresolved,
      'two zones of one ledger can claim the same file and nothing says which is right. Either narrow one ' +
        'surface, or add a ZONE_OVERLAP_RULES row naming the specific zone that owns the overlap',
    ).toEqual([]);
    // …and the rules are not decoration: each one must resolve a real overlap.
    for (const rule of ZONE_OVERLAP_RULES) {
      const overlap = files.filter(
        f =>
          onSurface(f, ZONE_OWNER_SURFACES[rule.specific]) &&
          onSurface(f, ZONE_OWNER_SURFACES[rule.general]),
      );
      expect(overlap.length, `overlap rule resolves nothing: ${rule.specific} vs ${rule.general}`).toBeGreaterThan(0);
      expect(rule.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('every real ledger satisfies the rules today', () => {
    expect(zoneSurfaceViolations(BETTER_SQLITE3_IMPORT_INVENTORY, 'driver-import')).toEqual([]);
    expect(zoneSurfaceViolations(SQL_CALLER_INVENTORY, 'sql-caller')).toEqual([]);
    expect(zoneSurfaceViolations(DIALECT_DECODING_INVENTORY, 'dialect')).toEqual([]);
    expect(
      adapterInternalViolations(DIALECT_DECODING_INVENTORY, SQL_CALLER_INVENTORY.map(e => e.file)),
    ).toEqual([]);
    expect(txOwnershipViolations(TX_INVENTORY)).toEqual([]);
  });

  it('falsifier: an illegal file plus a forged ledger row is still refused, on every axis', () => {
    // The shape @Cindy proved was green before this slice: write the violation,
    // then add the row for it in the same commit. The forged rows below are
    // appended to the REAL ledgers, so each arm asserts the production ledger
    // plus one lie is refused — not merely that a synthetic list is.
    for (const file of CONSUMER_PROBES) {
      for (const zone of ['adapter', 'repository'] as const) {
        expect(
          zoneSurfaceViolations([...SQL_CALLER_INVENTORY, { file, zone }], 'sql-caller'),
          `SQL sink admitted in ${file} as ${zone}`,
        ).not.toEqual([]);
        expect(
          zoneSurfaceViolations(
            [...BETTER_SQLITE3_IMPORT_INVENTORY.map(e => ({ file: e.file, zone: e.zone })), { file, zone }],
            'driver-import',
          ),
          `driver import admitted in ${file} as ${zone}`,
        ).not.toEqual([]);
      }
      // A consumer cannot promote itself to the singleton roles either.
      for (const zone of ['composition', 'lifecycle'] as const) {
        expect(
          zoneSurfaceViolations([{ file, zone }], 'driver-import'),
          `${zone} admitted in ${file}`,
        ).not.toEqual([]);
      }
      expect(
        zoneSurfaceViolations([...DIALECT_DECODING_INVENTORY, { file, zone: 'error-translation' }], 'dialect'),
        `dialect decoding admitted in ${file}`,
      ).not.toEqual([]);
      expect(
        zoneSurfaceViolations([{ file, zone: 'adapter-internal' }], 'dialect'),
        `adapter-internal admitted in ${file}`,
      ).not.toEqual([]);
    }
    // The schema zone is a real surface, not a spare label for anyone.
    expect(zoneSurfaceViolations([{ file: 'packages/backend/src/services/task-service.ts', zone: 'schema' }], 'sql-caller')).not.toEqual([]);
    // A zone that exists but is not in this family is refused as such.
    expect(
      zoneSurfaceViolations([{ file: 'packages/backend/src/db.ts', zone: 'lifecycle' }], 'sql-caller')[0],
    ).toContain("not one of the sql-caller ledger's zones");
  });

  it('falsifier: adapter-internal cannot be claimed by a repo that owns no SQL', () => {
    // `src/repos/` is on the surface, so the location check passes — this is the
    // arm that stops the zone from decaying into a directory waiver. A repo file
    // that decodes driver codes for rows it does not query is translating
    // someone else's constraint.
    const noSql = 'packages/backend/src/repos/agent-provisioning-persistence.ts';
    expect(SQL_CALLER_INVENTORY.map(e => e.file)).not.toContain(noSql);
    expect(zoneSurfaceViolations([{ file: noSql, zone: 'adapter-internal' }], 'dialect')).toEqual([]);
    expect(
      adapterInternalViolations(
        [...DIALECT_DECODING_INVENTORY, { file: noSql, zone: 'adapter-internal' }],
        SQL_CALLER_INVENTORY.map(e => e.file),
      ),
      'a repo that owns no SQL was allowed to translate a constraint',
    ).not.toEqual([]);
  });

  it('falsifier: a native transaction in a business layer is refused under every owner label', () => {
    // @Cindy's second arm. The ledger comparison accepts any (file, fn, mode)
    // that has a row, and `owner` was free text from the type's point of view,
    // so `services/*` + `db.transaction()` + `owner: 'service'` passed. Native
    // capability is now positional.
    const natives = ['default', 'immediate', 'exclusive', 'stored'] as const;
    const layers: Array<[string, TxOwner[]]> = [
      ['packages/backend/src/services/task-service.ts', ['service', 'use-case', 'infra', 'repo-internal']],
      ['packages/backend/src/application/create-agent.ts', ['use-case', 'service', 'infra']],
      ['packages/backend/src/runtime/outbound-event-fanout.ts', ['service', 'infra', 'repo-internal']],
      ['packages/backend/src/routes/hosts.ts', ['use-case', 'service', 'infra']],
      ['packages/backend/src/auth/user-auth-service.ts', ['auth', 'infra', 'repo-internal']],
    ];
    for (const [file, owners] of layers) {
      for (const mode of natives) {
        for (const owner of owners) {
          expect(
            txOwnershipViolations([...TX_INVENTORY, { file, fn: 'f', mode, owner }]),
            `native ${mode} admitted in ${file} as owner ${owner}`,
          ).not.toEqual([]);
        }
      }
    }
    // …while the sanctioned shape in exactly those files stays green: the
    // business layer states its atomicity through a port.
    expect(
      txOwnershipViolations([
        { file: 'packages/backend/src/services/task-service.ts', fn: 'f', mode: 'uow', owner: 'service' },
        { file: 'packages/backend/src/application/create-agent.ts', fn: 'f', mode: 'uow', owner: 'use-case' },
        { file: 'packages/backend/src/runtime/outbound-event-fanout.ts', fn: 'f', mode: 'uow', owner: 'service' },
        { file: 'packages/backend/src/auth/user-auth-service.ts', fn: 'f', mode: 'uow', owner: 'auth' },
      ]),
    ).toEqual([]);
    // …and persistence keeps its native modes.
    expect(
      txOwnershipViolations([
        { file: 'packages/backend/src/repos/message-repo.ts', fn: 'f', mode: 'default', owner: 'repo-internal' },
        { file: 'packages/backend/src/repos/host-uow.ts', fn: 'atomically', mode: 'immediate', owner: 'infra' },
        { file: 'packages/backend/src/db.ts', fn: 'runMigrations', mode: 'exclusive', owner: 'infra' },
      ]),
    ).toEqual([]);
  });

  it('falsifier: the owner label cannot move a boundary between business layers', () => {
    // Mislabelling within the legal side still matters: the ledger is how a
    // reader finds out which layer decides an invariant, and a route claiming
    // `use-case` is how "no transactions in routes" gets read as satisfied.
    const mislabelled: Array<[string, TxOwner]> = [
      ['packages/backend/src/services/task-service.ts', 'use-case'],
      ['packages/backend/src/application/create-agent.ts', 'service'],
      ['packages/backend/src/application/create-agent.ts', 'auth'],
      ['packages/backend/src/repos/message-repo.ts', 'service'],
    ];
    for (const [file, owner] of mislabelled) {
      expect(
        txOwnershipViolations([{ file, fn: 'f', mode: 'uow', owner }]),
        `owner ${owner} accepted for ${file}`,
      ).not.toEqual([]);
    }
    // And the reverse direction of the joint rule: persistence does not take an
    // application-level boundary from a port.
    expect(
      txOwnershipViolations([
        { file: 'packages/backend/src/repos/message-repo.ts', fn: 'f', mode: 'uow', owner: 'repo-internal' },
      ]),
    ).not.toEqual([]);
  });
});
