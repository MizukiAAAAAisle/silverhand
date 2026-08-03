import { homedir } from 'node:os';
import {
  daemonLayoutMigrationCode,
  type DaemonLayoutMigrationStage,
} from '@silverhand/shared';
import { resolveComputerSlotFromComputersRoot } from '@silverhand/shared/app-data-layout';
import type { LayoutMigrationOutcome } from '../protocol.js';
import { recordLayoutMigrationFailure } from '../diagnostics/layout-migration-breadcrumb.js';
import { createDaemonLogger } from './logger.js';
import { DAEMON_VERSION } from './version.js';
import { runWorkspaceStartupPreflight } from './workspace-registry/convergence-pass.js';
import { FlattenLayoutError } from './workspace-registry/flatten-layout.js';
import type { RegistryBinding } from './workspace-registry/registry.js';
import { RelocationError } from './workspace-registry/relocation-error.js';
import {
  SessionMigrationError,
  type SessionStoreEnv,
} from './workspace-registry/session-migration.js';
import { WORKSPACE_PREFLIGHT_RESULT_EVENT } from '../workspace-preflight-protocol.js';

export interface DirectStartupPreflightOptions {
  binding: RegistryBinding | null;
  computersRootDir: string | null;
  silverhandStateRootDir: string | null;
  logDir: string;
  alsoStderr: boolean;
  initialOutcome: LayoutMigrationOutcome | null;
  sessionStoreHome?: string;
  env?: SessionStoreEnv;
}

interface ParsedDirectPreflightArgv {
  binding: RegistryBinding;
  computersRootDir: string;
  silverhandStateRootDir: string | null;
  logDir: string;
  alsoStderr: boolean;
  initialOutcome: LayoutMigrationOutcome | null;
}

function parseDirectPreflightArgv(
  argv: readonly string[],
): ParsedDirectPreflightArgv | { error: string } {
  let hostId: string | null = null;
  let serverOrigin: string | null = null;
  let computersRootDir: string | null = null;
  let silverhandStateRootDir: string | null = null;
  let logDir: string | null = null;
  let initialOutcome: LayoutMigrationOutcome | null = null;
  let alsoStderr = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--workspace-relocation-host-id':
        hostId = argv[++i] ?? null;
        break;
      case '--workspace-relocation-server-origin':
        serverOrigin = argv[++i] ?? null;
        break;
      case '--computers-root-dir':
        computersRootDir = argv[++i] ?? null;
        break;
      case '--silverhand-state-root-dir':
        silverhandStateRootDir = argv[++i] ?? null;
        break;
      case '--log-dir':
        logDir = argv[++i] ?? null;
        break;
      case '--layout-migration-outcome': {
        const value = argv[++i] ?? null;
        if (value !== 'migrated' && value !== 'already_current') {
          return {
            error:
              '--layout-migration-outcome must be migrated|already_current',
          };
        }
        initialOutcome = value;
        break;
      }
      case '--stderr':
        alsoStderr = true;
        break;
      default:
        return { error: `unknown preflight argument: ${arg}` };
    }
  }

  if (hostId === null || hostId.trim() === '') {
    return { error: '--workspace-relocation-host-id is required' };
  }
  if (serverOrigin === null || serverOrigin.trim() === '') {
    return { error: '--workspace-relocation-server-origin is required' };
  }
  if (computersRootDir === null || !computersRootDir.startsWith('/')) {
    return { error: '--computers-root-dir must be absolute' };
  }
  if (logDir === null || !logDir.startsWith('/')) {
    return { error: '--log-dir must be absolute' };
  }
  if (
    silverhandStateRootDir !== null &&
    !silverhandStateRootDir.startsWith('/')
  ) {
    return { error: '--silverhand-state-root-dir must be absolute' };
  }
  return {
    binding: { host_id: hostId, server_origin: serverOrigin },
    computersRootDir,
    silverhandStateRootDir,
    logDir,
    alsoStderr,
    initialOutcome,
  };
}

/** One-shot daemon-binary command used by Electron before it starts the
 * supervised daemon. Relocation duration is data-sized and therefore must not
 * run inside the daemon ready-handshake deadline. The migration implementation
 * and marker writer remain in the host process boundary; only the composition
 * order changes to match the prior layout-v2 pre-spawn migration. */
export async function runDirectStartupPreflightCommand(
  argv: readonly string[],
): Promise<number> {
  const parsed = parseDirectPreflightArgv(argv);
  if ('error' in parsed) {
    process.stderr.write(`silverhand-daemon preflight: ${parsed.error}\n`);
    return 1;
  }
  try {
    const outcome = await runDirectStartupPreflight({
      binding: parsed.binding,
      computersRootDir: parsed.computersRootDir,
      silverhandStateRootDir: parsed.silverhandStateRootDir,
      logDir: parsed.logDir,
      alsoStderr: parsed.alsoStderr,
      initialOutcome: parsed.initialOutcome,
    });
    process.stdout.write(
      `${JSON.stringify({
        event: WORKSPACE_PREFLIGHT_RESULT_EVENT,
        layout_migration_outcome: outcome,
      })}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `silverhand-daemon preflight: ${(err as Error).message}\n`,
    );
    return 1;
  }
}

/**
 * Run the same workspace startup preflight used by `connect` for a daemon that
 * Electron launches directly. Electron invokes this through the daemon binary's
 * one-shot `preflight` command before it spawns the supervised daemon. The host
 * process remains the migration owner and completion-marker writer, while the
 * ordinary daemon ready deadline starts only after data-sized work completes.
 *
 * A missing binding is a fresh/unclaimed desktop: there is no computer slot or
 * legacy registry to migrate yet, so the launcher-provided layout outcome is
 * preserved. Once a binding exists, omitting the computers root is a launcher
 * contract violation and fails before the data plane starts.
 */
export async function runDirectStartupPreflight(
  opts: DirectStartupPreflightOptions,
): Promise<LayoutMigrationOutcome | null> {
  if (opts.binding === null) return opts.initialOutcome;
  if (opts.computersRootDir === null) {
    throw new Error(
      'workspace relocation binding requires --computers-root-dir',
    );
  }

  const slot = resolveComputerSlotFromComputersRoot(
    opts.computersRootDir,
    opts.binding.host_id,
  );
  const logger = createDaemonLogger({
    dir: opts.logDir,
    alsoStderr: opts.alsoStderr,
    base: { component: 'silverhand-daemon', daemon_version: DAEMON_VERSION },
  });
  const migrationLogger = {
    info: (fields: Record<string, unknown>, message: string) =>
      logger.info(fields, message),
    warn: (fields: Record<string, unknown>, message: string) =>
      logger.warn(fields, message),
  };

  try {
    const result = runWorkspaceStartupPreflight({
      workspaceDataRootDir: slot.workspaceData,
      agentHomeRootDir: slot.agents,
      currentBinding: opts.binding,
      sessionStoreHome: opts.sessionStoreHome ?? homedir(),
      env: opts.env ?? (process.env as SessionStoreEnv),
      logger: migrationLogger,
    });
    logger.info(
      {
        action: 'workspace_startup_preflight_completed',
        hostId: opts.binding.host_id,
        migrated: result.migrated,
      },
      'workspace startup preflight completed before direct daemon bind',
    );
    await logger.close();
    return result.migrated
      ? 'migrated'
      : (opts.initialOutcome ?? 'already_current');
  } catch (err) {
    if (
      err instanceof FlattenLayoutError ||
      err instanceof SessionMigrationError ||
      err instanceof RelocationError
    ) {
      const stage: DaemonLayoutMigrationStage =
        err instanceof RelocationError
          ? 'workspace_layout_relocation'
          : 'workspace_data_convergence';
      const code = daemonLayoutMigrationCode(err.code);
      logger.error(
        {
          action: 'layout_v2_migration_failed',
          stage,
          code,
          layoutVersion: 2,
          daemonVersion: DAEMON_VERSION,
          hostId: opts.binding.host_id,
        },
        'workspace startup preflight failed; direct daemon not started',
      );
      if (opts.silverhandStateRootDir !== null) {
        recordLayoutMigrationFailure({
          appRoot: opts.silverhandStateRootDir,
          fact: {
            component: 'daemon',
            daemon_version: DAEMON_VERSION,
            stage,
            code,
            layout_version: 2,
          },
          logger,
        });
      }
    }
    await logger.close();
    throw err;
  }
}
