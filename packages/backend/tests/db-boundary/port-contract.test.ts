/**
 * Gate 5 — port/concrete boundary (#task:1978 proof slice, widened by #1980 to
 * the task domain and by #1981 to the channel / conversation-message domain).
 *
 * Four-sided contract (the first two were ruled in the #1978 review; a blanket
 * "no driver types in repo exports" ban would only breed empty factories):
 *  - the application-facing port module's RELATIVE IMPORT CLOSURE is
 *    driver-free (recursive, not one hop), so `Database as Db`, forwarding
 *    modules, or a multi-hop re-export chain cannot launder driver types onto
 *    the port surface;
 *  - application/service code depends on ports, never on the concrete SQLite
 *    implementations; concretes are imported only by an EXACT file allowlist
 *    (composition roots + the persistence composition modules), never by a
 *    directory-level waiver;
 *  - a domain whose persistence has fully converged (#1981 criterion R2) names
 *    NO `repos/*` module at all. That is the application-side form of the same
 *    rule, needed because a shared repo (`conversation-repo`, `message-repo`)
 *    still has unconverged callers and so cannot itself be listed as a fenced
 *    concrete yet;
 *  - BOOT composes no persistence (#1983 W1): `index.ts` owns the driver
 *    (open / migrate / observe / close) and nothing else, so it names no
 *    `repos/*` and no `adapters/*` module. Without this side, boot could keep
 *    growing `createSqliteX(db)` wiring forever — it derives its handle from
 *    `openDatabase()`, so no driver-IMPORT gate can see it.
 *
 * All rules are implemented as pure functions over a file map and the
 * self-tests drive THOSE functions with synthetic trees, so what is proven to
 * redden is the production gate itself, not a lower-level scanner.
 */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  moduleReferencesOf,
  parse,
  scanBetterSqliteImports,
  type SourceEntry,
} from './scan.js';
import { allProductionSources, REPO_ROOT } from './sources.js';

const PORT_MODULES = [
  // auth (#task:1978)
  'packages/backend/src/auth/ports.ts',
  'packages/backend/src/auth/host-ports.ts',
  // task (#task:1980)
  'packages/backend/src/services/task/ports.ts',
  // channel / conversation-message (#task:1981)
  'packages/backend/src/services/channel/ports.ts',
  'packages/backend/src/services/conversation-message/ports.ts',
  'packages/backend/src/services/conversation/unread-publish-port.ts',
  // human identity (#task:1982)
  'packages/backend/src/services/user/ports.ts',
  // outbound runtime fanout (#task:1982 W3)
  'packages/backend/src/runtime/persistence-ports.ts',
  // workspace-membership cascade (#task:1982 W5)
  'packages/backend/src/application/membership-ports.ts',
  // agent provisioning (#task:1990)
  'packages/backend/src/application/agent-provisioning-ports.ts',
  // agent / computer teardown (#task:1987 D)
  'packages/backend/src/application/agent-teardown-ports.ts',
  // observation / attention eliminate (#task:1987 E)
  'packages/backend/src/application/observation-ports.ts',
  // cross-cutting authorization (#task:1983 W3). It sits next to its consumer
  // `permissions.ts` rather than under a domain directory on purpose: the module
  // is neither composition nor persistence, and the facts it declares span
  // workspaces / conversations / agents / capabilities / attachments. No domain
  // owns it, so no domain directory may claim it.
  'packages/backend/src/authorization-ports.ts',
];

/**
 * EXACT files allowed to import the concrete auth / task / conversation
 * persistence. No directory waivers: another repo file importing a concrete is
 * a boundary violation.
 */
const CONCRETE_IMPORTERS = new Set([
  // NOTE: `index.ts` is deliberately absent (#task:1983 W1). Boot used to be
  // here, and that row was what let it assemble a second persistence set from
  // the handle `openDatabase()` returns. It is now fenced outright — see the
  // boot-composition test below.
  // The internal-agent router is NO LONGER a composition site (#task:1983 W2):
  // it used to build its own repo cluster and a second membership adapter from
  // `ctx.db`, so it needed this row. It now receives `BackendPersistence` like
  // the public router, which is why its row is gone rather than re-justified —
  // and the stale-row test below is what makes leaving it here impossible.
  'packages/backend/src/admin.ts',
  // #task:1983 W1 — the persistence composition root: it exists precisely to
  // wire the concretes behind driver-free ports, and it is what let `routes.ts`
  // and `index.ts` leave this allowlist (the router and boot now receive the
  // composed bag).
  'packages/backend/src/persistence/root.ts',
  // the persistence composition modules themselves wire the concrete repos
  'packages/backend/src/repos/auth-uow.ts',
  'packages/backend/src/repos/host-uow.ts',
  'packages/backend/src/repos/task-persistence.ts',
  'packages/backend/src/repos/conversation-persistence.ts',
  'packages/backend/src/repos/user-persistence.ts',
  'packages/backend/src/repos/membership-persistence.ts',
  // agent provisioning (#task:1990)
  'packages/backend/src/repos/agent-provisioning-persistence.ts',
  // agent / computer teardown (#task:1987 D) — it composes AgentRepo /
  // WorkspaceRepo / ConversationRepo / AttachmentRepo / HostRepo behind the
  // driver-free teardown scope, which is exactly what a persistence composition
  // module is for
  'packages/backend/src/repos/agent-teardown-persistence.ts',
  // the effect adapters wire concrete repos behind one driver-free effect port
  // (`unread-publish.ts` used to be listed here too; it composes plain repos
  // only, so its row was an unexercised permission — #task:1983 W1)
  'packages/backend/src/adapters/mention-cc.ts',
  'packages/backend/src/adapters/runtime-fanout.ts',
]);

const CONCRETE_PERSISTENCE_FILES = new Set([
  'packages/backend/src/repos/auth-credentials-repo.ts',
  'packages/backend/src/repos/auth-sessions-repo.ts',
  'packages/backend/src/repos/auth-uow.ts',
  'packages/backend/src/repos/host-credentials-repo.ts',
  'packages/backend/src/repos/host-uow.ts',
  'packages/backend/src/repos/task-repo.ts',
  'packages/backend/src/repos/task-board-read-model.ts',
  'packages/backend/src/repos/task-persistence.ts',
  'packages/backend/src/repos/conversation-persistence.ts',
  'packages/backend/src/repos/user-persistence.ts',
  'packages/backend/src/repos/membership-persistence.ts',
  'packages/backend/src/repos/agent-provisioning-persistence.ts',
  'packages/backend/src/repos/agent-teardown-persistence.ts',
  'packages/backend/src/repos/observation-persistence.ts',
  'packages/backend/src/adapters/runtime-fanout.ts',
]);

/**
 * The channel / conversation-message application layer after #task:1981: these
 * files own permission, sequencing, freshness, delivery and thread-follow
 * orchestration, and reach persistence exclusively through ports / the
 * UnitOfWork scope.
 */
const CONVERSATION_DOMAIN_APP_FILES = [
  'packages/backend/src/services/channel-service.ts',
  'packages/backend/src/services/channel/ports.ts',
  'packages/backend/src/services/channel/errors.ts',
  'packages/backend/src/services/conversation-message-service.ts',
  'packages/backend/src/services/conversation-message/ports.ts',
  'packages/backend/src/services/conversation-message/contracts.ts',
  'packages/backend/src/services/conversation-message/delivery.ts',
  'packages/backend/src/services/conversation-message/thread-follow.ts',
  'packages/backend/src/services/conversation/unread-publish-port.ts',
];

const TASK_APP_FILES = [
  'packages/backend/src/services/task-service.ts',
  'packages/backend/src/services/task/ports.ts',
  'packages/backend/src/services/task/contracts.ts',
  'packages/backend/src/services/task/board.ts',
  'packages/backend/src/services/task/broadcaster.ts',
  'packages/backend/src/services/task/dto.ts',
];

/**
 * The human-identity application layer after #task:1982: profile registration
 * (with its single-viewer gate and membership backfill) and password signup.
 * Both create paths decide business answers — `name_taken` / `handle_taken` /
 * `auth_failed` — from a driver-free conflict sentinel, so neither may name a
 * repo or read a driver error.
 */
const USER_DOMAIN_APP_FILES = [
  'packages/backend/src/services/user-service.ts',
  'packages/backend/src/services/user/ports.ts',
  'packages/backend/src/services/user/user-write-conflict.ts',
  'packages/backend/src/auth/user-auth-service.ts',
];

/**
 * The cross-channel mention cc fan-out after #task:1982 W2. It declares its own
 * ports (one file, one consumer) and holds no `Database` handle: the two
 * statements it used to prepare are now `WorkspaceRepo.addUserMember` and
 * `ConversationReadRepo.getLastReadSeq`, delegated from the adapter.
 */
const MENTION_CC_APP_FILES = [
  'packages/backend/src/application/mention-cc.ts',
];

/**
 * The outbound runtime fanout after #task:1982 W3. It keeps its in-process
 * runtime authority (run-state cache, delivery coordinator, clear-session
 * waiters, event perimeter) and gives up every durable decision: inbox
 * custody, the runtime rows it projects, the directory reads a spawn's options
 * need, and the clear-session atomic pair all arrive as driver-free facets.
 * The `Database` handle it used to hold — and the hand-prepared reconcile JOIN
 * plus the bare `db.transaction` it used it for — stop in
 * `adapters/runtime-fanout.ts`.
 */
const RUNTIME_FANOUT_APP_FILES = [
  'packages/backend/src/runtime/outbound-event-fanout.ts',
  'packages/backend/src/runtime/persistence-ports.ts',
  // W3 P1: the perimeter guard's policy stays in the runtime, but its reads are
  // now three port methods, so the module names no repo either. Fenced so the
  // guard cannot re-acquire `AgentRepo` / `ConversationRepo` — the exact shape
  // that made `perimeter` unimplementable by a non-SQLite deployment.
  'packages/backend/src/runtime/event-perimeter.ts',
];

/**
 * The host domain's converged application layer after #task:1982 W5: credential
 * lifecycle (issue / rotate / verify) and the setup lifecycle (invite → first
 * attach → naming → finalize). The finalize decision reads
 * `HostSetupPort.getSetupStateForUpdate` INSIDE the UnitOfWork scope, so nothing
 * on these paths needs a repo handle.
 *
 * `application/revoke-host.ts` is deliberately NOT here: its read side is still
 * a `HostRepo` (owner resolution + post-commit refetch + `toDto`), and its
 * `revoked_at === null` decision is still taken from that pre-transaction
 * snapshot. That is a NAMED residual, not a silent gap — fencing the file today
 * would require either a fake port or a scope widening W5 was not asked for.
 */
const HOST_DOMAIN_APP_FILES = [
  'packages/backend/src/auth/host-ports.ts',
  'packages/backend/src/auth/host-token.ts',
  'packages/backend/src/application/create-host-invite.ts',
  'packages/backend/src/application/update-host.ts',
];

/**
 * The workspace-membership cascade after #task:1982 W5: the removal use case,
 * its driver-free ports, and the pure audit language it composes messages from.
 * The cascade's whole decision — anchor, authoritative conversation set, audit
 * messages, the workspace row itself — is taken inside the UnitOfWork scope, so
 * none of these files needs a repo handle.
 *
 * `application/conversation-member.ts`, `add-workspace-agent-member.ts` and
 * `create-workspace.ts` are deliberately NOT here, and after #task:1987 the
 * reason is READS, not writes: every membership WRITE in all three now goes
 * through the UnitOfWork scope (their `TX_INVENTORY` rows are `mode:'uow'` and
 * their `CONTEXT_DB_READER_INVENTORY` rows are gone), but they still resolve
 * agents / users / workspaces / conversations through repo handles to decide
 * authorization and idempotency. This fence is all-or-nothing per file, so it
 * cannot state "the write half is converged" — the two ledgers do. Extracting
 * the audit language was what let this fence exist at all: a use case that only
 * needed the wording would otherwise have had to import that whole module.
 */
const MEMBERSHIP_CASCADE_APP_FILES = [
  'packages/backend/src/application/membership-ports.ts',
  'packages/backend/src/application/remove-workspace-member.ts',
  'packages/backend/src/application/conversation-member-audit.ts',
];

/**
 * The agent / computer teardown after #task:1987 D: both delete paths and the
 * driver-free port they consume. One UnitOfWork, two coordination keys — a
 * single agent and a whole computer — and the same capture semantics on both, so
 * neither path may reach a repo to re-derive what the scope already gave it.
 *
 * What the fence protects that no ledger can: the destructive facts these use
 * cases act on (delete eligibility, the DM blob refs, the live runtime sessions,
 * the agent ids the computer owns) are read INSIDE the scope. A `repos/*`
 * reference here is how a pre-lock snapshot creeps back in — the exact shape
 * that let the old flow delete agents one at a time outside any transaction.
 * `read-model/host-resources.ts` is a legal dependency: it is the shared wire
 * projection for `GET /api/hosts/:id/resources`, so the refusal payload cannot
 * drift from the query the delete dialog compares it against.
 */
const AGENT_TEARDOWN_APP_FILES = [
  'packages/backend/src/application/agent-teardown-ports.ts',
  'packages/backend/src/application/delete-agent.ts',
  'packages/backend/src/application/delete-computer.ts',
];

/**
 * Boot (#task:1983 W1). One file, listed rather than inlined so the rule reads
 * as a fence like every other one here. `admin.ts` is deliberately NOT fenced:
 * it is its own offline composition root with its own short-lived handle.
 */
const BOOT_FENCED_FILES = ['packages/backend/src/index.ts'];

type ReadSource = (repoRelativePath: string) => string | null;

interface LocalReference {
  spec: string | null;
  form: string;
}

/** All module references of a file, from the single authority in scan.ts. */
function localReferencesOf(entry: SourceEntry): LocalReference[] {
  return moduleReferencesOf(parse(entry)).map(r => ({ spec: r.spec, form: r.form }));
}

function resolveRelative(fromFile: string, spec: string): string {
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const raw = spec.endsWith('.ts') ? spec : spec.replace(/\.js$/, '') + '.ts';
  const parts = (fromDir + '/' + raw).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

/**
 * Production gate rule 1: the port file and its full relative import/re-export
 * closure never name better-sqlite3, in any binding form.
 */
export function portClosureDriverViolations(
  portFile: string,
  readSource: ReadSource,
): string[] {
  const problems: string[] = [];
  const visited = new Set<string>();
  const queue = [portFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const src = readSource(file);
    if (src === null) {
      problems.push(`${portFile}: unresolvable module in port closure: ${file}`);
      continue;
    }
    const entry: SourceEntry = { path: file, src };
    if (scanBetterSqliteImports(entry).length > 0) {
      problems.push(
        file === portFile
          ? `${portFile}: names better-sqlite3 directly`
          : `${portFile}: reaches better-sqlite3 through ${file} — driver types must not reach the port surface through any hop`,
      );
      continue;
    }
    for (const ref of localReferencesOf(entry)) {
      if (ref.spec === null) {
        // an unresolvable reference is NOT "no reference" — fail loud
        problems.push(`${portFile}: statically unresolvable ${ref.form} in port closure member ${file}`);
        continue;
      }
      if (ref.spec.startsWith('.')) queue.push(resolveRelative(file, ref.spec));
    }
  }
  return problems;
}

/**
 * Production gate rule 2: only the exact allowlist may import concrete
 * persistence modules.
 */
export function concreteImportViolations(
  sources: SourceEntry[],
  allowlist: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const entry of sources) {
    if (!entry.path.startsWith('packages/backend/src')) continue;
    if (allowlist.has(entry.path)) continue;
    for (const ref of localReferencesOf(entry)) {
      if (ref.spec === null) {
        // production has no dynamic-expression imports today; a new one is a
        // boundary decision, not something to skip silently
        offenders.push(`${entry.path} has a statically unresolvable ${ref.form} — fail loud`);
        continue;
      }
      if (!ref.spec.startsWith('.')) continue;
      // match on the RESOLVED target path, not the raw specifier — a
      // same-directory `./auth-uow.js` import must be caught too
      if (CONCRETE_PERSISTENCE_FILES.has(resolveRelative(entry.path, ref.spec))) {
        offenders.push(`${entry.path} imports ${ref.spec}`);
      }
    }
  }
  return offenders;
}

/**
 * Production gate rule 3 (#task:1981 criterion R2): a converged domain's
 * application files name NO module under `prefixes`, in any reference form. A
 * fenced file missing from the tree is a violation, not a silent pass —
 * otherwise renaming a file would quietly retire its fence.
 */
export function moduleReferenceViolations(
  fencedFiles: readonly string[],
  readSource: ReadSource,
  prefixes: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const file of fencedFiles) {
    const src = readSource(file);
    if (src === null) {
      problems.push(`${file}: missing from tree`);
      continue;
    }
    for (const ref of localReferencesOf({ path: file, src })) {
      if (ref.spec === null) {
        problems.push(`${file}: statically unresolvable ${ref.form} — fail loud`);
        continue;
      }
      if (!ref.spec.startsWith('.')) continue;
      const resolved = resolveRelative(file, ref.spec);
      if (prefixes.some(p => resolved.startsWith(p))) {
        problems.push(`${file} imports ${ref.spec}`);
      }
    }
  }
  return problems;
}

const REPOS_PREFIX = 'packages/backend/src/repos/';

/**
 * The persistence-composition surface boot may not name (#task:1983 W1): the
 * repositories and the three effect adapters. `src/adapters/` holds nothing but
 * persistence adapters, so the whole directory is the fence — a fourth adapter
 * is covered the day it is written, which a file-by-file list would not do.
 */
const PERSISTENCE_MODULE_PREFIXES = [REPOS_PREFIX, 'packages/backend/src/adapters/'];

/** The `repos/*`-only case, which every converged-domain fence below uses. */
export function repoDependencyViolations(
  fencedFiles: readonly string[],
  readSource: ReadSource,
): string[] {
  return moduleReferenceViolations(fencedFiles, readSource, [REPOS_PREFIX]);
}

describe('db-boundary: port/concrete boundary', () => {
  const fsRead: ReadSource = file => {
    try {
      return readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      return null;
    }
  };

  it('port modules are driver-free across their whole relative import closure', () => {
    expect(PORT_MODULES.flatMap(f => portClosureDriverViolations(f, fsRead))).toEqual([]);
  });

  it('every port module in the tree is listed (a new one cannot be born unfenced)', () => {
    // Completeness, not just correctness: without this, adding
    // `services/x/ports.ts` would silently skip the driver-free closure check.
    // Naming convention IS the enumeration rule — `ports.ts` / `*-ports.ts` /
    // `*-port.ts` under backend/src.
    const inTree = allProductionSources()
      .map(e => e.path)
      .filter(p => /(?:^|\/)(?:[a-z-]*-)?ports?\.ts$/.test(p) && p.startsWith('packages/backend/src/'))
      .sort();
    expect(
      inTree,
      'a port module exists that PORT_MODULES does not name — add it (or rename the file if it is not a port)',
    ).toEqual([...PORT_MODULES].sort());
  });

  it('only the exact composition allowlist imports the concrete persistence', () => {
    expect(
      concreteImportViolations(allProductionSources(), CONCRETE_IMPORTERS),
      'application/service code depends on ports, not concrete SQLite implementations; ' +
        'only the named composition files may wire concretes',
    ).toEqual([]);
  });

  it('no stale allowlist row: every named composition file still wires a concrete', () => {
    // #task:1983 W1 — an allowlist row that no longer needs to exist is a
    // STANDING WAIVER: the file keeps permission it stopped using, so the day
    // someone re-adds a concrete import there the gate says nothing. (This is
    // not hypothetical: W1 made `routes.ts`'s row stale by moving the wiring to
    // `persistence/root.ts`, and only a hand review caught it. The same pass
    // found `adapters/unread-publish.ts`'s row unexercised.)
    //
    // Scope: rows for files that are NOT themselves concrete persistence
    // modules. A concrete's own row states its ZONE — peer concretes may
    // compose each other, and one that happens not to today is not stale. A
    // row whose ONLY justification is "I am a composition / effect site" must
    // be load-bearing or gone. The question is asked through the same
    // reference-form machinery as the gate above, so re-export and require
    // laundering count as wiring here too.
    const named = [...CONCRETE_IMPORTERS]
      .filter(path => !CONCRETE_PERSISTENCE_FILES.has(path))
      .sort()
      .map(path => ({ path, src: fsRead(path) }));
    const missing = named.filter(e => e.src === null).map(e => `${e.path}: missing from tree`);
    const present = named.filter(
      (e): e is { path: string; src: string } => e.src !== null,
    );
    // Empty allowlist ⇒ every concrete reference is reported, keyed by file.
    const stillWiring = new Set(
      concreteImportViolations(present, new Set<string>()).map(v => v.split(' ')[0]),
    );
    const stale = present.map(e => e.path).filter(p => !stillWiring.has(p));
    expect(
      [...missing, ...stale],
      'this file is on the concrete-import allowlist but imports no concrete persistence ' +
        'module any more — delete its row (a stale row is a silent permission)',
    ).toEqual([]);
  });

  it('boot composes no persistence: index.ts names no repos/* or adapters/* module (#task:1983 W1)', () => {
    // The gate the composition-zone cardinality check CANNOT be: `index.ts`
    // never imports better-sqlite3 — it gets its handle from `openDatabase()` —
    // so every import-inventory gate is blind to boot growing a second
    // persistence assembly. Six such constructions existed when W1 first
    // landed (`new SqliteAuthCredentialsRepo(db)`, `createSqliteConversationPersistence(db)`,
    // `createUnreadPublishAdapter({db})`, `createMentionCcAdapter({db})`,
    // `createSqliteTaskPersistence(db)`, `createRuntimeFanoutDbDeps({db})`), all
    // green. This fence is what makes "one composition root" a checkable claim
    // instead of a comment: boot may open, migrate, instrument and close the
    // database, and it may not name a module that turns the handle into
    // persistence.
    expect(
      moduleReferenceViolations(BOOT_FENCED_FILES, fsRead, PERSISTENCE_MODULE_PREFIXES),
      'boot owns the DRIVER, not persistence: take the dependency from ' +
        '`createBackendPersistence(db)` (add a narrow named builder to ' +
        '`BackendPersistenceEffects` if it needs an event bus / logger / runtime host)',
    ).toEqual([]);

    // positive self-tests through the production helper: a repo, each effect
    // adapter, and a laundered dynamic form all redden from boot's real path.
    const boot = 'packages/backend/src/index.ts';
    for (const [src, spec] of [
      ["import { SqliteAuthSessionsRepo } from './repos/auth-sessions-repo.js';", './repos/auth-sessions-repo.js'],
      ["import { AgentRepo } from './repos/agent-repo.js';", './repos/agent-repo.js'],
      // the exact falsifier the #1983 W1 review asked for: a NEW SQLite thing
      // wired in boot, importing no driver at all
      ["import { createSqliteProbePersistence } from './repos/probe-persistence.js';", './repos/probe-persistence.js'],
      ["import { createUnreadPublishAdapter } from './adapters/unread-publish.js';", './adapters/unread-publish.js'],
      ["import { createMentionCcAdapter } from './adapters/mention-cc.js';", './adapters/mention-cc.js'],
      ["const m = await import('./adapters/runtime-fanout.js');", './adapters/runtime-fanout.js'],
    ] as const) {
      expect(
        moduleReferenceViolations([boot], p => (p === boot ? src : null), PERSISTENCE_MODULE_PREFIXES),
        `not reddened: ${src}`,
      ).toEqual([`${boot} imports ${spec}`]);
    }

    // negative: what boot legitimately keeps — the driver adapter, statement
    // instrumentation, the write probe and the composition root itself.
    expect(
      moduleReferenceViolations(
        [boot],
        () =>
          [
            "import { openDatabase } from './db.js';",
            "import { configureDatabaseObservation } from './observability/observed-statement.js';",
            "import { createSqliteDbWriteProbe } from './observability/db-write-probe.js';",
            "import { createBackendPersistence } from './persistence/root.js';",
          ].join('\n'),
        PERSISTENCE_MODULE_PREFIXES,
      ),
    ).toEqual([]);

    // and boot is NOT on the concrete-import allowlist any more, so the two
    // sides of this rule cannot disagree
    expect(CONCRETE_IMPORTERS.has(boot)).toBe(false);
  });

  it('the converged channel / conversation-message domain names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(CONVERSATION_DOMAIN_APP_FILES, fsRead),
      'these files reach persistence only through ports and the UnitOfWork scope; ' +
        'a `repos/*` reference re-opens the raw-DB boundary #task:1981 closed',
    ).toEqual([]);

    // positive self-tests: every module-reference form reddens THROUGH the
    // production helper, including nested and walked-back paths
    const probe = 'packages/backend/src/services/probe-service.ts';
    const forms: Array<{ src: string; spec: string }> = [
      {
        src: "import type { MessageRepo } from '../repos/message-repo.js';",
        spec: '../repos/message-repo.js',
      },
      {
        src: "import { ConversationRepo } from '../repos/conversation-repo.js';",
        spec: '../repos/conversation-repo.js',
      },
      {
        src: "import Repo = require('../repos/message-repo.js');",
        spec: '../repos/message-repo.js',
      },
      {
        src: "type R = import('../repos/message-repo.js').MessageRepo;",
        spec: '../repos/message-repo.js',
      },
      { src: "const m = await import('../repos/message-repo.js');", spec: '../repos/message-repo.js' },
      { src: "const m = require('../repos/message-repo.js');", spec: '../repos/message-repo.js' },
      {
        src: "export { MessageRepo } from '../repos/message-repo.js';",
        spec: '../repos/message-repo.js',
      },
      {
        // walking back out of a subdirectory resolves to the same fence
        src: "import type { X } from '../../src/repos/message-repo.js';",
        spec: '../../src/repos/message-repo.js',
      },
    ];
    for (const f of forms) {
      expect(
        repoDependencyViolations([probe], p => (p === probe ? f.src : null)),
        `not reddened: ${f.src}`,
      ).toEqual([`${probe} imports ${f.spec}`]);
    }

    // negative: ports, shared and sibling application modules stay green
    expect(
      repoDependencyViolations([probe], () =>
        [
          "import type { MessageUnitOfWork } from './conversation-message/ports.js';",
          "import { parseReference } from '@silverhand/shared';",
          "import type { BackendLogger } from '../context.js';",
        ].join('\n'),
      ),
    ).toEqual([]);

    // a fenced file that disappeared fails loud instead of passing silently
    expect(repoDependencyViolations(['packages/backend/src/services/gone.ts'], () => null)).toEqual([
      'packages/backend/src/services/gone.ts: missing from tree',
    ]);

    // an unresolvable dynamic reference in a fenced file is fail-loud too
    expect(
      repoDependencyViolations([probe], () => 'const m = await import(pickModule());')[0],
    ).toMatch(/statically unresolvable dynamic-import — fail loud/);
  });

  it('the converged human-identity domain names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(USER_DOMAIN_APP_FILES, fsRead),
      'both identity-create paths reach persistence only through services/user/ports.ts ' +
        'and the registration UnitOfWork scope; a `repos/*` reference re-opens the raw-DB ' +
        'boundary #task:1982 closed',
    ).toEqual([]);

    // positive self-test through the production helper, on a file of THIS fence
    const fenced = 'packages/backend/src/services/user-service.ts';
    expect(
      repoDependencyViolations([fenced], p =>
        p === fenced ? "import { UserRepo } from '../repos/user-repo.js';" : null,
      ),
    ).toEqual([`${fenced} imports ../repos/user-repo.js`]);
    // the persistence composition is NOT in this fence — it is where the
    // concrete repos are legally wired
    expect(USER_DOMAIN_APP_FILES).not.toContain(
      'packages/backend/src/repos/user-persistence.ts',
    );
  });

  it('the converged mention-cc use case names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(MENTION_CC_APP_FILES, fsRead),
      'the cc fan-out reaches persistence only through the ports it declares; its two ' +
        'former inline statements now delegate to existing repo methods inside ' +
        'adapters/mention-cc.ts, which is where the `Database` handle stops',
    ).toEqual([]);

    // positive self-test through the production helper, on a file of THIS fence
    const fenced = 'packages/backend/src/application/mention-cc.ts';
    expect(
      repoDependencyViolations([fenced], p =>
        p === fenced
          ? "import { ConversationReadRepo } from '../repos/conversation-read-repo.js';"
          : null,
      ),
    ).toEqual([`${fenced} imports ../repos/conversation-read-repo.js`]);
    // The adapter that wires the concretes stays OUT of the fence, and
    // `conversation-repo` / `message-repo` stay out of the composition
    // allowlist: they still have many unconverged callers, so allowing them
    // there would silence the fence for everyone else (#task:1982 R2).
    expect(MENTION_CC_APP_FILES).not.toContain(
      'packages/backend/src/adapters/mention-cc.ts',
    );
    for (const repo of [
      'packages/backend/src/repos/conversation-repo.ts',
      'packages/backend/src/repos/message-repo.ts',
    ]) {
      expect(CONCRETE_PERSISTENCE_FILES.has(repo), repo).toBe(false);
    }
  });

  it('the converged outbound runtime fanout names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(RUNTIME_FANOUT_APP_FILES, fsRead),
      'the fanout keeps its in-process runtime authority but reaches persistence only ' +
        'through runtime/persistence-ports.ts; a `repos/*` reference re-opens the raw-DB ' +
        'boundary #task:1982 W3 closed',
    ).toEqual([]);

    // positive self-tests through the production helper, on files of THIS fence
    // — one per fenced file, so neither the implementation nor its port module
    // can regain a concrete quietly.
    for (const [fenced, src, spec] of [
      [
        'packages/backend/src/runtime/outbound-event-fanout.ts',
        "import { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';",
        '../repos/conversation-inbox-repo.js',
      ],
      [
        'packages/backend/src/runtime/persistence-ports.ts',
        "import type { MessageRow } from '../repos/message-repo.js';",
        '../repos/message-repo.js',
      ],
      [
        'packages/backend/src/runtime/event-perimeter.ts',
        "import type { AgentRepo } from '../repos/agent-repo.js';",
        '../repos/agent-repo.js',
      ],
    ] as const) {
      expect(
        repoDependencyViolations([fenced], p => (p === fenced ? src : null)),
        `not reddened: ${fenced}`,
      ).toEqual([`${fenced} imports ${spec}`]);
    }

    // The composition module stays OUT of the fence — it is where the concrete
    // repos, the reconcile JOIN and the `db.transaction` are legally wired.
    expect(RUNTIME_FANOUT_APP_FILES).not.toContain(
      'packages/backend/src/adapters/runtime-fanout.ts',
    );
  });

  it('the converged host domain names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(HOST_DOMAIN_APP_FILES, fsRead),
      'credential lifecycle and the setup/finalize lifecycle reach persistence only ' +
        'through auth/host-ports.ts and the host UnitOfWork scope; a `repos/*` reference ' +
        're-opens the raw-DB boundary #task:1982 W5 closed',
    ).toEqual([]);

    // positive self-tests through the production helper, one per fenced file, so
    // neither a use case nor the port module can regain a concrete quietly.
    for (const [fenced, src, spec] of [
      [
        'packages/backend/src/auth/host-ports.ts',
        "import type { HostRepo } from '../repos/host-repo.js';",
        '../repos/host-repo.js',
      ],
      [
        'packages/backend/src/auth/host-token.ts',
        "import { SqliteHostCredentialsRepo } from '../repos/host-credentials-repo.js';",
        '../repos/host-credentials-repo.js',
      ],
      [
        'packages/backend/src/application/create-host-invite.ts',
        "import type { HostRepo } from '../repos/host-repo.js';",
        '../repos/host-repo.js',
      ],
      [
        // the shape W5 removed: reading the host row through a repo is what let
        // the finalize decision be taken outside the transaction that acts on it
        'packages/backend/src/application/update-host.ts',
        "import type { HostRepo } from '../repos/host-repo.js';",
        '../repos/host-repo.js',
      ],
    ] as const) {
      expect(
        repoDependencyViolations([fenced], p => (p === fenced ? src : null)),
        `not reddened: ${fenced}`,
      ).toEqual([`${fenced} imports ${spec}`]);
    }

    // The persistence composition stays OUT of the fence — it is where the
    // concrete host repos are legally wired — and so does `revoke-host.ts`,
    // whose `HostRepo` read side is the named residual above. Asserting the
    // exclusion keeps that residual visible instead of letting a later "just add
    // it to the fence" quietly turn red into green.
    expect(HOST_DOMAIN_APP_FILES).not.toContain('packages/backend/src/repos/host-uow.ts');
    expect(HOST_DOMAIN_APP_FILES).not.toContain(
      'packages/backend/src/application/revoke-host.ts',
    );
  });

  it('the converged membership cascade names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(MEMBERSHIP_CASCADE_APP_FILES, fsRead),
      'the removal cascade reaches persistence only through membership-ports.ts and the ' +
        'membership UnitOfWork scope; a `repos/*` reference re-opens the pre-#1982 shape ' +
        'where the conversation set was listed outside the transaction that acted on it',
    ).toEqual([]);

    for (const [fenced, src, spec] of [
      [
        'packages/backend/src/application/membership-ports.ts',
        "import type { ConversationRepo } from '../repos/conversation-repo.js';",
        '../repos/conversation-repo.js',
      ],
      [
        // the exact shape W5 removed: the cascade holding the conversation and
        // message repos and opening its own transaction over them
        'packages/backend/src/application/remove-workspace-member.ts',
        "import { MessageRepo } from '../repos/message-repo.js';",
        '../repos/message-repo.js',
      ],
      [
        'packages/backend/src/application/conversation-member-audit.ts',
        "import { WorkspaceRepo } from '../repos/workspace-repo.js';",
        '../repos/workspace-repo.js',
      ],
    ] as const) {
      expect(
        repoDependencyViolations([fenced], p => (p === fenced ? src : null)),
        `not reddened: ${fenced}`,
      ).toEqual([`${fenced} imports ${spec}`]);
    }

    // The persistence composition stays OUT of the fence — it is the one place
    // the conversation / message / workspace repos are legally wired — and so
    // does the route module, which still composes the other membership paths.
    expect(MEMBERSHIP_CASCADE_APP_FILES).not.toContain(
      'packages/backend/src/repos/membership-persistence.ts',
    );
    expect(MEMBERSHIP_CASCADE_APP_FILES).not.toContain(
      'packages/backend/src/application/conversation-member.ts',
    );
  });

  it('the converged agent / computer teardown names no repos/* module (R2)', () => {
    expect(
      repoDependencyViolations(AGENT_TEARDOWN_APP_FILES, fsRead),
      'both delete paths reach persistence only through application/agent-teardown-ports.ts ' +
        'and the teardown UnitOfWork scope; a `repos/*` reference re-opens the pre-#1987 shape ' +
        'where delete eligibility and the blob refs were read outside the transaction that ' +
        'consumed them',
    ).toEqual([]);

    // positive self-tests through the production helper, ONE PER FENCED FILE, so
    // neither use case nor the port module can regain a concrete quietly.
    for (const [fenced, src, spec] of [
      [
        'packages/backend/src/application/agent-teardown-ports.ts',
        "import type { AgentRow } from '../repos/agent-repo.js';",
        '../repos/agent-repo.js',
      ],
      [
        // the exact shape D removed: the single-agent path holding the repos and
        // deleting the membership rows itself, outside any scope
        'packages/backend/src/application/delete-agent.ts',
        "import { WorkspaceRepo } from '../repos/workspace-repo.js';",
        '../repos/workspace-repo.js',
      ],
      [
        'packages/backend/src/application/delete-computer.ts',
        "import { AgentRepo } from '../repos/agent-repo.js';",
        '../repos/agent-repo.js',
      ],
    ] as const) {
      expect(
        repoDependencyViolations([fenced], p => (p === fenced ? src : null)),
        `not reddened: ${fenced}`,
      ).toEqual([`${fenced} imports ${spec}`]);
    }

    // The persistence composition stays OUT of the fence — it is the one place
    // the agent / workspace / conversation / attachment / host repos are legally
    // wired for this domain.
    expect(AGENT_TEARDOWN_APP_FILES).not.toContain(
      'packages/backend/src/repos/agent-teardown-persistence.ts',
    );
  });

  it('gate self-test: another repo/adapter file copying the fanout composition\'s imports reddens', () => {
    // The composition module is allowed to name concrete repos ONLY because it
    // is on the allowlist. Prove the allowlist is what carries that permission:
    // the SAME import lines, from a neighbouring repos/ or adapters/ file, must
    // redden through the production gate. Otherwise "wire it in an adapter"
    // would be a general waiver rather than one named place.
    const copied = [
      "import { createRuntimeFanoutDbDeps } from './runtime-fanout.js';",
      "import { createRuntimeFanoutDbDeps } from '../adapters/runtime-fanout.js';",
    ];
    const synthetic: SourceEntry[] = [
      { path: 'packages/backend/src/adapters/runtime-fanout-copy.ts', src: copied[0]! },
      { path: 'packages/backend/src/repos/runtime-fanout-sneak.ts', src: copied[1]! },
      // dynamic forms cannot dodge it either
      {
        path: 'packages/backend/src/adapters/runtime-fanout-dynamic.ts',
        src: "const m = await import('./runtime-fanout.js');",
      },
    ];
    expect(concreteImportViolations(synthetic, CONCRETE_IMPORTERS)).toEqual([
      'packages/backend/src/adapters/runtime-fanout-copy.ts imports ./runtime-fanout.js',
      'packages/backend/src/repos/runtime-fanout-sneak.ts imports ../adapters/runtime-fanout.js',
      'packages/backend/src/adapters/runtime-fanout-dynamic.ts imports ./runtime-fanout.js',
    ]);

    // and the real composition file, at its real path, stays green
    expect(
      concreteImportViolations(
        [
          {
            path: 'packages/backend/src/adapters/runtime-fanout.ts',
            src: "import { ConversationRepo } from '../repos/conversation-repo.js';",
          },
        ],
        CONCRETE_IMPORTERS,
      ),
    ).toEqual([]);
  });

  it('module-reference authority: table-driven coverage of every reference form', () => {
    const table: Array<{ src: string; form: string; spec: string | null }> = [
      { src: "import { X } from './a.js';", form: 'static-import', spec: './a.js' },
      { src: "export { X } from './a.js';", form: 'static-export', spec: './a.js' },
      { src: "import Uow = require('./a.js');", form: 'import-equals', spec: './a.js' },
      { src: "type H = import('./a.js').H;", form: 'import-type', spec: './a.js' },
      { src: "const m = await import('./a.js');", form: 'dynamic-import', spec: './a.js' },
      { src: "const m = require('./a.js');", form: 'require', spec: './a.js' },
      { src: 'const m = await import(pathVar);', form: 'dynamic-import', spec: null },
      { src: 'const m = require(pathVar);', form: 'require', spec: null },
    ];
    for (const row of table) {
      const refs = localReferencesOf({ path: 'probe.ts', src: row.src });
      expect(refs, `not enumerated: ${row.src}`).toEqual([{ form: row.form, spec: row.spec }]);
    }
  });

  it('gate self-test: import-equals and unresolvable references redden THROUGH the production gates', () => {
    // import = require of a concrete, from a non-allowlisted file
    const equalsOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/equals-sneak.ts',
          src: "import Uow = require('../repos/auth-uow.js');",
        },
      ],
      CONCRETE_IMPORTERS,
    );
    expect(equalsOffenders).toEqual([
      'packages/backend/src/services/equals-sneak.ts imports ../repos/auth-uow.js',
    ]);

    // statically unresolvable dynamic reference is fail-loud, not "no reference"
    const unresolvedOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/opaque-sneak.ts',
          src: 'const m = await import(pickModule());',
        },
      ],
      CONCRETE_IMPORTERS,
    );
    expect(unresolvedOffenders).toHaveLength(1);
    expect(unresolvedOffenders[0]).toMatch(/statically unresolvable dynamic-import — fail loud/);

    // port closure: import-equals laundering hop is followed; unresolvable member fails loud
    const equalsTree = new Map<string, string>([
      ['pkg/ports.ts', "import Hop = require('./hop.js');\nexport type H = typeof Hop;"],
      ['pkg/hop.ts', "export type { Database as H } from 'better-sqlite3';"],
    ]);
    expect(
      portClosureDriverViolations('pkg/ports.ts', f => equalsTree.get(f) ?? null),
    ).toHaveLength(1);
    expect(
      portClosureDriverViolations('p.ts', f =>
        f === 'p.ts' ? 'const m = await import(pickModule());' : null,
      )[0],
    ).toMatch(/statically unresolvable dynamic-import/);
  });

  it('gate self-test: multi-hop re-export laundering reddens THROUGH the production gate', () => {
    const tree = new Map<string, string>([
      ['pkg/ports.ts', "import type { Handle } from './hop1.js';\nexport interface P { get(id: string): Handle }"],
      ['pkg/hop1.ts', "export type { Handle } from './hop2.js';"],
      ['pkg/hop2.ts', "export type { Database as Handle } from 'better-sqlite3';"],
    ]);
    const read: ReadSource = f => tree.get(f) ?? null;
    const problems = portClosureDriverViolations('pkg/ports.ts', read);
    expect(problems.length).toBe(1);
    expect(problems[0]).toMatch(/reaches better-sqlite3 through pkg\/hop2\.ts/);

    // direct naming and aliased type import redden too
    expect(
      portClosureDriverViolations('p.ts', f =>
        f === 'p.ts' ? "import type { Database as Db } from 'better-sqlite3';" : null,
      ),
    ).toHaveLength(1);

    // inline `import('./hop1.js').T` TYPE reference launders through the
    // closure too — the visitor must feed it into the queue
    const typeRefTree = new Map<string, string>([
      ['pkg/ports.ts', "export type Handle = import('./hop1.js').Handle;"],
      ['pkg/hop1.ts', "export type { Handle } from './hop2.js';"],
      ['pkg/hop2.ts', "export type { Database as Handle } from 'better-sqlite3';"],
    ]);
    const typeRefProblems = portClosureDriverViolations('pkg/ports.ts', f => typeRefTree.get(f) ?? null);
    expect(typeRefProblems.length).toBe(1);
    expect(typeRefProblems[0]).toMatch(/reaches better-sqlite3 through pkg\/hop2\.ts/);

    // clean multi-hop closure stays green
    const clean = new Map<string, string>([
      ['pkg/ports.ts', "import type { Row } from './types.js';\nexport interface P { get(id: string): Row }"],
      ['pkg/types.ts', 'export interface Row { id: string }'],
    ]);
    expect(portClosureDriverViolations('pkg/ports.ts', f => clean.get(f) ?? null)).toEqual([]);

    // unresolvable closure members fail loud instead of being skipped
    expect(
      portClosureDriverViolations('pkg/ports.ts', f =>
        f === 'pkg/ports.ts' ? "import type { X } from './missing.js';" : null,
      ),
    ).toHaveLength(1);
  });

  it('gate self-test: a NON-allowlisted repos file importing a concrete reddens THROUGH the production gate', () => {
    const synthetic: SourceEntry[] = [
      {
        path: 'packages/backend/src/repos/some-other-repo.ts',
        src: "import { SqliteAuthCredentialsRepo } from './auth-credentials-repo.js';",
      },
      {
        path: 'packages/backend/src/services/sneaky-service.ts',
        src: "import { createSqliteAuthUnitOfWork } from '../repos/auth-uow.js';",
      },
      {
        // #task:1983 W1: boot lost its allowlist row, so the same import that
        // used to be legal here is now a violation like any other caller's
        path: 'packages/backend/src/index.ts',
        src: "import { createSqliteAuthUnitOfWork } from './repos/auth-uow.js';",
      },
    ];
    const offenders = concreteImportViolations(synthetic, CONCRETE_IMPORTERS);
    expect(offenders).toEqual([
      "packages/backend/src/repos/some-other-repo.ts imports ./auth-credentials-repo.js",
      "packages/backend/src/services/sneaky-service.ts imports ../repos/auth-uow.js",
      "packages/backend/src/index.ts imports ./repos/auth-uow.js",
    ]);

    // the conversation persistence composition is fenced the same way
    expect(
      concreteImportViolations(
        [
          {
            path: 'packages/backend/src/services/conversation-sneak.ts',
            src: "import { createSqliteConversationPersistence } from '../repos/conversation-persistence.js';",
          },
        ],
        CONCRETE_IMPORTERS,
      ),
    ).toEqual([
      'packages/backend/src/services/conversation-sneak.ts imports ../repos/conversation-persistence.js',
    ]);

    // dynamic import / require of a concrete cannot dodge the allowlist either
    const dynamicOffenders = concreteImportViolations(
      [
        {
          path: 'packages/backend/src/services/dynamic-sneak.ts',
          src: "const m = await import('../repos/auth-uow.js');",
        },
        {
          path: 'packages/backend/src/services/require-sneak.ts',
          src: "const { SqliteAuthSessionsRepo } = require('../repos/auth-sessions-repo.js');",
        },
      ],
      CONCRETE_IMPORTERS,
    );
    expect(dynamicOffenders).toHaveLength(2);
  });

  it('TaskRepoWritePort is importable ONLY by the task persistence composition (write capability lives on TxScope)', () => {
    // P1-2 (#task:1980): "write capability exists only on TaskTxScope" is a
    // CONTRACT, so it is also a GATE — an arbitrary new service importing and
    // injecting TaskRepoWritePort would bypass the UoW and must redden. The
    // gate reuses the SAME module-reference discipline as the port-closure
    // rules: static named/alias import, namespace import, inline ImportType,
    // import-equals, dynamic import / require, and one-hop re-export all
    // count — no narrower enumeration than the rest of the boundary suite.
    const WRITE_PORT = 'TaskRepoWritePort';
    const TASK_WRITE_PORT_ALLOWED = new Set([
      'packages/backend/src/services/task/ports.ts', // the definition
      'packages/backend/src/repos/task-repo.ts', // the concrete implementation
      'packages/backend/src/repos/task-persistence.ts', // the composition
    ]);
    const TASK_PORTS_TARGET = 'packages/backend/src/services/task/ports.ts';

    const writePortImporters = (sources: SourceEntry[]): string[] => {
      const offenders: string[] = [];
      for (const entry of sources) {
        if (!entry.path.startsWith('packages/backend/src')) continue;
        if (TASK_WRITE_PORT_ALLOWED.has(entry.path)) continue;
        const sf = parse(entry);
        const targetsPorts = (spec: string): boolean =>
          resolveRelative(entry.path, spec) === TASK_PORTS_TARGET;
        let flag = false;

        for (const stmt of sf.statements) {
          if (ts.isImportDeclaration(stmt)) {
            const spec = stmt.moduleSpecifier;
            if (!ts.isStringLiteral(spec) || !targetsPorts(spec.text)) continue;
            const clause = stmt.importClause;
            if (!clause) continue;
            if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
              flag = true; // whole module bound — TaskRepoWritePort reachable
              continue;
            }
            if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
              for (const el of clause.namedBindings.elements) {
                if ((el.propertyName?.text ?? el.name.text) === WRITE_PORT) flag = true;
              }
            }
          } else if (ts.isExportDeclaration(stmt)) {
            const spec = stmt.moduleSpecifier;
            if (!spec || !ts.isStringLiteral(spec) || !targetsPorts(spec.text)) continue;
            // `export * from` re-exports the whole module (write port included)
            if (!stmt.exportClause) {
              flag = true;
              continue;
            }
            if (ts.isNamespaceExport(stmt.exportClause)) {
              // `export * as TaskPorts from './task/ports.js'` — the whole
              // module is reachable through the namespace, so the write port
              // escapes. Fail closed.
              flag = true;
              continue;
            }
            if (ts.isNamedExports(stmt.exportClause)) {
              for (const el of stmt.exportClause.elements) {
                if ((el.propertyName?.text ?? el.name.text) === WRITE_PORT) flag = true;
              }
            }
          } else if (ts.isImportEqualsDeclaration(stmt)) {
            const ref = stmt.moduleReference;
            if (
              ts.isExternalModuleReference(ref) &&
              ref.expression &&
              ts.isStringLiteral(ref.expression) &&
              targetsPorts(ref.expression.text)
            ) {
              flag = true;
            }
          }
        }

        // Inline `import('...').X` type refs and dynamic import / require
        const walk = (node: ts.Node): void => {
          if (ts.isImportTypeNode(node)) {
            if (
              node.argument &&
              ts.isLiteralTypeNode(node.argument) &&
              ts.isStringLiteral(node.argument.literal) &&
              targetsPorts(node.argument.literal.text)
            ) {
              flag = true;
            }
          } else if (ts.isCallExpression(node)) {
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire =
              ts.isIdentifier(node.expression) && node.expression.text === 'require';
            if (isDynamicImport || isRequire) {
              const arg = node.arguments[0];
              if (arg && ts.isStringLiteral(arg) && targetsPorts(arg.text)) flag = true;
            }
          }
          ts.forEachChild(node, walk);
        };
        walk(sf);

        if (flag) offenders.push(entry.path);
      }
      return offenders;
    };

    // production: no importer outside the allowed set
    expect(
      writePortImporters(allProductionSources()),
      'TaskRepoWritePort must stay confined to the task persistence composition; ' +
        'application code receives write capability only through TaskTxScope',
    ).toEqual([]);

    // synthetic cases drive the SAME production helper and redden across every
    // module-reference form the port-closure suite already treats as evidence
    const cases: Array<{ path: string; src: string }> = [
      {
        path: 'packages/backend/src/services/write-sneak.ts',
        src: `import type { TaskRepoWritePort } from './task/ports.js';\nconst w: TaskRepoWritePort = null as never;`,
      },
      {
        path: 'packages/backend/src/services/write-alias-sneak.ts',
        src: `import { TaskRepoWritePort as Write } from './task/ports.js';\nconst w: Write = null as never;`,
      },
      {
        path: 'packages/backend/src/services/write-ns-sneak.ts',
        src: `import * as TaskPorts from './task/ports.js';\nconst w: TaskPorts.TaskRepoWritePort = null as never;`,
      },
      {
        path: 'packages/backend/src/services/write-type-sneak.ts',
        src: `type W = import('./task/ports.js').TaskRepoWritePort;\nconst w: W = null as never;`,
      },
      {
        path: 'packages/backend/src/services/write-equals-sneak.ts',
        src: `import TaskPorts = require('./task/ports.js');\nconst w: TaskPorts.TaskRepoWritePort = null as never;`,
      },
      {
        path: 'packages/backend/src/services/write-dynamic-sneak.ts',
        src: `const m = await import('./task/ports.js');\nvoid m;`,
      },
      {
        path: 'packages/backend/src/services/write-require-sneak.ts',
        src: `const m = require('./task/ports.js');\nvoid m;`,
      },
      {
        path: 'packages/backend/src/services/write-reexport-sneak.ts',
        src: `export { TaskRepoWritePort } from './task/ports.js';`,
      },
      {
        path: 'packages/backend/src/services/write-ns-reexport-sneak.ts',
        src: `export * as TaskPorts from './task/ports.js';`,
      },
    ];
    for (const c of cases) {
      expect(writePortImporters([c]), `not reddened: ${c.path}`).toEqual([c.path]);
    }
  });

  it('application code is fenced from driver error dialects (P1-1)', () => {
    // The source-conflict sentinel contract: `SQLITE_*` codes, `SqliteError`,
    // and constraint-message parsing must never re-enter the APPLICATION layer
    // — the adapter owns driver dialect translation. Driver *binding* is
    // checked structurally (scan.ts), not by text, so ordinary prose naming the
    // engine ("a single-writer engine (SQLite)", "better-sqlite3 transactions
    // are synchronous") stays legal: the fence keeps dialect HANDLING out of
    // application code, it does not police vocabulary.
    const DIALECT_FENCED_FILES = [
      ...TASK_APP_FILES,
      ...CONVERSATION_DOMAIN_APP_FILES,
      ...USER_DOMAIN_APP_FILES,
      ...MENTION_CC_APP_FILES,
      ...RUNTIME_FANOUT_APP_FILES,
      ...HOST_DOMAIN_APP_FILES,
      ...MEMBERSHIP_CASCADE_APP_FILES,
      ...AGENT_TEARDOWN_APP_FILES,
      // #task:1982 W4 — the readiness write probe took its `SQLITE_BUSY` /
      // `SQLITE_LOCKED` decoding with it when it left the HTTP layer, so the
      // route module can be held to the same fence as converged app code from
      // here on: it renders `db_writable`, it does not classify driver errors.
      'packages/backend/src/routes.ts',
    ];

    const driverDialectViolations = (
      files: readonly string[],
      readSource: ReadSource,
    ): string[] => {
      const ERROR_DIALECT =
        /\bSQLITE_[A-Z_]+\b|\bSqliteError\b|constraint\s+failed|constraint-message|includes\(\s*['"`]constraint/i;
      const problems: string[] = [];
      for (const file of files) {
        const src = readSource(file);
        if (src === null) {
          problems.push(`${file}: missing from tree`);
          continue;
        }
        if (scanBetterSqliteImports({ path: file, src }).length > 0) {
          problems.push(`${file}: driver-dialect leak: better-sqlite3 binding`);
          continue;
        }
        const match = src.match(ERROR_DIALECT);
        if (match) problems.push(`${file}: driver-dialect leak: ${match[0]}`);
      }
      return problems;
    };

    // production tree is clean
    expect(
      driverDialectViolations(DIALECT_FENCED_FILES, fsRead),
      'driver error translation lives in the persistence adapter; application code consumes driver-free sentinels only',
    ).toEqual([]);

    // synthetic POSITIVE cases redden through the production helper
    const positive: Array<{ file: string; src: string; marker: string }> = [
      {
        file: 'packages/backend/src/services/task-service.ts',
        src: `if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return;`,
        marker: 'SQLITE_CONSTRAINT_UNIQUE',
      },
      {
        file: 'packages/backend/src/services/task/contracts.ts',
        src: `if (e instanceof SqliteError) throw e;`,
        marker: 'SqliteError',
      },
      {
        file: 'packages/backend/src/services/task/board.ts',
        src: `if (err.message.includes('constraint')) return null;`,
        marker: "includes('constraint",
      },
      {
        file: 'packages/backend/src/services/conversation-message-service.ts',
        src: `if (/constraint failed/.test(e.message)) return;`,
        marker: 'constraint failed',
      },
      {
        // exactly what #task:1982 deleted from signup: deciding the business
        // answer by reading the engine's wording
        file: 'packages/backend/src/auth/user-auth-service.ts',
        src: `if (/constraint failed: users\\.email/.test((err as Error).message)) return { ok: false, code: 'auth_failed' };`,
        marker: 'constraint failed',
      },
      {
        file: 'packages/backend/src/services/user-service.ts',
        src: `if (err.code === 'SQLITE_CONSTRAINT_TRIGGER') throw new UserServiceError('name_taken', '');`,
        marker: 'SQLITE_CONSTRAINT_TRIGGER',
      },
      {
        // driver BINDING is caught structurally, in any alias form
        file: 'packages/backend/src/services/channel-service.ts',
        src: `import type { Database as Db } from 'better-sqlite3';`,
        marker: 'better-sqlite3 binding',
      },
      {
        file: 'packages/backend/src/services/conversation-message/ports.ts',
        src: `import type { Database } from 'better-sqlite3';`,
        marker: 'better-sqlite3 binding',
      },
    ];
    for (const c of positive) {
      expect(DIALECT_FENCED_FILES, `not fenced: ${c.file}`).toContain(c.file);
      // only the target file carries the synthetic dialect; the rest are empty
      // (so the helper does not report "missing from tree")
      const read = (f: string): string | null => (f === c.file ? c.src : '');
      const problems = driverDialectViolations(DIALECT_FENCED_FILES, read);
      expect(
        problems,
        `positive self-test did not redden: ${c.file} (${c.marker})`,
      ).toEqual([`${c.file}: driver-dialect leak: ${c.marker}`]);
    }

    // synthetic NEGATIVE cases: ordinary business wording and prose naming the
    // engine stay green — the fence must not force rewording comments
    const PROSE_CASES = new Map([
      [
        'packages/backend/src/services/task-service.ts',
        `// The workflow transition constraint means a todo task has no legal exit.`,
      ],
      [
        'packages/backend/src/services/channel-service.ts',
        `// rename + seed insert run in one transaction (better-sqlite3 transactions are synchronous).`,
      ],
      [
        'packages/backend/src/services/conversation-message/ports.ts',
        `// A single-writer engine (SQLite) satisfies this by construction.`,
      ],
    ]);
    for (const file of PROSE_CASES.keys()) {
      expect(DIALECT_FENCED_FILES, `not fenced: ${file}`).toContain(file);
    }
    expect(
      driverDialectViolations(DIALECT_FENCED_FILES, f => PROSE_CASES.get(f) ?? ''),
    ).toEqual([]);

    // a fenced file that disappeared fails loud instead of passing silently
    expect(driverDialectViolations(['packages/backend/src/services/gone.ts'], () => null)).toEqual([
      'packages/backend/src/services/gone.ts: missing from tree',
    ]);
  });
});
