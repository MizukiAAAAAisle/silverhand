import { join } from 'node:path';
import {
  defaultAppRoot,
  resolveDesktopAppPaths,
  WORKSPACE_DATA_DIR_NAME,
} from '@silverhand/shared/app-data-layout';
import { bindingSlug, type RegistryBinding } from './registry.js';

/**
 * #task:1596/#task:1603 — where the daemon's workspace-data (registry file
 * + managed workspace roots, which contain agent L2 memory) lives:
 *
 *   <workspaceDataRootDir>/<binding-slug>/
 *     workspace-registry.json
 *     workspaces/<workspace-slug>/...
 *
 * The embedder passes the durable root explicitly (`workspaceDataRootDir`);
 * when it passes nothing, the global default applies.
 *
 * The daemon performs NO legacy physical moves. The desktop layout engine
 * (apps/desktop layout-migration/, #task:1603) is the single owner of the
 * released run-era registry namespace move, and it runs before any daemon
 * starts. The historical standalone `~/.silverhand/daemon` location was
 * never producible by a released artifact (origin/main derives it only for
 * identity-less bare daemons; every distributed profile is desktop-managed
 * with an identity file), so it gets no reader — dev/test leftovers there
 * are cleaned locally, not in the product (Cindy ruling, 2026-07-24).
 */

export { WORKSPACE_DATA_DIR_NAME };

/**
 * The global default when the embedder passes no explicit data root.
 * #task:1598 — delegates to the shared app-data path authority (legacy-v1)
 * instead of being an independent `homedir()` derivation.
 */
export function defaultWorkspaceDataRootDir(): string {
  // Env-AWARE since the v2 cutover (#task:1603, contract §8).
  return resolveDesktopAppPaths(defaultAppRoot(), 'legacy-v1')
    .legacyLocalComputer.workspaceData;
}

/**
 * #task:1603 P0 — the ALIAS provenance inventory feeding the registry's
 * stale-legacy-path re-bind (`trustedLegacyNamespaceDirs`): the RELEASED
 * run-era root only. A server DB row may still cache a run-era managed
 * path (the column is deliberately not rewritten; the #1529 hydrate
 * backfill's provision ACK heals it), and after the v2 cutover the
 * physical namespaces live under `computers/<computer_id>/workspace-data`,
 * so the top-level `run/` root must be named explicitly from the resolver.
 * Desktop-managed only: a connect/custom daemon never owned it. Retires
 * with the #1529 observation-first gate (`migration_complete=true`
 * coverage), not with the layout engine.
 */
export function legacyWorkspaceDataSourceDirs(opts: {
  daemonIdentityPath: string | null;
  silverhandStateRoot: string;
}): string[] {
  const { daemonIdentityPath, silverhandStateRoot } = opts;
  if (daemonIdentityPath === null) return [];
  return [resolveDesktopAppPaths(silverhandStateRoot, 'legacy-v1').run.root];
}

/**
 * Compute the exact trusted PRE-migration managed path for a workspace
 * slug under a legacy state dir + binding. Consumed by the registry's
 * stale-legacy-path re-bind provenance check — a proposed path is trusted
 * ONLY when it is structurally one of these, never by basename
 * resemblance.
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
