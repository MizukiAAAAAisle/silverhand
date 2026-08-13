/**
 * Which module may hold which DB capability — the OWNER SURFACES the zone
 * labels in `inventory.ts` must land on (#task:1983 W8).
 *
 * Why this file exists. Every ledger in `inventory.ts` is an exact per-file
 * match, and each row carries a `zone` (or, for transactions, an `owner`)
 * saying which legitimate role the file plays. Deleting the `debt` variants
 * removed the place to PARK a violation, but the remaining labels were still
 * self-declared: a new `src/services/*.ts` that called `db.prepare()` and added
 * itself as `zone: 'repository'` matched its own row and every gate stayed
 * green. The label restricted a WORD, not a LOCATION — so the wall was a
 * review convention wearing a gate's clothes.
 *
 * The contract here closes that: a zone is legal only on the module surface
 * that actually owns that responsibility, and the surfaces are declared once,
 * separately from the rows. Three properties make it a wall rather than a
 * second allowlist:
 *
 *  1. Surfaces are MODULE BOUNDARIES (or named singleton roles), not per-file
 *     permissions. Adding a repository under `src/repos/` needs no edit here;
 *     admitting a NEW module as a repository is an explicit edit to this file
 *     that says exactly that, and reads as a boundary change in review rather
 *     than as ledger bookkeeping.
 *  2. No surface may intersect `CONSUMER_LAYER` — asserted over the real source
 *     tree in `zone-surface.test.ts`. That check is about the RULES, not the
 *     rows, so even a future edit here cannot hand a consumer layer a DB
 *     capability: adding `src/services/` to a surface reddens on its own.
 *  3. Overlaps are not resolved by whoever writes the row. Where two zones of
 *     one family can match the same file, `ZONE_OVERLAP_RULES` names which zone
 *     wins, and claiming the broader one is a violation.
 *
 * Deliberately NOT folded in here: `PrivatePortEntry.zone` (Gate 8). Its
 * `consumer` / `declaration` / `composition` are roles around ONE port, not DB
 * capability surfaces, and that gate already pins each zone to a literal file
 * set (`private-port.test.ts`), so a forged row there fails on location today.
 */
import type { TxMode } from './scan.js';

/**
 * A module surface, by path. `dirs` are prefixes (module boundaries); `files`
 * are exact paths, used where a responsibility genuinely belongs to named
 * modules inside a directory that is mostly something else — enumerating those
 * two files is precise, while `src/observability/` as a whole would be a waiver
 * for six unrelated modules.
 */
export interface OwnerSurface {
  /** The responsibility, in one line. Printed in gate failures. */
  role: string;
  dirs?: readonly string[];
  files?: readonly string[];
}

export type DbOwnerZone =
  | 'adapter'
  | 'repository'
  | 'schema'
  | 'composition'
  | 'lifecycle'
  | 'error-translation'
  | 'adapter-internal';

export const ZONE_OWNER_SURFACES = {
  adapter: {
    role: 'the driver adapter and the two instrumentation modules that wrap statements',
    files: [
      'packages/backend/src/db.ts',
      'packages/backend/src/observability/observed-statement.ts',
      'packages/backend/src/observability/db-write-probe.ts',
    ],
    dirs: ['packages/backend/src/adapters/'],
  },
  repository: {
    role: 'repositories and read models — the modules whose job is one concern of persisted state',
    dirs: ['packages/backend/src/repos/', 'packages/backend/src/read-model/'],
  },
  schema: {
    role: 'the shared schema: the modules that DEFINE tables, triggers and migrations',
    dirs: ['packages/shared/src/db/'],
  },
  composition: {
    role: 'the persistence composition root — the one function that spends the handle for driver-free ports',
    dirs: ['packages/backend/src/persistence/'],
  },
  lifecycle: {
    role: 'the process entrypoints that own a handle lifetime (open / migrate / close)',
    files: ['packages/backend/src/index.ts', 'packages/backend/src/admin.ts'],
  },
  'error-translation': {
    role: 'the dedicated translation modules whose WHOLE job is turning a driver failure into a domain outcome',
    files: ['packages/backend/src/db-errors.ts', 'packages/backend/src/repos/sqlite-user-conflicts.ts'],
  },
  'adapter-internal': {
    role: 'a SQLite adapter translating a constraint IT owns into its own domain outcome',
    dirs: ['packages/backend/src/repos/', 'packages/backend/src/read-model/'],
  },
} as const satisfies Record<DbOwnerZone, OwnerSurface>;

/**
 * The layers that may never hold a DB capability, named from #task:1983's goal
 * (routes / application / services / runtime / ws / auth / permissions), plus
 * the two collaborator directories that are equally not persistence
 * (`presence`, `storage`) — if either ever needs persisted state it gets a
 * repository under `src/repos/`, which is the whole point of the boundary.
 *
 * This set is not itself a gate over the tree: the positive surfaces above
 * already refuse every file that is not on them. It exists so the SURFACES can
 * be checked for not intersecting it — the assertion that keeps a future edit
 * to this file from quietly re-admitting a consumer layer.
 */
export const CONSUMER_LAYER: OwnerSurface = {
  role: 'HTTP routes, use cases, services, runtime, ws handlers, auth, permissions and their collaborators',
  files: [
    'packages/backend/src/routes.ts',
    'packages/backend/src/permissions.ts',
    'packages/backend/src/permissions-registry.ts',
  ],
  dirs: [
    'packages/backend/src/routes/',
    'packages/backend/src/application/',
    'packages/backend/src/services/',
    'packages/backend/src/runtime/',
    'packages/backend/src/ws/',
    'packages/backend/src/auth/',
    'packages/backend/src/presence/',
    'packages/backend/src/storage/',
  ],
};

/** Which zones a given ledger may use — a row can only be wrong WITHIN its family. */
export const ZONE_FAMILIES = {
  'driver-import': ['adapter', 'repository', 'composition', 'lifecycle'],
  'sql-caller': ['adapter', 'repository', 'schema'],
  dialect: ['schema', 'error-translation', 'adapter-internal'],
} as const satisfies Record<string, readonly DbOwnerZone[]>;

export type ZoneFamily = keyof typeof ZONE_FAMILIES;

/**
 * Where two zones of one family can match the same file, the specific one wins
 * and claiming the general one is a violation. Without this, "which label do I
 * pick?" would be back in the hands of whoever adds the row.
 */
export const ZONE_OVERLAP_RULES: readonly {
  family: ZoneFamily;
  specific: DbOwnerZone;
  general: DbOwnerZone;
  reason: string;
}[] = [
  {
    family: 'dialect',
    specific: 'error-translation',
    general: 'adapter-internal',
    reason:
      'sqlite-user-conflicts.ts lives under repos/ but is a dedicated translator, not a repository translating ' +
      'its own constraint in passing. It must claim the narrow role so the two dedicated modules stay countable',
  },
];

export function onSurface(file: string, surface: OwnerSurface): boolean {
  return (
    (surface.files?.includes(file) ?? false) || (surface.dirs?.some(d => file.startsWith(d)) ?? false)
  );
}

export function inZone(file: string, zone: DbOwnerZone): boolean {
  return onSurface(file, ZONE_OWNER_SURFACES[zone]);
}

export interface ZonedRow {
  file: string;
  zone: DbOwnerZone;
}

/**
 * The check every zoned ledger runs over its own rows. Returns one line per
 * violation (empty = legal), so a gate can print them and a self-test can
 * assert a forged row is refused.
 */
export function zoneSurfaceViolations(rows: readonly ZonedRow[], family: ZoneFamily): string[] {
  const allowed: readonly DbOwnerZone[] = ZONE_FAMILIES[family];
  const problems: string[] = [];
  for (const row of rows) {
    if (!allowed.includes(row.zone)) {
      problems.push(
        `${row.file}: zone '${row.zone}' is not one of the ${family} ledger's zones (${allowed.join(', ')})`,
      );
      continue;
    }
    if (!inZone(row.file, row.zone)) {
      const fits = allowed.filter(z => inZone(row.file, z));
      problems.push(
        `${row.file}: claims zone '${row.zone}' but is not on that surface (${ZONE_OWNER_SURFACES[row.zone].role})` +
          (fits.length
            ? `. This file is on the ${fits.map(z => `'${z}'`).join(' / ')} surface`
            : '. This file is on NO owner surface: the capability belongs behind a repository, an adapter or a port'),
      );
      continue;
    }
    for (const rule of ZONE_OVERLAP_RULES) {
      if (rule.family === family && row.zone === rule.general && inZone(row.file, rule.specific)) {
        problems.push(
          `${row.file}: claims the broad zone '${rule.general}' but is on the '${rule.specific}' surface, ` +
            `which owns the overlap — ${rule.reason}`,
        );
      }
    }
  }
  return problems;
}

/**
 * `adapter-internal` says "the adapter that owns this table's SQL translates
 * its own constraint". That is only true if the file really is that adapter, so
 * the claim is checked against the SQL-caller ledger instead of trusted from
 * the reason. Without this, the zone would decay into "any file under repos/
 * may decode dialect".
 */
export function adapterInternalViolations(
  dialectRows: readonly ZonedRow[],
  sqlCallerFiles: readonly string[],
): string[] {
  const ownsSql = new Set(sqlCallerFiles);
  return dialectRows
    .filter(r => r.zone === 'adapter-internal' && !ownsSql.has(r.file))
    .map(
      r =>
        `${r.file}: claims 'adapter-internal' dialect decoding but owns no SQL in the sink ledger — it is not the ` +
        `adapter for that constraint, so translation belongs in a dedicated module (db-errors.ts / a *-conflicts.ts)`,
    );
}

/* -------------------------------------------------------------------------- *
 * Transactions (Gate 3): judged on (mode, owner, surface) jointly.
 * -------------------------------------------------------------------------- */

export type TxOwner = 'use-case' | 'service' | 'auth' | 'repo-internal' | 'infra';

/**
 * The owner label is a claim about WHO owns the atomic boundary, so it is
 * pinned to that layer's surface: a service calling itself a use case, or a
 * repository calling itself a service, is a mislabelled boundary either way.
 */
export const TX_OWNER_SURFACES = {
  'use-case': {
    role: 'application use cases',
    dirs: ['packages/backend/src/application/'],
  },
  service: {
    role: 'domain services and the runtime collaborators shaped like them',
    dirs: ['packages/backend/src/services/', 'packages/backend/src/runtime/'],
  },
  auth: {
    role: 'the auth domain services',
    dirs: ['packages/backend/src/auth/'],
  },
  'repo-internal': {
    role: 'a repository owning an invariant of its own rows',
    dirs: ['packages/backend/src/repos/', 'packages/backend/src/read-model/'],
  },
  infra: {
    role: 'UnitOfWork implementations, migrations and the driver adapter',
    files: [
      'packages/backend/src/db.ts',
      'packages/backend/src/observability/observed-statement.ts',
      'packages/backend/src/observability/db-write-probe.ts',
    ],
    dirs: [
      'packages/backend/src/repos/',
      'packages/backend/src/read-model/',
      'packages/backend/src/adapters/',
      'packages/backend/src/persistence/',
    ],
  },
} as const satisfies Record<TxOwner, OwnerSurface>;

/**
 * A NATIVE transaction (`db.transaction(...)`, any mode) may only be opened on
 * the persistence surface. `uow` — calling a UnitOfWork port — is the shape the
 * business layers use, and conversely a persistence module does not take an
 * application-level atomic boundary from a port.
 *
 * The `uow` direction is the weaker of the two claims: it says atomic
 * boundaries are decided by the application layer and implemented by
 * persistence, so a persistence module reaching for a port is a design change,
 * not a mechanical impossibility. It is asserted here so that change has to be
 * argued.
 */
export const PERSISTENCE_SURFACE_ZONES: readonly DbOwnerZone[] = ['adapter', 'repository'];

export function onPersistenceSurface(file: string): boolean {
  return (
    PERSISTENCE_SURFACE_ZONES.some(z => inZone(file, z)) ||
    onSurface(file, ZONE_OWNER_SURFACES.composition)
  );
}

export interface TxRow {
  file: string;
  fn: string;
  mode: TxMode;
  owner: TxOwner;
}

export function txOwnershipViolations(rows: readonly TxRow[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const where = `${row.file} ${row.fn}`;
    if (!onSurface(row.file, TX_OWNER_SURFACES[row.owner])) {
      problems.push(
        `${where}: claims owner '${row.owner}' (${TX_OWNER_SURFACES[row.owner].role}) but is not on that layer`,
      );
    }
    if (row.mode === 'uow') {
      if (onPersistenceSurface(row.file)) {
        problems.push(
          `${where}: a persistence module takes an atomic boundary from a UnitOfWork port. Atomic boundaries are ` +
            `decided by the application layer; persistence IMPLEMENTS them`,
        );
      }
      continue;
    }
    if (!onPersistenceSurface(row.file)) {
      problems.push(
        `${where}: opens a NATIVE ${row.mode} transaction outside the persistence surface. No owner label makes ` +
          `this legal — a business layer states the atomicity it needs by calling a UnitOfWork port (mode 'uow'), ` +
          `and the port implements it. Move the boundary into a use case or a persistence module`,
      );
    }
  }
  return problems;
}
