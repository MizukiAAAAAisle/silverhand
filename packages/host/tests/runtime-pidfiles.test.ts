import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

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
    vi.restoreAllMocks();
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

  it('keeps AgentSlot and ConversationSlot pidfiles in disjoint namespaces', () => {
    const f = makeFixture();
    fixtures.push(f);
    const agentPath = runtimePidFilePath(f.rootDir, 'self', {
      kind: 'agent',
      agent_id: 'same-agent',
    });
    const conversationPath = runtimePidFilePath(f.rootDir, 'self', {
      kind: 'conversation',
      conversation_id: 'same-agent',
      agent_id: 'same-agent',
    });

    expect(agentPath).not.toBe(conversationPath);
    expect(agentPath).toContain('/agent/');
    expect(conversationPath).toContain('/conv/');
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
      runtimeScope: {
        kind: 'conversation',
        conversation_id: 'conv',
        agent_id: 'agent',
      },
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
      runtimeScope: {
        kind: 'conversation',
        conversation_id: 'conv',
        agent_id: 'agent',
      },
      pid: child.pid!,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const daemon = await runDaemon({
      socketPath: join(f.dir, 'daemon.sock'),
      daemonIdentityPath: join(f.dir, 'identity.json'),
      agentHomeRootDir: join(f.dir, 'agents'),
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
      runtimeScope: {
        kind: 'conversation',
        conversation_id: 'conv',
        agent_id: 'agent',
      },
      pid: 123_456,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeErr('ESRCH');
    });
    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(),
    });

    expect(kill.mock.calls).toEqual([[123_456, 0]]);
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
    expect(warnings.some((msg) => msg.includes('corrupt'))).toBe(true);
  });

  it('preserves pidfiles when kill(0) reports EPERM', () => {
    const f = makeFixture();
    fixtures.push(f);
    const filePath = writeRuntimePidfile({
      rootDir: f.rootDir,
      daemonInstanceId: 'old',
      runtimeScope: {
        kind: 'conversation',
        conversation_id: 'conv',
        agent_id: 'agent',
      },
      pid: 1234,
      startedAt: 100,
      runtime: 'claude',
      cmd: execPath,
    });

    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw makeErr('EPERM');
    });
    const warnings: string[] = [];
    const result = reconcileRuntimePidfiles({
      rootDir: f.rootDir,
      selfDaemonInstanceId: 'self',
      logger: silentLogger(warnings),
    });

    expect(kill.mock.calls).toEqual([[1234, 0]]);
    expect(result.preservedEperm).toBe(1);
    expect(existsSync(filePath)).toBe(true);
    expect(warnings.some((msg) => msg.includes('cannot be signaled'))).toBe(true);
  });

  it('writes pidfiles atomically as JSON records', () => {
    const f = makeFixture();
    fixtures.push(f);
    const params = {
      rootDir: f.rootDir,
      daemonInstanceId: 'self',
      runtimeScope: {
        kind: 'conversation' as const,
        conversation_id: 'conv/unsafe',
        agent_id: 'agent',
      },
      pid: 42,
      startedAt: 100,
      runtime: 'claude' as const,
      cmd: execPath,
    };
    const expectedPath = join(f.rootDir, 'self', 'conv', 'conv%2Funsafe-agent.json');
    mkdirSync(join(f.rootDir, 'self', 'conv'), { recursive: true });
    writeFileSync(expectedPath, 'previous complete record', { mode: 0o600 });
    const failure = makeErr('EIO');
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => writeRuntimePidfile(params)).toThrow(failure);
    expect(readFileSync(expectedPath, 'utf8')).toBe('previous complete record');
    expect(fs.readdirSync(join(f.rootDir, 'self', 'conv'))).toEqual(['conv%2Funsafe-agent.json']);

    const filePath = writeRuntimePidfile(params);

    expect(filePath).toBe(expectedPath);
    if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toMatchObject({
      pid: 42,
      started_at: 100,
      runtime_scope: {
        kind: 'conversation',
        conversation_id: 'conv/unsafe',
        agent_id: 'agent',
      },
      agent: 'agent',
      runtime: 'claude',
      cmd: execPath,
    });
  });
});
