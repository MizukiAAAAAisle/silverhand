import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_HOST_CONFIG_FILENAME,
  EMBEDDED_BOOTSTRAP_FILENAME,
  INSTALLATION_ID_FILENAME,
  SERVER_CONFIG_FILENAME,
} from './config.js';

/**
 * #task:1597/#task:1598 — the ONE app-data path authority
 * (docs/app-data-layout-v2.md §3).
 *
 * Every physical path under a Silverhand data root is produced here.
 * Business code receives resolved, typed paths; it never derives a path
 * from a root (`join(appRoot, ...)`) and never reconstructs a root from a
 * child (`dirname(...)` inverses). The resolver is PURE: no filesystem
 * probes, no migration, no fallback, no mode decision. The migration
 * (layout v2, later release) consumes this same API's `legacy-v1`/`v2`
 * pairs — it must not become a second resolver.
 *
 * Compatibility floor (#task:1598): production pins `legacy-v1`, whose
 * output is byte-identical to the historical flat layout. `v2` is defined
 * here so the migration and the layout marker have a single source, but
 * nothing writes it yet.
 */

export type DesktopLayoutVersion = 'legacy-v1' | 'v2';

/** Durable per-computer workspace registry/root dir name. */
export const WORKSPACE_DATA_DIR_NAME = 'workspace-data';

/** The desktop layout marker file, relative to `desktop/`. */
export const DATA_LAYOUT_MARKER_FILENAME = 'data-layout.json';

/**
 * Resolve the desktop app root exactly once at process entry:
 * `SILVERHAND_DIR` when set, else `~/.silverhand`. EXACT historical
 * desktop semantics (`process.env.SILVERHAND_DIR || ...`): the empty
 * string falls through, any other value — including whitespace — is used
 * verbatim. (The CLI historically trimmed; that divergence is preserved
 * at its call site and listed for a v2 unification decision.) Inputs are
 * injectable for tests; production callers use the defaults.
 */
export function defaultAppRoot(
  env: Record<string, string | undefined> = process.env,
  home: () => string = homedir,
): string {
  return env.SILVERHAND_DIR || join(home(), '.silverhand');
}

/**
 * The env-INDEPENDENT user-home app root (`~/.silverhand`). Historical
 * host-daemon defaults (standalone identity/runtime-pids, connect profile
 * root, workspace-data fallback, local outbound socket) never consulted
 * `SILVERHAND_DIR`; the compatibility floor preserves that exactly —
 * making them env-sensitive would silently move connect profiles and
 * fallback roots for anyone running with an explicit `SILVERHAND_DIR`.
 */
export function homeAppRoot(home: string = homedir()): string {
  return join(home, '.silverhand');
}

/**
 * Historical standalone-daemon state facet (`<app-root>/daemon/**`).
 * Pre-#task:1596 registries lived here too; today it holds the standalone
 * identity/runtime-pid defaults and the legacy desktop proxy config. Kept
 * as an explicitly-modeled legacy facet so no caller re-derives it.
 */
export function resolveLegacyStandaloneDaemonPaths(appRoot: string): {
  stateDir: string;
  identity: string;
  runtimePids: string;
  proxyConfig: string;
} {
  const stateDir = join(appRoot, 'daemon');
  return {
    stateDir,
    identity: join(stateDir, 'identity.json'),
    runtimePids: join(stateDir, 'runtime-pids'),
    proxyConfig: join(stateDir, 'proxy-config.json'),
  };
}

/** The per-computer profiles root (`<app-root>/computers`). */
export function computersRootDir(appRoot: string): string {
  return join(appRoot, 'computers');
}

/** The pre-D4.e backend-generated workspaces root (`<app-root>/workspaces`). */
export function legacyWorkspacesRootDir(appRoot: string): string {
  return join(appRoot, 'workspaces');
}

/**
 * The per-computer daemon data slot: L1 agents, durable workspace-data,
 * daemon binding config, and the disposable run/ dir. Desktop's bundled
 * daemon and standalone `connect` profiles share this shape; only the
 * root differs (and `legacy-v1` flattens the desktop one onto the app
 * root itself).
 */
export interface ComputerDataPaths {
  root: string;
  /** L1 agent identity root (`<root>/agents/<agent_id>/...`). */
  agents: string;
  /** Durable workspace registry + managed workspace roots (holds L2). */
  workspaceData: string;
  /** Daemon → server binding config (`daemon-config.json`). */
  daemonConfig: string;
  /** Daemon-local proxy config. */
  proxyConfig: string;
  logs: string;
  /** Disposable runtime state — safe to delete when the daemon is down. */
  run: {
    root: string;
    socket: string;
    outboundSocket: string;
    pidFile: string;
    identity: string;
    runtimePids: string;
    controlPlaneServerUrl: string;
  };
}

export interface EmbeddedServerPaths {
  root: string;
  database: string;
  databaseWal: string;
  databaseShm: string;
  blobs: string;
  serverConfig: string;
  bootstrap: string;
}

export interface DesktopAppPaths {
  appRoot: string;
  version: DesktopLayoutVersion;
  installationId: string;
  desktop: {
    root: string;
    electronUserData: string;
    serverProfile: string;
    session: string;
    layoutMarker: string;
  };
  localComputer: ComputerDataPaths & {
    /** Historical desktop-daemon proxy config (`daemon/proxy-config.json`)
     *  consulted for one-time migration; legacy layout only. */
    legacyProxyConfig: string;
  };
  embeddedServer: EmbeddedServerPaths;
  /** Single support-bundle log root (deliberately not split per owner). */
  logs: string;
  /** CLI `file view` cache; never moves (returned paths must stay valid). */
  attachmentsCache: string;
  /**
   * Historical backend-managed workspace root (`<app-root>/workspaces`).
   * legacy-v1 only: the v2 target has no backend-managed root (pathless
   * workspaces are materialized by the owning daemon under its
   * workspace-data). Existing DB rows keep their absolute paths.
   */
  legacyWorkspacesRoot: string;
}

/**
 * The per-computer slot for an EXPLICIT data root (standalone
 * `silverhand-daemon connect` profiles, or any custom `--data-root`).
 * Layout-version independent: these roots are not desktop app roots and
 * desktop migration never touches them.
 */
export function resolveComputerDataPaths(root: string): ComputerDataPaths {
  return {
    root,
    agents: join(root, 'agents'),
    workspaceData: join(root, WORKSPACE_DATA_DIR_NAME),
    daemonConfig: join(root, DAEMON_HOST_CONFIG_FILENAME),
    proxyConfig: join(root, 'proxy-config.json'),
    logs: join(root, 'logs'),
    run: {
      root,
      socket: join(root, 'daemon.sock'),
      outboundSocket: join(root, 'daemon-outbound.sock'),
      pidFile: join(root, 'silverhand-daemon.pid'),
      identity: join(root, 'identity.json'),
      runtimePids: join(root, 'runtime-pids'),
      controlPlaneServerUrl: join(root, 'control-plane-server-url'),
    },
  };
}

/**
 * The standalone server's data root facet (`SILVERHAND_DATA_DIR`, default
 * `/var/lib/silverhand`). Same shape the embedded server uses; the root is
 * simply not a desktop app root.
 */
export function resolveServerDataPaths(dataRoot: string): EmbeddedServerPaths & {
  logs: string;
} {
  return {
    root: dataRoot,
    database: join(dataRoot, 'silverhand.db'),
    databaseWal: join(dataRoot, 'silverhand.db-wal'),
    databaseShm: join(dataRoot, 'silverhand.db-shm'),
    blobs: join(dataRoot, 'blobs'),
    serverConfig: join(dataRoot, SERVER_CONFIG_FILENAME),
    bootstrap: join(dataRoot, EMBEDDED_BOOTSTRAP_FILENAME),
    logs: join(dataRoot, 'logs'),
  };
}

export function resolveDesktopAppPaths(
  appRoot: string,
  version: DesktopLayoutVersion,
): DesktopAppPaths {
  const desktopRoot = join(appRoot, 'desktop');
  const shared = {
    appRoot,
    version,
    installationId: join(appRoot, INSTALLATION_ID_FILENAME),
    desktop: {
      root: desktopRoot,
      electronUserData: join(desktopRoot, 'electron-user-data'),
      serverProfile: join(desktopRoot, 'server-profile.bin'),
      session: join(desktopRoot, 'session.bin'),
      layoutMarker: join(desktopRoot, DATA_LAYOUT_MARKER_FILENAME),
    },
    logs: join(appRoot, 'logs'),
    attachmentsCache: join(appRoot, 'attachments-cache'),
    legacyWorkspacesRoot: join(appRoot, 'workspaces'),
  };

  if (version === 'legacy-v1') {
    // Byte-identical to the historical flat layout: local-computer and
    // embedded-server facets sit directly on the app root.
    const runRoot = join(appRoot, 'run');
    return {
      ...shared,
      localComputer: {
        root: appRoot,
        agents: join(appRoot, 'agents'),
        workspaceData: join(appRoot, WORKSPACE_DATA_DIR_NAME),
        daemonConfig: join(appRoot, DAEMON_HOST_CONFIG_FILENAME),
        proxyConfig: join(appRoot, 'daemon', 'proxy-config.json'),
        legacyProxyConfig: join(appRoot, 'daemon', 'proxy-config.json'),
        logs: shared.logs,
        run: {
          root: runRoot,
          socket: join(runRoot, 'daemon.sock'),
          outboundSocket: join(runRoot, 'daemon-outbound.sock'),
          pidFile: join(runRoot, 'daemon.pid'),
          identity: join(runRoot, 'identity.json'),
          runtimePids: join(runRoot, 'runtime-pids'),
          controlPlaneServerUrl: join(runRoot, 'control-plane-server-url'),
        },
      },
      embeddedServer: {
        root: appRoot,
        database: join(appRoot, 'silverhand.db'),
        databaseWal: join(appRoot, 'silverhand.db-wal'),
        databaseShm: join(appRoot, 'silverhand.db-shm'),
        blobs: join(appRoot, 'blobs'),
        serverConfig: join(appRoot, SERVER_CONFIG_FILENAME),
        bootstrap: join(appRoot, EMBEDDED_BOOTSTRAP_FILENAME),
      },
    };
  }

  // v2 (docs/app-data-layout-v2.md §2). Defined for the marker/migration;
  // production does not select it in the compatibility floor.
  const localRoot = join(appRoot, 'computers', 'local');
  const localRun = join(localRoot, 'run');
  const embeddedRoot = join(appRoot, 'embedded-server');
  return {
    ...shared,
    localComputer: {
      root: localRoot,
      agents: join(localRoot, 'agents'),
      workspaceData: join(localRoot, WORKSPACE_DATA_DIR_NAME),
      daemonConfig: join(localRoot, 'config', DAEMON_HOST_CONFIG_FILENAME),
      proxyConfig: join(localRoot, 'config', 'proxy-config.json'),
      legacyProxyConfig: join(appRoot, 'daemon', 'proxy-config.json'),
      logs: shared.logs,
      run: {
        root: localRun,
        socket: join(localRun, 'daemon.sock'),
        outboundSocket: join(localRun, 'daemon-outbound.sock'),
        pidFile: join(localRun, 'daemon.pid'),
        identity: join(localRun, 'identity.json'),
        runtimePids: join(localRun, 'runtime-pids'),
        controlPlaneServerUrl: join(localRun, 'control-plane-server-url'),
      },
    },
    embeddedServer: {
      root: embeddedRoot,
      database: join(embeddedRoot, 'silverhand.db'),
      databaseWal: join(embeddedRoot, 'silverhand.db-wal'),
      databaseShm: join(embeddedRoot, 'silverhand.db-shm'),
      blobs: join(embeddedRoot, 'blobs'),
      serverConfig: join(embeddedRoot, 'config', SERVER_CONFIG_FILENAME),
      bootstrap: join(embeddedRoot, EMBEDDED_BOOTSTRAP_FILENAME),
    },
  };
}

/**
 * The explicit path bundle `startBackend` receives instead of the retired
 * overloaded `silverhandDir` root (docs/app-data-layout-v2.md §3). Spread
 * into the options object by the server entry points and test harnesses.
 */
export interface BackendDataPaths {
  blobsRootDir: string;
  embeddedBootstrapPath: string;
  workspacesRootDir: string;
}

export function resolveBackendDataPaths(dataRoot: string): BackendDataPaths {
  const server = resolveServerDataPaths(dataRoot);
  return {
    blobsRootDir: server.blobs,
    embeddedBootstrapPath: server.bootstrap,
    workspacesRootDir: join(dataRoot, 'workspaces'),
  };
}
