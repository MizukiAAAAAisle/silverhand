import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  defaultAppRoot,
  resolveLegacyStandaloneDaemonPaths,
} from '@silverhand/shared/app-data-layout';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import type { RuntimeKind } from '@silverhand/shared';

import type { DaemonLogger } from './logger.js';

export interface RuntimePidfileRecord {
  pid: number;
  started_at: number;
  conv: string;
  agent: string;
  runtime: RuntimeKind;
  cmd: string;
}

export interface RuntimePidfileWriteParams {
  rootDir: string;
  daemonInstanceId: string;
  conversationId: string;
  agentId: string;
  pid: number;
  startedAt: number;
  runtime: RuntimeKind;
  cmd: string;
}

export interface RuntimePidfileReconcileResult {
  skipped: boolean;
  scanned: number;
  unlinkedDead: number;
  unlinkedCorrupt: number;
  killedForeign: number;
  preservedSelf: number;
  preservedEperm: number;
  errors: number;
}

export interface RuntimePidfileDeps {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

type ProbeResult = 'alive' | 'dead' | 'eperm' | 'error';

export function defaultRuntimePidRootDir(): string {
  // Standalone default; env-AWARE since the v2 cutover (#task:1603, §8).
  return resolveLegacyStandaloneDaemonPaths(defaultAppRoot()).runtimePids;
}

export function buildDaemonInstanceId(startedAtMs: number, pid = process.pid): string {
  return `${startedAtMs}-${pid}`;
}

export function runtimePidFilePath(
  rootDir: string,
  daemonInstanceId: string,
  conversationId: string,
  agentId: string,
): string {
  return join(
    rootDir,
    daemonInstanceId,
    `${encodeURIComponent(conversationId)}-${encodeURIComponent(agentId)}.json`,
  );
}

export function writeRuntimePidfile(params: RuntimePidfileWriteParams): string {
  const filePath = runtimePidFilePath(
    params.rootDir,
    params.daemonInstanceId,
    params.conversationId,
    params.agentId,
  );
  mkdirSync(dirname(filePath), { recursive: true });

  const record: RuntimePidfileRecord = {
    pid: params.pid,
    started_at: params.startedAt,
    conv: params.conversationId,
    agent: params.agentId,
    runtime: params.runtime,
    cmd: params.cmd,
  };
  const tmpPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tmpPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort tmp cleanup */
    }
    throw err;
  }
  return filePath;
}

export function unlinkRuntimePidfile(params: {
  rootDir: string;
  daemonInstanceId: string;
  conversationId: string;
  agentId: string;
}): void {
  const filePath = runtimePidFilePath(
    params.rootDir,
    params.daemonInstanceId,
    params.conversationId,
    params.agentId,
  );
  unlinkIfExists(filePath);
}

export function reconcileRuntimePidfiles(params: {
  rootDir: string;
  selfDaemonInstanceId: string;
  logger: DaemonLogger;
  deps?: RuntimePidfileDeps;
}): RuntimePidfileReconcileResult {
  const result: RuntimePidfileReconcileResult = {
    skipped: false,
    scanned: 0,
    unlinkedDead: 0,
    unlinkedCorrupt: 0,
    killedForeign: 0,
    preservedSelf: 0,
    preservedEperm: 0,
    errors: 0,
  };

  if (!existsSync(params.rootDir)) {
    result.skipped = true;
    params.logger.info(
      { runtime_pid_root: params.rootDir },
      'runtime pidfile root missing; skipping orphan reconcile',
    );
    return result;
  }

  let instances;
  try {
    instances = readdirSync(params.rootDir, { withFileTypes: true });
  } catch (err) {
    result.errors++;
    params.logger.warn(
      {
        runtime_pid_root: params.rootDir,
        err: (err as Error).message,
      },
      'failed to read runtime pidfile root; skipping orphan reconcile',
    );
    return result;
  }

  for (const instanceEntry of instances) {
    if (!instanceEntry.isDirectory()) continue;
    const daemonInstanceId = instanceEntry.name;
    const instanceDir = join(params.rootDir, daemonInstanceId);
    let entries;
    try {
      entries = readdirSync(instanceDir, { withFileTypes: true });
    } catch (err) {
      result.errors++;
      params.logger.warn(
        {
          runtime_pid_dir: instanceDir,
          daemon_instance: daemonInstanceId,
          err: (err as Error).message,
        },
        'failed to read runtime pidfile instance dir; continuing',
      );
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = join(instanceDir, entry.name);
      result.scanned++;
      try {
        const record = readRuntimePidfile(filePath);
        if (!record) {
          unlinkIfExists(filePath);
          result.unlinkedCorrupt++;
          params.logger.warn(
            { runtime_pidfile: filePath },
            'runtime pidfile corrupt; unlinked',
          );
          continue;
        }

        const probe = probeProcess(record.pid, params.deps);
        if (probe === 'dead') {
          unlinkIfExists(filePath);
          result.unlinkedDead++;
          params.logger.info(
            {
              runtime_pidfile: filePath,
              pid: record.pid,
              daemon_instance: daemonInstanceId,
            },
            'runtime pidfile pointed at dead process; unlinked',
          );
          continue;
        }
        if (probe === 'eperm') {
          result.preservedEperm++;
          params.logger.warn(
            {
              runtime_pidfile: filePath,
              pid: record.pid,
              daemon_instance: daemonInstanceId,
            },
            'runtime pidfile process exists but cannot be signaled; preserving',
          );
          continue;
        }
        if (probe === 'error') {
          result.errors++;
          params.logger.warn(
            {
              runtime_pidfile: filePath,
              pid: record.pid,
              daemon_instance: daemonInstanceId,
            },
            'runtime pidfile process liveness check failed; preserving',
          );
          continue;
        }

        if (daemonInstanceId === params.selfDaemonInstanceId) {
          result.preservedSelf++;
          continue;
        }

        const killed = killForeignRuntime(record.pid, params.deps);
        if (killed === 'killed' || killed === 'gone') {
          unlinkIfExists(filePath);
          result.killedForeign++;
          params.logger.warn(
            {
              runtime_pidfile: filePath,
              pid: record.pid,
              daemon_instance: daemonInstanceId,
              self_daemon_instance: params.selfDaemonInstanceId,
              killed,
            },
            'killed runtime child owned by prior daemon instance',
          );
          continue;
        }

        if (killed === 'eperm') {
          result.preservedEperm++;
        } else {
          result.errors++;
        }
        params.logger.warn(
          {
            runtime_pidfile: filePath,
            pid: record.pid,
            daemon_instance: daemonInstanceId,
          },
          'runtime pidfile process could not be SIGKILLed; preserving',
        );
      } catch (err) {
        result.errors++;
        params.logger.warn(
          {
            runtime_pidfile: filePath,
            err: (err as Error).message,
          },
          'failed to reconcile runtime pidfile; continuing',
        );
      }
    }
  }

  return result;
}

function readRuntimePidfile(filePath: string): RuntimePidfileRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<
      RuntimePidfileRecord
    >;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0
    ) {
      return null;
    }
    if (
      typeof parsed.started_at !== 'number' ||
      !Number.isInteger(parsed.started_at)
    ) {
      return null;
    }
    if (typeof parsed.conv !== 'string' || parsed.conv.length === 0) return null;
    if (typeof parsed.agent !== 'string' || parsed.agent.length === 0) return null;
    if (typeof parsed.runtime !== 'string' || parsed.runtime.length === 0) return null;
    if (typeof parsed.cmd !== 'string' || parsed.cmd.length === 0) return null;
    return parsed as RuntimePidfileRecord;
  } catch {
    return null;
  }
}

function probeProcess(pid: number, deps?: RuntimePidfileDeps): ProbeResult {
  try {
    (deps?.kill ?? process.kill)(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return 'eperm';
    if (code === 'ESRCH') return 'dead';
    return 'error';
  }
}

function killForeignRuntime(
  pid: number,
  deps?: RuntimePidfileDeps,
): 'killed' | 'gone' | 'eperm' | 'error' {
  try {
    (deps?.kill ?? process.kill)(pid, 'SIGKILL');
    return 'killed';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'eperm';
    return 'error';
  }
}

function unlinkIfExists(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
