/**
 * #task:1603 phase A — §5.1 process-ownership preflight. Before any
 * durable move, prove no legacy daemon or orphan runtime child still owns
 * the legacy roots: reclaim the legacy `run/daemon.pid` + socket with the
 * SAME primitives the spawner uses, then reap `run/runtime-pids`.
 * Silverhand pid/socket/run-state files themselves are never migrated.
 */
import {
  createDaemonLogger,
  reclaimStaleDaemonIfPresent,
  reconcileRuntimePidfiles,
} from '@silverhand/host';
import { resolveDesktopAppPaths } from '@silverhand/shared/app-data-layout';

export async function quiesceLegacyLocalRuntime(
  appRoot: string,
  logDir: string,
  deps?: { kill?: (pid: number, signal?: NodeJS.Signals | 0) => void },
): Promise<void> {
  const legacy = resolveDesktopAppPaths(appRoot, 'legacy-v1');
  const logger = createDaemonLogger({
    dir: logDir,
    alsoStderr: false,
    base: { component: 'silverhand-layout-migration' },
  });
  try {
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: legacy.run.pidFile,
      socketPath: legacy.run.socket,
      logger,
    });
    if (r.action === 'fail_loudly') {
      throw new Error(
        'a legacy silverhand daemon still owns the pre-migration roots and could not be reclaimed; refusing to move its files',
      );
    }
    const pidfiles = reconcileRuntimePidfiles({
      rootDir: legacy.run.runtimePids,
      selfDaemonInstanceId: 'layout-v2-migration',
      logger,
      deps,
    });
    // §5.1 precondition: every legacy runtime child must be PROVEN gone.
    // A preserved live process or a failed liveness/kill probe means the
    // legacy roots may still be owned — refuse to move them.
    const unconfirmed =
      pidfiles.preservedEperm + pidfiles.preservedSelf + pidfiles.errors;
    if (unconfirmed > 0) {
      throw new Error(
        `${unconfirmed} legacy runtime pidfile(s) are still live or could not be verified ` +
          `(eperm=${pidfiles.preservedEperm} self=${pidfiles.preservedSelf} errors=${pidfiles.errors}); ` +
          'refusing to move the pre-migration roots',
      );
    }
  } finally {
    await logger.close();
  }
}
