import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';
import {
  bindingSlug,
  WorkspaceRegistryError,
  type RegistryBinding,
} from './registry.js';

/**
 * #task:1596 durability fix (Cindy P1, round 2) — where the daemon's
 * workspace-data (registry file + managed workspace roots, which contain
 * agent L2 memory) lives, and how a pre-fix namespace migrates there.
 *
 * Previously the registry state dir was derived from the daemon identity
 * file's directory (desktop: `~/.silverhand/run` — explicitly documented
 * as wipeable runtime artifacts) or the historical `~/.silverhand/daemon`.
 * Managed workspace roots hold DURABLE agent L2 memory, so they live in an
 * EXPLICIT persistent data root the embedder passes (`workspaceDataRootDir`
 * — desktop: `~/.silverhand/workspace-data`; `silverhand-daemon connect`:
 * `<data-root>/workspace-data`, so a custom data root never writes back to
 * the global `~/.silverhand`), decoupled from sockets / pids / identity.
 * When the embedder passes nothing, the global default applies.
 *
 *   <workspaceDataRootDir>/<binding-slug>/
 *     workspace-registry.json
 *     workspaces/<workspace-slug>/...
 *
 * Migration authority model (review round 2):
 * - a namespace has exactly ONE owner location. Destination coexisting
 *   with any legacy source — or two legacy sources coexisting — is
 *   ownership ambiguity: `migration_blocked`, keep every byte, build no
 *   registry. Never warn-and-continue, never pick a winner.
 * - the move is rename + ATOMIC registry-file rewrite; a crash between the
 *   two leaves a deterministic dest-only state that the next call REPAIRS
 *   (entries still pointing into a trusted legacy namespace are rewritten
 *   atomically before any use).
 * - any failure (rename EXDEV, rewrite error) is `migration_blocked` —
 *   the legacy dir is never silently adopted as this run's authority.
 */

export const WORKSPACE_DATA_DIR_NAME = 'workspace-data';
const REGISTRY_FILE_NAME = 'workspace-registry.json';

/** The global default when the embedder passes no explicit data root. */
export function defaultWorkspaceDataRootDir(): string {
  return join(homedir(), '.silverhand', WORKSPACE_DATA_DIR_NAME);
}

export interface LegacyNamespaceMigrationOptions {
  /** The explicit durable workspace-data root (`.../workspace-data`). */
  stateDir: string;
  /**
   * Legacy state dirs that may hold this binding's namespace from before
   * the durability fix, e.g. `dirname(identity.json)` (desktop's
   * `~/.silverhand/run`) and the historical `~/.silverhand/daemon`.
   * Entries equal to `stateDir` are ignored. Only these EXACT dirs are
   * probed — never scanned or claimed generically.
   */
  legacyStateDirs: readonly (string | null)[];
  /**
   * Bindings whose namespace directories must be safe to use: the current
   * binding plus any trusted predecessor bindings (the registry's
   * `legacyBindings` handoff seam reads them from the SAME state dir, so
   * they must move together or the handoff would silently stop finding
   * them).
   */
  bindings: readonly RegistryBinding[];
  logger?: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  };
}

/**
 * Compute the exact trusted PRE-migration managed path for a workspace
 * slug under a legacy state dir + binding. Used both by the repair pass
 * here and by the registry's stale-legacy-path re-bind provenance check —
 * a proposed path is trusted ONLY when it is structurally one of these,
 * never by basename resemblance.
 */
export function legacyNamespaceDirs(
  legacyStateDirs: readonly (string | null)[],
  bindings: readonly RegistryBinding[],
): string[] {
  const out: string[] = [];
  for (const dir of legacyStateDirs) {
    if (!dir) continue;
    for (const binding of bindings) {
      out.push(join(dir, bindingSlug(binding)));
    }
  }
  return [...new Set(out)];
}

/**
 * Narrow, idempotent, fail-closed relocation of pre-fix registry
 * namespaces into the durable state dir. Throws `migration_blocked` on any
 * ambiguity or failure; returns normally only when every required
 * namespace is either absent everywhere, already durable (and repaired if
 * a prior crash left stale paths), or migrated to durable in this call.
 */
export function migrateLegacyWorkspaceData(
  opts: LegacyNamespaceMigrationOptions,
): void {
  for (const binding of opts.bindings) {
    const slug = bindingSlug(binding);
    const destNs = join(opts.stateDir, slug);
    const sources = opts.legacyStateDirs
      .filter((d): d is string => !!d && d !== opts.stateDir)
      .map(d => join(d, slug))
      .filter(nsDir => existsSync(nsDir));

    if (existsSync(destNs)) {
      if (sources.length > 0) {
        // Full paths go to the structured daemon log ONLY — the thrown
        // message crosses handler/wire boundaries toward user/agent-facing
        // error copy and must not leak host paths.
        opts.logger?.warn(
          {
            kind: 'workspace_registry',
            action: 'workspace_data_migration_blocked',
            reason: 'destination_and_legacy_coexist',
            binding_slug: slug,
            destination: destNs,
            sources,
          },
          'workspace-data migration blocked: durable namespace coexists with a legacy copy',
        );
        throw new WorkspaceRegistryError(
          'migration_blocked',
          `workspace-data ownership for binding ${slug} is ambiguous (durable and legacy copies coexist); ` +
            'no byte was deleted or overwritten — see the daemon log for the exact directories and remove or archive the stale copy explicitly',
        );
      }
      // Dest-only: a prior call may have crashed between rename and the
      // registry-file rewrite. Repair deterministically before use.
      repairManagedPathPrefixes(
        destNs,
        opts.stateDir,
        legacyNamespaceDirs(opts.legacyStateDirs, opts.bindings),
        slug,
        opts.logger,
      );
      continue;
    }
    if (sources.length === 0) continue;
    if (sources.length > 1) {
      opts.logger?.warn(
        {
          kind: 'workspace_registry',
          action: 'workspace_data_migration_blocked',
          reason: 'multiple_legacy_sources',
          binding_slug: slug,
          destination: destNs,
          sources,
        },
        'workspace-data migration blocked: multiple legacy copies of the same namespace exist',
      );
      throw new WorkspaceRegistryError(
        'migration_blocked',
        `workspace-data ownership for binding ${slug} is ambiguous (multiple legacy copies exist); ` +
          'refusing to pick a winner — see the daemon log for the exact directories',
      );
    }
    const sourceNs = sources[0]!;
    try {
      mkdirSync(opts.stateDir, { recursive: true });
      renameSync(sourceNs, destNs);
    } catch (err) {
      opts.logger?.warn(
        {
          kind: 'workspace_registry',
          action: 'workspace_data_migration_blocked',
          reason: 'rename_failed',
          binding_slug: slug,
          source: sourceNs,
          destination: destNs,
          error: (err as Error | undefined)?.message ?? 'unknown error',
        },
        'workspace-data migration blocked: relocating the namespace failed; the legacy tree is untouched',
      );
      throw new WorkspaceRegistryError(
        'migration_blocked',
        `failed to relocate the workspace-data namespace for binding ${slug}; ` +
          'the legacy tree is untouched and is NOT adopted as this run\'s authority — see the daemon log for directories and cause',
      );
    }
    repairManagedPathPrefixes(
      destNs,
      opts.stateDir,
      legacyNamespaceDirs(opts.legacyStateDirs, opts.bindings),
      slug,
      opts.logger,
    );
    opts.logger?.info(
      {
        kind: 'workspace_registry',
        action: 'workspace_data_migrated',
        source: sourceNs,
        destination: destNs,
      },
      'migrated workspace-data namespace to the durable state dir',
    );
  }
}

/**
 * Deterministic repair/completion of the post-rename rewrite: registry
 * entries whose path still points inside a trusted legacy namespace are
 * repointed to the same relative location under THAT NAMESPACE'S OWN
 * durable location — `<stateDir>/<its binding slug>` — never uniformly to
 * the namespace currently being processed. (The `legacyBindings` handoff
 * legitimately leaves a current-binding entry pointing into a PREDECESSOR
 * binding's managed root; after both namespaces migrate, that entry must
 * follow the predecessor's durable namespace, or it would resolve a
 * directory that does not exist.) The file is replaced ATOMICALLY (temp
 * file + rename, mode pinned to 0600 even over a crash-leftover temp) so
 * a crash can never leave a half-written registry. Idempotent: a repaired
 * file has no matching prefixes and is left byte-identical. Any
 * read/parse/write failure is `migration_blocked`.
 */
function repairManagedPathPrefixes(
  destNs: string,
  stateDir: string,
  trustedLegacyNamespaces: readonly string[],
  bindingSlugValue: string,
  logger?: LegacyNamespaceMigrationOptions['logger'],
): void {
  const filePath = join(destNs, REGISTRY_FILE_NAME);
  if (!existsSync(filePath)) return;
  let changed = false;
  let serialized: string;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      workspaces?: Record<string, { path?: unknown }>;
    };
    for (const entry of Object.values(parsed.workspaces ?? {})) {
      if (typeof entry?.path !== 'string') continue;
      for (const legacyNs of trustedLegacyNamespaces) {
        if (legacyNs === destNs) continue;
        if (entry.path === legacyNs || entry.path.startsWith(legacyNs + sep)) {
          // Map to the durable namespace OF THE PREFIX'S OWN BINDING (its
          // slug is the legacy namespace dir's basename).
          const durableNsForPrefix = join(stateDir, basename(legacyNs));
          entry.path = durableNsForPrefix + entry.path.slice(legacyNs.length);
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  } catch (err) {
    logger?.warn(
      {
        kind: 'workspace_registry',
        action: 'workspace_data_migration_blocked',
        reason: 'repair_read_failed',
        binding_slug: bindingSlugValue,
        file: filePath,
        error: (err as Error | undefined)?.message ?? 'unknown error',
      },
      'workspace-data migration blocked: cannot verify/repair the migrated registry file',
    );
    throw new WorkspaceRegistryError(
      'migration_blocked',
      `cannot verify/repair the migrated registry file for binding ${bindingSlugValue}; see the daemon log`,
    );
  }
  try {
    const tmpPath = `${filePath}.migrating`;
    // Same 0600 the registry's own persist() uses. `mode` only applies when
    // the temp file is CREATED — a crash-leftover `.migrating` with a wider
    // mode would survive the overwrite and the rename would widen the
    // registry itself, so pin the mode explicitly after writing.
    writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
  } catch (err) {
    logger?.warn(
      {
        kind: 'workspace_registry',
        action: 'workspace_data_migration_blocked',
        reason: 'repair_write_failed',
        binding_slug: bindingSlugValue,
        file: filePath,
        error: (err as Error | undefined)?.message ?? 'unknown error',
      },
      'workspace-data migration blocked: atomic rewrite of the migrated registry file failed',
    );
    throw new WorkspaceRegistryError(
      'migration_blocked',
      `failed to atomically rewrite the migrated registry file for binding ${bindingSlugValue}; see the daemon log`,
    );
  }
}
