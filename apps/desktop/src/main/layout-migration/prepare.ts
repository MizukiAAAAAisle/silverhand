/**
 * #task:1613 — the DESKTOP composition entry's pre-connection layout
 * preparation, as ONE observable unit: quiesce the legacy runtime, run
 * the eager layout-v2 engine, and derive the migration outcome the
 * spawned daemon advertises on its ready handshake.
 *
 * Failure contract: any throw blocks startup (fail closed, bytes
 * intact). The daemon never starts after a failure, so the backend
 * cannot observe it — the `layout_v2_migration_failed` structured line
 * written here (stage + typed code + versions) IS the daemon-local
 * failure evidence. Nothing is reported upstream.
 *
 * Lives inside `layout-migration/` on purpose: it is part of the same
 * deletion unit and goes when the migration unit does.
 */
import { quiesceLegacyLocalRuntime } from './quiesce.js';
import { migrateDesktopAppDataLayout, type MigrationLogger } from './engine.js';

export type DesktopLayoutOutcome = 'migrated' | 'already_current';

export interface PrepareLogger extends MigrationLogger {
  error(fields: Record<string, unknown>, msg: string): void;
}

export async function prepareDesktopDataLayout(opts: {
  appRoot: string;
  logsDir: string;
  logger: PrepareLogger | null;
  appVersion: string;
  /** Test seams; production uses the real quiesce + engine. */
  deps?: {
    quiesce?: typeof quiesceLegacyLocalRuntime;
    migrate?: typeof migrateDesktopAppDataLayout;
  };
}): Promise<DesktopLayoutOutcome> {
  const quiesce = opts.deps?.quiesce ?? quiesceLegacyLocalRuntime;
  const migrate = opts.deps?.migrate ?? migrateDesktopAppDataLayout;
  let stage: 'quiesce' | 'engine' = 'quiesce';
  try {
    await quiesce(opts.appRoot, opts.logsDir);
    stage = 'engine';
    const result = migrate(opts.appRoot, {
      info: (f, m) => opts.logger?.info(f, m),
      warn: (f, m) => opts.logger?.warn(f, m),
    });
    // Outcome for the deletion gate — the marker fact, not a byte
    // accounting (`facets`/`sessions` arms don't cover every catch-up
    // move, e.g. the marker-v2 workspace-flatten pass with no session
    // buckets to rename): `result.migrated === true` means THIS boot ran
    // the migration/catch-up and stamped the complete marker (a fresh
    // install's first-time initialization included);
    // `false` means the complete marker already existed before boot.
    return result.migrated ? 'migrated' : 'already_current';
  } catch (err) {
    opts.logger?.error(
      {
        action: 'layout_v2_migration_failed',
        stage,
        code: (err as { code?: string }).code ?? 'unknown',
        layoutVersion: 2,
        appVersion: opts.appVersion,
      },
      'layout-v2 preparation failed; startup blocked',
    );
    throw err;
  }
}
