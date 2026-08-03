/**
 * #task:1603/#task:1608 — eager Claude/Qoder session-namespace migration
 * (docs/app-data-layout-v2.md §5.2/§6.2, eager model). Hoisted from the
 * desktop layout-migration dir so desktop AND the connect daemon are two
 * composition entries over ONE migration unit (Cindy ruling 2026-07-25);
 * still Node-only and wholly deletable with the migration inventory.
 *
 * Third-party runtimes key their local session store by the process cwd.
 * The layout-v2 cutover moves every managed workspace cwd and agent-home
 * cwd, so the engine renames each affected per-cwd namespace ONCE, before
 * the caller's completion fact is written. cwd pairs are derived from the facet's
 * single authoritative source classification (engine.ts) — this module
 * only computes namespaces and executes the renames.
 *
 * This file lives in the deletable migration unit: it is removed together
 * with the rest of `layout-migration/` when the marker floor allows
 * (§7 discipline). It must never grow a runtime consumer.
 *
 * Inventory evidence (2026-07-24, dev-machine audit):
 *  - claude: `~/.claude/projects/<cwd-slug>` — proven cwd-derived
 *    (observed live in the countgaming2 incident) → migrate. Honors
 *    CLAUDE_CONFIG_DIR (absolute value byte-preserved; anything else
 *    unverifiable).
 *  - qoder:  `~/.qoder/projects/<cwd-slug>` — same slug scheme (audit
 *    closed on this machine); qodercli 1.0.48 honors QODER_CONFIG_DIR
 *    (`path.resolve(value).normalize('NFC')` when truthy) → migrate.
 *  - codex:  resume identity is a thread id owned by the app-server; not
 *    cwd-scoped (verified live) → no-op.
 *  - opencode: single global sqlite store — not cwd-partitioned → no-op.
 *  - cursor / gemini: NO local store on the audit machine; re-audit on a
 *    machine with real sessions BEFORE the migration release ships.
 *    Encoded as no-op pending that audit.
 *
 * The cwd slug replaces every `/`, `.`, and `_` with `-` (verified against
 * live Claude 2.1.220 and Qoder 1.1.5 probes). Slugs are only ever COMPUTED
 * from exact known cwds — never parsed back, never matched by prefix or
 * basename.
 *
 * The first shipped v2 migrator omitted `_` from this transform. A v2 cwd
 * containing an underscore was therefore renamed into a namespace neither
 * runtime would read. The repair pass below recognizes only that exact
 * historical transform and atomically renames it to the runtime coordinate;
 * it never scans or merges arbitrary project directories. The buggy source
 * slug necessarily still contains `_`, while the verified Claude 2.1.220 and
 * Qoder 1.1.5 transforms never do, so that source cannot be a live
 * vendor-written coordinate.
 */
import { lstatSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeKind } from '@silverhand/shared';

/**
 * Typed failure for the session handoff. Codes mirror the desktop layout
 * engine's taxonomy 1:1 so the desktop composition entry can wrap them
 * without translation loss; the connect entry consumes them directly.
 */
export class SessionMigrationError extends Error {
  constructor(
    readonly code:
      | 'layout_conflict'
      | 'layout_unreadable'
      | 'layout_special_file'
      | 'layout_move_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SessionMigrationError';
  }
}

export interface MigrationLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
}

/** The frozen set of runtimes whose session store is cwd-scoped. */
export const CWD_SCOPED_SESSION_RUNTIMES = ['claude', 'qoder'] as const;

export function cwdSessionSlug(cwd: string): string {
  return cwd.replace(/[\/._]/g, '-');
}

/** The buggy transform shipped by the first layout-v2 package. */
function legacyV2CwdSessionSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * The slug transform is VERIFIED only for POSIX absolute paths over
 * `[A-Za-z0-9/._-]` (live fixtures); we do not claim the vendors'
 * algorithm for other characters.
 */
export function isSlugVerifiableCwd(cwd: string): boolean {
  return /^[A-Za-z0-9/._-]+$/.test(cwd);
}

export interface SessionStoreEnv {
  CLAUDE_CONFIG_DIR?: string;
  QODER_CONFIG_DIR?: string;
}

/**
 * Normalize a store-root env override the way the CLI consumes it, or
 * refuse. Claude treats CLAUDE_CONFIG_DIR as a plain path: an absolute
 * value is used byte-preserved; ANY other defined value (empty,
 * whitespace, relative, ~) is unverifiable — the child would resolve it
 * against ITS cwd, which the migration cannot know.
 */
export function normalizeStoreRootOverride(
  value: string | undefined,
): { kind: 'none' } | { kind: 'root'; root: string } | { kind: 'unverifiable' } {
  if (value === undefined) return { kind: 'none' };
  if (value.startsWith('/')) return { kind: 'root', root: value };
  return { kind: 'unverifiable' };
}

/** qodercli 1.0.48 gates the override on truthiness (`if (Q) resolve(Q)
 *  else ~/.qoder`), so an EXACT empty string is unset — the child provably
 *  uses the default root. Whitespace and any other non-absolute value stay
 *  unverifiable. Claude keeps its conservative semantics unchanged. */
function qoderOverrideValue(env: SessionStoreEnv): string | undefined {
  return env.QODER_CONFIG_DIR === '' ? undefined : env.QODER_CONFIG_DIR;
}

function storeRootOverrideFor(
  kind: (typeof CWD_SCOPED_SESSION_RUNTIMES)[number],
  env: SessionStoreEnv,
): readonly [string, string | undefined] {
  return kind === 'claude'
    ? (['CLAUDE_CONFIG_DIR', env.CLAUDE_CONFIG_DIR] as const)
    : (['QODER_CONFIG_DIR', qoderOverrideValue(env)] as const);
}

/**
 * Whether the session store root for a cwd-scoped runtime can be located from
 * the given env. `sessionNamespaceFor` SILENTLY falls back to the default root
 * on an unverifiable override (it never throws), so any caller that will trust
 * its namespace path before mutating bytes must gate on this first. Reuses
 * `storeRootOverrideFor` so the qoder empty-string special-case lives in ONE
 * place; a non-cwd-scoped runtime has no store root to verify → always true.
 */
export function isSessionStoreRootVerifiable(
  kind: RuntimeKind,
  env: SessionStoreEnv,
): boolean {
  if (kind !== 'claude' && kind !== 'qoder') return true;
  const [, value] = storeRootOverrideFor(kind, env);
  return normalizeStoreRootOverride(value).kind !== 'unverifiable';
}

function sessionStoreRootFor(
  kind: (typeof CWD_SCOPED_SESSION_RUNTIMES)[number],
  sessionStoreHome: string,
  env: SessionStoreEnv,
): string {
  const [, value] = storeRootOverrideFor(kind, env);
  const override = normalizeStoreRootOverride(value);
  if (override.kind === 'root') {
    // Mirror qodercli exactly: its absolute override is resolved,
    // separator-normalized, and NFC-normalized before use.
    return kind === 'qoder'
      ? resolve(override.root).normalize('NFC')
      : override.root;
  }
  return join(sessionStoreHome, kind === 'claude' ? '.claude' : '.qoder');
}

/** The store CONFIG roots must match what the spawned child will actually
 *  use — the desktop process env is the same env the daemon (and thus the
 *  runtime child) inherits. Exhaustive over RuntimeKind so a future kind
 *  fails compilation instead of silently skipping migration policy. */
export function sessionNamespaceFor(
  kind: RuntimeKind,
  cwd: string,
  sessionStoreHome: string,
  env: SessionStoreEnv = {},
): string | null {
  switch (kind) {
    case 'claude':
    case 'qoder':
      return join(
        sessionStoreRootFor(kind, sessionStoreHome, env),
        'projects',
        cwdSessionSlug(cwd),
      );
    case 'codex':
      return null; // thread-id resume; not cwd-scoped (verified live)
    case 'opencode':
      return null; // single global sqlite store; not cwd-partitioned
    case 'cursor':
      return null; // no store on audit machine — re-audit before release
    case 'gemini':
      return null; // no store on audit machine — re-audit before release
    default: {
      const exhaustive: never = kind;
      throw new Error(
        `unhandled runtime kind in session migration inventory: ${String(exhaustive)}`,
      );
    }
  }
}

function legacyV2SessionNamespaceFor(
  kind: (typeof CWD_SCOPED_SESSION_RUNTIMES)[number],
  cwd: string,
  sessionStoreHome: string,
  env: SessionStoreEnv,
): string {
  return join(
    sessionStoreRootFor(kind, sessionStoreHome, env),
    'projects',
    legacyV2CwdSessionSlug(cwd),
  );
}

/** Only ENOENT is `absent`; any other lstat failure is `unreadable` and
 *  must never be read as "no sessions". The ordinary migration fails
 *  closed; the opportunistic released-bug repair skips that one coordinate.
 *  lstat never follows symlinks (§6.4). */
export type NamespaceState = 'absent' | 'dir' | 'special' | 'unreadable';

export function defaultNamespaceProbe(path: string): NamespaceState {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : 'unreadable';
  }
  return stat.isDirectory() ? 'dir' : 'special';
}

/** One migrated cwd: the pre-cutover physical path and its v2 successor.
 *  Both are resolver/slug products computed by the engine's source
 *  classification — never parsed off disk. */
export interface SessionCwdPair {
  oldCwd: string;
  newCwd: string;
}

export interface SessionPassDeps {
  sessionStoreHome: string;
  env: SessionStoreEnv;
  logger: MigrationLogger;
  probe?: (path: string) => NamespaceState;
  rename?: (from: string, to: string) => void;
}

export interface SessionPassResult {
  renamed: number;
}

type SessionSlugRepairSkipReason =
  | 'coexist'
  | 'legacy_unreadable'
  | 'current_unreadable'
  | 'legacy_special'
  | 'current_special'
  | 'rename_failed';

function warnSessionSlugRepairSkipped(
  logger: MigrationLogger,
  runtime: (typeof CWD_SCOPED_SESSION_RUNTIMES)[number],
  cwd: string,
  reason: SessionSlugRepairSkipReason,
): void {
  logger.warn(
    {
      action: 'runtime_session_namespace_slug_repair_skipped',
      reason,
      runtime,
      cwd,
    },
    'skipping one released session-slug repair coordinate because it cannot be renamed safely',
  );
}

/**
 * Repair the exact namespace typo produced by the first layout-v2 release.
 * The caller supplies authoritative cwd coordinates; this function never
 * enumerates the vendor store. Bad-present + good-absent is the only move
 * arm. Every other state is left byte-for-byte in place and warned per
 * runtime × cwd; this opportunity to recover old session history must never
 * become a startup gate.
 *
 * The repair population exists only where the first v2 migrator actually
 * renamed a pre-v2 namespace. Fresh init has no source namespace; no-namespace
 * and unflattened paths still enter the ordinary rename pass; connect-only
 * agent homes were never renamed. That is why completed desktop migration
 * repairs agents + workspaces, while daemon convergence repairs only
 * workspaces. Do not broaden this pass to make those entry points symmetric.
 *
 * Unlike the ordinary rename pass, this released-bug repair is opportunistic:
 * an unverifiable coordinate means "cannot prove this repair applies", not
 * "the active layout is unsafe". Skip the entire repair before touching bytes
 * and warn. Throwing would brick an otherwise healthy boot behind a startup
 * failure window that intentionally has no Retry action. The ordinary rename
 * pass below remains fail-closed because its migration cannot be completed
 * safely without verifying those same coordinates.
 */
export function runSessionSlugRepairPass(
  cwds: readonly string[],
  deps: SessionPassDeps,
): SessionPassResult {
  const probe = deps.probe ?? defaultNamespaceProbe;
  const rename = deps.rename ?? renameSync;
  const result: SessionPassResult = { renamed: 0 };
  const repairCwds = [...new Set(cwds)].filter(
    cwd => legacyV2CwdSessionSlug(cwd) !== cwdSessionSlug(cwd),
  );
  if (repairCwds.length === 0) return result;

  const verifiableRepairCwds = repairCwds.filter(cwd => {
    if (isSlugVerifiableCwd(cwd)) return true;
    deps.logger.warn(
      {
        action: 'runtime_session_namespace_slug_repair_skipped',
        reason: 'unverifiable_cwd',
        cwd,
      },
      'skipping one released session-slug repair coordinate because its cwd is outside the verified slug charset',
    );
    return false;
  });
  if (verifiableRepairCwds.length === 0) return result;

  for (const kind of CWD_SCOPED_SESSION_RUNTIMES) {
    const [envVar, envValue] = storeRootOverrideFor(kind, deps.env);
    if (normalizeStoreRootOverride(envValue).kind === 'unverifiable') {
      deps.logger.warn(
        {
          action: 'runtime_session_namespace_slug_repair_skipped',
          reason: 'unverifiable_store_root',
          runtime: kind,
          env_var: envVar,
        },
        'skipping the released session-slug repair because the session store root is unverifiable',
      );
      continue;
    }

    for (const cwd of verifiableRepairCwds) {
      const legacyPath = legacyV2SessionNamespaceFor(
        kind,
        cwd,
        deps.sessionStoreHome,
        deps.env,
      );
      const currentPath = sessionNamespaceFor(
        kind,
        cwd,
        deps.sessionStoreHome,
        deps.env,
      )!;
      if (legacyPath === currentPath) continue;

      const legacyState = probe(legacyPath);
      if (legacyState === 'absent') continue;
      if (legacyState === 'unreadable') {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'legacy_unreadable');
        continue;
      }
      if (legacyState === 'special') {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'legacy_special');
        continue;
      }

      const currentState = probe(currentPath);
      if (currentState === 'unreadable') {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'current_unreadable');
        continue;
      }
      if (currentState === 'special') {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'current_special');
        continue;
      }
      if (currentState === 'dir') {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'coexist');
        continue;
      }
      try {
        rename(legacyPath, currentPath);
      } catch {
        warnSessionSlugRepairSkipped(deps.logger, kind, cwd, 'rename_failed');
        continue;
      }
      result.renamed += 1;
      deps.logger.info(
        { action: 'runtime_session_namespace_slug_repaired', runtime: kind },
        'runtime session namespace moved to the vendor cwd-slug coordinate',
      );
    }
  }
  return result;
}

/**
 * Execute the eager handoff for every (runtime × cwd pair):
 *  - old namespace is a dir and the new one is absent → whole-directory
 *    atomic rename (never copy, never merge);
 *  - old absent → nothing to migrate;
 *  - old and new BOTH present, or either is a symlink/special file, or a
 *    probe fails, or the rename fails → typed LayoutMigrationError. The
 *    engine does not write the completion marker, so startup fails closed
 *    with every byte in place.
 *  - a cwd outside the verified slug charset, or a non-absolute config-dir
 *    override, makes the namespace location unverifiable: FAIL CLOSED too
 *    (nothing is moved or guessed). A skipped bucket would have no
 *    provable completion point — the user corrects the environment and
 *    the next startup retries the idempotent pass (P1-2, Cindy).
 */
export function runSessionRenamePass(
  pairs: readonly SessionCwdPair[],
  deps: SessionPassDeps,
): SessionPassResult {
  const probe = deps.probe ?? defaultNamespaceProbe;
  const rename = deps.rename ?? renameSync;
  const result = runSessionSlugRepairPass(
    pairs.flatMap(pair => [pair.oldCwd, pair.newCwd]),
    deps,
  );

  for (const kind of CWD_SCOPED_SESSION_RUNTIMES) {
    const [envVar, envValue] = storeRootOverrideFor(kind, deps.env);
    if (normalizeStoreRootOverride(envValue).kind === 'unverifiable') {
      throw new SessionMigrationError(
        'layout_conflict',
        `${envVar} is set to a non-absolute value; the ${kind} session store location is unverifiable — fix the environment and restart`,
      );
    }
    for (const pair of pairs) {
      if (pair.oldCwd === pair.newCwd) continue;
      if (!isSlugVerifiableCwd(pair.oldCwd) || !isSlugVerifiableCwd(pair.newCwd)) {
        throw new SessionMigrationError(
          'layout_conflict',
          'a workspace cwd contains characters outside the verified session-slug charset; refusing to guess the namespace location',
        );
      }
      const from = sessionNamespaceFor(kind, pair.oldCwd, deps.sessionStoreHome, deps.env)!;
      const to = sessionNamespaceFor(kind, pair.newCwd, deps.sessionStoreHome, deps.env)!;
      if (from === to) continue;
      const fromState = probe(from);
      if (fromState === 'absent') continue;
      if (fromState === 'unreadable') {
        throw new SessionMigrationError(
          'layout_unreadable',
          `session namespace for ${kind} cannot be inspected`,
        );
      }
      if (fromState === 'special') {
        throw new SessionMigrationError(
          'layout_special_file',
          `legacy session namespace for ${kind} is a symlink or special file`,
        );
      }
      const toState = probe(to);
      if (toState === 'unreadable') {
        throw new SessionMigrationError(
          'layout_unreadable',
          `destination session namespace for ${kind} cannot be inspected`,
        );
      }
      if (toState !== 'absent') {
        // Old and new buckets coexist: two histories, one identity — never
        // merge, never pick a side.
        throw new SessionMigrationError(
          'layout_conflict',
          `legacy and current session namespaces for ${kind} coexist`,
        );
      }
      try {
        rename(from, to);
      } catch (err) {
        // EXDEV / permissions fail closed; a recursive copy is never
        // attempted (partial copies duplicate session identity).
        throw new SessionMigrationError(
          'layout_move_failed',
          `renaming the ${kind} session namespace failed (${(err as NodeJS.ErrnoException).code ?? 'rename error'})`,
        );
      }
      deps.logger.info(
        { action: 'layout_v2_session_namespace_migrated', runtime: kind },
        'runtime session namespace handed off to the v2 workspace cwd',
      );
      result.renamed++;
    }
  }
  return result;
}
