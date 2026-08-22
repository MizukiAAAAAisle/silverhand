import { createHash } from 'node:crypto';
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
 * probes, no migration, no fallback, no mode decision. Layout-v2 is the only
 * supported desktop layout; callers receive its resolved coordinates directly.
 */

/** #task:1608 — the desktop-owned computer binding file, relative to
 *  `desktop/` (daemon-config schema; the LOCATION expresses the owner). */
export const COMPUTER_BINDING_FILENAME = 'computer-binding.json';

/**
 * The UNIFIED `SILVERHAND_DIR` parse contract (v2 cutover, shiki
 * 2026-07-24): `trim()` the value; blank-after-trim counts as unset
 * (returns null); anything else is the TRIMMED value. This is the ONE
 * judgment for both the root VALUE and the root PRESENCE — any gate that
 * branches on "was SILVERHAND_DIR set?" must consume this, never the raw
 * env, or whitespace/unset would take different arms.
 */
export function appRootEnvOverride(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const fromEnv = env.SILVERHAND_DIR?.trim();
  return fromEnv ? fromEnv : null;
}

/**
 * Resolve the app root exactly once at process entry: the trimmed
 * `SILVERHAND_DIR` override when present, else `~/.silverhand`. Desktop,
 * the CLI, and the bare-daemon/connect defaults all consume THIS
 * resolver — the historical desktop whitespace-verbatim `||` and the
 * CLI-local trim divergence are gone. An explicit `--data-root` is not
 * part of this env contract: it stays highest-priority and is never
 * trimmed or redirected. Inputs are injectable for tests; production
 * callers use the defaults.
 */
export function defaultAppRoot(
  env: Record<string, string | undefined> = process.env,
  home: () => string = homedir,
): string {
  return appRootEnvOverride(env) ?? join(home(), '.silverhand');
}

/**
 * Standalone-daemon defaults under `<app-root>/daemon/**`.
 */
export function resolveStandaloneDaemonPaths(appRoot: string): {
  stateDir: string;
  identity: string;
  runtimePids: string;
} {
  const stateDir = join(appRoot, 'daemon');
  return {
    stateDir,
    identity: join(stateDir, 'identity.json'),
    runtimePids: join(stateDir, 'runtime-pids'),
  };
}

/** The per-computer profiles root (`<app-root>/computers`). */
export function computersRootDir(appRoot: string): string {
  return join(appRoot, 'computers');
}

/**
 * #task:1608 — filesystem-safe directory id for a computer slot. Ported
 * from the connect profile key (host computer-profile safePathId) so
 * desktop and connect slots are literally the same coordinates.
 */
export function safeComputerDirId(computerId: string): string {
  return (
    computerId.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) ||
    shortHash(computerId)
  );
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/**
 * #task:1608 — the durable per-computer slot (`computers/<computer_id>`),
 * materialized only after the machine registers with a server
 * (claim_or_create → hosts.id). Desktop and connect defaults are the SAME
 * shape and coordinates; there is no `local` special case. The app-scoped
 * transient run/ dir and the desktop-owned binding file deliberately live
 * OUTSIDE the slot (they must exist before any computer id does).
 */
export interface ComputerSlotPaths {
  root: string;
  /** L1 agent identity root (`<root>/agents/<agent_id>/...`). */
  agents: string;
  /** Per-computer proxy config. */
  proxyConfig: string;
}

export function resolveComputerSlotPaths(
  appRoot: string,
  computerId: string,
): ComputerSlotPaths {
  return resolveComputerSlotFromComputersRoot(
    computersRootDir(appRoot),
    computerId,
  );
}

/** Same slot, keyed from an explicit computers root (what the daemon
 *  receives via `--computers-root-dir`). */
export function resolveComputerSlotFromComputersRoot(
  computersRoot: string,
  computerId: string,
): ComputerSlotPaths {
  const root = join(computersRoot, safeComputerDirId(computerId));
  return {
    root,
    agents: join(root, 'agents'),
    proxyConfig: join(root, 'proxy-config.json'),
  };
}

/**
 * #task:1608 — the DEFAULT `silverhand-daemon connect` profile: the durable
 * slot plus its app-scoped transient/run and log coordinates. The slot holds
 * ONLY durable state (agents and proxy-config); sockets,
 * pidfiles, and runtime pidfiles live under the app-scoped transient root
 * (`run/connect-<computer_dir>/`), and logs under the single support-bundle
 * root (`logs/connect-<computer_dir>/`). An EXPLICIT `--data-root` keeps the
 * self-contained flat shape (`resolveComputerDataPaths`) instead.
 */
export interface ConnectProfilePaths {
  slot: ComputerSlotPaths;
  logs: string;
  run: {
    root: string;
    socket: string;
    pidFile: string;
    runtimePids: string;
  };
}

export function resolveConnectProfilePaths(
  appRoot: string,
  computerId: string,
): ConnectProfilePaths {
  const dirId = safeComputerDirId(computerId);
  const runRoot = join(appRoot, 'run', `connect-${dirId}`);
  return {
    slot: resolveComputerSlotPaths(appRoot, computerId),
    logs: join(appRoot, 'logs', `connect-${dirId}`),
    run: {
      root: runRoot,
      socket: join(runRoot, 'daemon.sock'),
      pidFile: join(runRoot, 'silverhand-daemon.pid'),
      runtimePids: join(runRoot, 'runtime-pids'),
    },
  };
}

/**
 * The per-computer daemon data slot: L1 agents, daemon binding config,
 * proxy config, logs, and the disposable run/ dir. Standalone `connect`
 * profiles and explicit data roots share this shape; only the root differs.
 */
export interface ComputerDataPaths {
  root: string;
  /** L1 agent identity root (`<root>/agents/<agent_id>/...`). */
  agents: string;
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

/** App-scoped transient runtime coordinates (`<app-root>/run/**`). */
export interface AppRunPaths {
  root: string;
  socket: string;
  outboundSocket: string;
  pidFile: string;
  identity: string;
  runtimePids: string;
  controlPlaneServerUrl: string;
}

export interface DesktopAppPaths {
  appRoot: string;
  installationId: string;
  desktop: {
    root: string;
    electronUserData: string;
    serverProfile: string;
    session: string;
    /** #task:1608 — the desktop-owned "which computer is this app bound
     *  to" authority (daemon-config schema; v2 location). */
    computerBinding: string;
  };
  /**
   * #task:1608 — the app-scoped transient runtime root. IDENTICAL
   * coordinates (top-level `run/`): it must exist
   * before any computer id does, holds only rebuildable state (sockets,
   * pidfiles, instance identity, control-plane URL), and may be cleared
   * only while the app/daemon is stopped. Never migrated.
   */
  run: AppRunPaths;
  /** The per-computer durable slots root (`<app-root>/computers`);
   *  individual slots resolve via `resolveComputerSlotPaths`. */
  computersRoot: string;
  embeddedServer: EmbeddedServerPaths;
  /** Single support-bundle log root (deliberately not split per owner). */
  logs: string;
  /** CLI `file view` cache; never moves (returned paths must stay valid). */
  attachmentsCache: string;
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

export function resolveDesktopAppPaths(appRoot: string): DesktopAppPaths {
  const desktopRoot = join(appRoot, 'desktop');
  const runRoot = join(appRoot, 'run');
  const embeddedRoot = join(appRoot, 'embedded-server');
  return {
    appRoot,
    installationId: join(appRoot, INSTALLATION_ID_FILENAME),
    desktop: {
      root: desktopRoot,
      electronUserData: join(desktopRoot, 'electron-user-data'),
      serverProfile: join(desktopRoot, 'server-profile.bin'),
      session: join(desktopRoot, 'session.bin'),
      computerBinding: join(desktopRoot, COMPUTER_BINDING_FILENAME),
    },
    // Top-level run/ in BOTH versions (#task:1608): the transient runtime
    // root is app-scoped and pre-dates any computer id.
    run: {
      root: runRoot,
      socket: join(runRoot, 'daemon.sock'),
      outboundSocket: join(runRoot, 'daemon-outbound.sock'),
      pidFile: join(runRoot, 'daemon.pid'),
      identity: join(runRoot, 'identity.json'),
      runtimePids: join(runRoot, 'runtime-pids'),
      controlPlaneServerUrl: join(runRoot, 'control-plane-server-url'),
    },
    computersRoot: computersRootDir(appRoot),
    embeddedServer: {
      root: embeddedRoot,
      database: join(embeddedRoot, 'silverhand.db'),
      databaseWal: join(embeddedRoot, 'silverhand.db-wal'),
      databaseShm: join(embeddedRoot, 'silverhand.db-shm'),
      blobs: join(embeddedRoot, 'blobs'),
      serverConfig: join(embeddedRoot, 'config', SERVER_CONFIG_FILENAME),
      bootstrap: join(embeddedRoot, EMBEDDED_BOOTSTRAP_FILENAME),
    },
    logs: join(appRoot, 'logs'),
    attachmentsCache: join(appRoot, 'attachments-cache'),
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
}

export function resolveBackendDataPaths(dataRoot: string): BackendDataPaths {
  const server = resolveServerDataPaths(dataRoot);
  return {
    blobsRootDir: server.blobs,
    embeddedBootstrapPath: server.bootstrap,
  };
}
