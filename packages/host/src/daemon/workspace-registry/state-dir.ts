import {
  defaultAppRoot,
  resolveDesktopAppPaths,
  WORKSPACE_DATA_DIR_NAME,
} from '@silverhand/shared/app-data-layout';

/**
 * #task:1596/#task:1608 — where the daemon's workspace-data (registry file
 * + managed workspace roots, which contain agent L2 memory) lives:
 *
 *   <workspaceDataRootDir>/
 *     workspace-registry.json
 *     workspaces/<workspace_id>/...
 *
 * The embedder passes the durable root explicitly (`workspaceDataRootDir`);
 * when it passes nothing, the global default applies.
 *
 * The daemon performs NO legacy physical moves (the desktop layout engine
 * and the connect convergence entry own the one-time migration), and since
 * #task:1612 it performs no legacy path aliasing either: the registry is
 * the sole authority and stale server-side path caches have no reader.
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
