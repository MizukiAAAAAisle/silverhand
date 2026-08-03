import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import type { LayoutMigrationOutcome } from './protocol.js';
import type { RegistryBinding } from './daemon/workspace-registry/registry.js';
import { WORKSPACE_PREFLIGHT_RESULT_EVENT } from './workspace-preflight-protocol.js';
import type { DaemonLauncher } from './spawn.js';

const MAX_PREFLIGHT_STDOUT_BYTES = 64 * 1024;

export type PreflightSpawnProcessImpl = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => ChildProcess;

export interface SpawnWorkspacePreflightOptions {
  launcher: DaemonLauncher;
  logDir: string;
  computersRootDir: string;
  silverhandStateRootDir?: string | null;
  binding: RegistryBinding;
  layoutMigrationOutcome?: LayoutMigrationOutcome | null;
  alsoStderr?: boolean;
  spawnProcess?: PreflightSpawnProcessImpl;
}

/**
 * Run relocation as a bounded one-shot child BEFORE the supervised daemon is
 * spawned. There is deliberately no duration timeout: work scales with retained
 * L2/session bytes. Exit is still supervised, and the ordinary daemon's short
 * ready deadline remains unchanged because it starts only after this resolves.
 */
export function spawnWorkspaceStartupPreflight(
  opts: SpawnWorkspacePreflightOptions,
): Promise<LayoutMigrationOutcome> {
  const spawnImpl = opts.spawnProcess ??
    (nodeSpawn as PreflightSpawnProcessImpl);
  const alsoStderr = opts.alsoStderr ?? true;
  const args = [
    ...opts.launcher.args,
    'preflight',
    '--log-dir',
    opts.logDir,
    '--computers-root-dir',
    opts.computersRootDir,
    ...(opts.silverhandStateRootDir
      ? ['--silverhand-state-root-dir', opts.silverhandStateRootDir]
      : []),
    '--workspace-relocation-host-id',
    opts.binding.host_id,
    '--workspace-relocation-server-origin',
    opts.binding.server_origin,
    ...(opts.layoutMigrationOutcome
      ? ['--layout-migration-outcome', opts.layoutMigrationOutcome]
      : []),
    ...(alsoStderr ? ['--stderr'] : []),
  ];
  const proc = spawnImpl(opts.launcher.command, args, {
    env: { ...process.env, ...(opts.launcher.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', chunk => {
    process.stderr.write(typeof chunk === 'string' ? chunk : String(chunk));
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let overflow = false;
    let settled = false;
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', chunk => {
      if (overflow) return;
      stdout += typeof chunk === 'string' ? chunk : String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > MAX_PREFLIGHT_STDOUT_BYTES) {
        overflow = true;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    });
    proc.once('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    // `close`, unlike `exit`, fires after stdout/stderr are closed, so the
    // one result frame cannot race process termination.
    proc.once('close', code => {
      if (settled) return;
      settled = true;
      if (overflow) {
        reject(new Error('workspace startup preflight stdout overflowed'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`workspace startup preflight exited with code ${code}`));
        return;
      }
      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length !== 1) {
        reject(new Error('workspace startup preflight emitted an invalid result'));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[0]!);
      } catch {
        reject(new Error('workspace startup preflight emitted invalid JSON'));
        return;
      }
      const frame = parsed as {
        event?: unknown;
        layout_migration_outcome?: unknown;
      };
      if (
        frame.event !== WORKSPACE_PREFLIGHT_RESULT_EVENT ||
        (frame.layout_migration_outcome !== 'migrated' &&
          frame.layout_migration_outcome !== 'already_current')
      ) {
        reject(new Error('workspace startup preflight emitted an invalid result'));
        return;
      }
      resolve(frame.layout_migration_outcome);
    });
  });
}
