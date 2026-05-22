import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';

import { runDaemon } from '../src/daemon/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import {
  reconcileRuntimePidfiles,
  runtimePidFilePath,
  writeRuntimePidfile,
} from '../src/daemon/runtime-pidfiles.js';

function silentLogger(warnings: string[] = []): DaemonLogger {
  return {
    filePath: '/dev/null',
    logControl: createDaemonLogControl('debug'),
    debug: () => {},
    info: () => {},
    warn: (_fields, msg) => {
      warnings.push(msg ?? '');
    },
    error: () => {},
    close: async () => {},
  };
}

function makeFixture(): { dir: string; rootDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-runtime-pids-'));
  return { dir, rootDir: join(dir, 'runtime-pids') };
}

function spawnSleeper(): ChildProcess {
  return spawn(execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    wait(timeoutMs).then(() => {
      throw new Error(`child ${child.pid ?? 'unknown'} did not exit`);
    }),
  ]);
}

function makeErr(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('runtime pidfile orphan reconcile', () => {
  const fixtures: Array<{ dir: string }> = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    while (children.length) {
      const child = children.pop()!;
      if (child.pid && isAlive(child.pid)) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await waitForExit(child).catch(() => {});
    }
    while (fixtures.length) {
      rmSync(fixtures.pop()!.dir, { recursive: true, force: true });
    }
  });

  it('skips scanning when the root dir does not exist and does not kill unrelated live children', () => {
    const f = makeFixture();
    fixtures.push(f);
    const child = spawnSleeper();
    children.push(child);
    expect(child.pid).toBeGreaterThan(0);

    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(),
    });

    expect(result.skipped).toBe(true);
    expect(result.scanned).toBe(0);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it('preserves a live pidfile under the current daemon instance', () => {
    const f = makeFixture();
    fixtures.push(f);
    const child = spawnSleeper();
    children.push(child);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'self',
      conversationId: 'conv',
      agentId: 'agent',
      pid: child.pid!,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(),
    });

    expect(result.preservedSelf).toBe(1);
    expect(existsSync(filePath)).toBe(true);
    expect(isAlive(child.pid!)).toBe(true);
  });

  it('runDaemon boot SIGKILLs a live runtime pidfile from a prior daemon instance and unlinks it', async () => {
    const f = makeFixture();
    fixtures.push(f);
    const child = spawnSleeper();
    children.push(child);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'old',
      conversationId: 'conv',
      agentId: 'agent',
      pid: child.pid!,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const daemon = await runDaemon({
      socketPath: join(f.dir, 'daemon.sock'),
      pidFilePath: join(f.dir, 'daemon.pid'),
      logDir: join(f.dir, 'logs'),
      runtimePidRootDir: f.rootDir,
      installSignals: false,
      writeStdoutHandshake: false,
      supervisorFactory: null,
    });
    await daemon.stop('test_done');

    expect(existsSync(filePath)).toBe(false);
    await waitForExit(child);
    expect(isAlive(child.pid!)).toBe(false);
  });

  it('unlinks a pidfile whose pid is dead', () => {
    const f = makeFixture();
    fixtures.push(f);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'old',
      conversationId: 'conv',
      agentId: 'agent',
      pid: 123_456,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(),
      deps: {
        kill: () => {
          throw makeErr('ESRCH');
        },
      },
    });

    expect(result.unlinkedDead).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('unlinks corrupt JSON pidfiles without failing the scan', () => {
    const f = makeFixture();
    fixtures.push(f);
    const dir = join(f.rootDir, 'old');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'conv-agent.json');
    writeFileSync(filePath, '{bad json', { mode: 0o600 });

    const warnings: string[] = [];
    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(warnings),
    });

    expect(result.unlinkedCorrupt).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    expect(warnings.some(msg => msg.includes('corrupt'))).toBe(true);
  });

  it('preserves pidfiles when kill(0) reports EPERM', () => {
    const f = makeFixture();
    fixtures.push(f);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'old',
      conversationId: 'conv',
      agentId: 'agent',
      pid: 1234,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const warnings: string[] = [];
    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(warnings),
      deps: {
        kill: () => {
          throw makeErr('EPERM');
        },
      },
    });

    expect(result.preservedEperm).toBe(1);
    expect(existsSync(filePath)).toBe(true);
    expect(warnings.some(msg => msg.includes('cannot be signaled'))).toBe(true);
  });

  it('writes pidfiles atomically as JSON records', () => {
    const f = makeFixture();
    fixtures.push(f);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'self',
      conversationId: 'conv/unsafe',
      agentId: 'agent',
      pid: 42,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    expect(filePath).toBe(runtimePidFilePath(f.rootDir, 'self', 'conv/unsafe', 'agent'));
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toMatchObject({
      pid: 42,
      started_at: 100,
      conv: 'conv/unsafe',
      agent: 'agent',
      runtime: 'claude',
      cmd: execPath,
    });
  });
});
