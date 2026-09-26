/** Reclaim controller contracts at the OS dependency boundary. This suite
 * proves refusal and signal ordering, not real-process termination. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ReclaimFailLoudlyError,
  reclaimStaleDaemonIfPresent,
  type ReclaimDeps,
} from '../src/daemon/reclaim.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';

const logger: DaemonLogger = {
  filePath: '/dev/null',
  logControl: createDaemonLogControl('debug'),
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  close: async () => {},
};

describe('bounded stale-daemon reclaim', () => {
  let dir: string;
  let pidFilePath: string;
  let socketPath: string;
  let cmdline: string;
  let deps: ReclaimDeps;

  beforeEach(() => {
    const root = process.env.SILVERHAND_DIR;
    if (!root) throw new Error('Set an isolated SILVERHAND_DIR for reclaim tests');
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, 'reclaim-'));
    pidFilePath = join(dir, 'daemon.pid');
    socketPath = join(dir, 'daemon.sock');
    cmdline = `silverhand-daemon --socket-path ${socketPath} --pid-file ${pidFilePath}`;
    writeFileSync(pidFilePath, '1234\n', { mode: 0o600 });
    deps = {
      runPs: vi.fn(async () => cmdline),
      pingDaemon: vi.fn(async () => ({ ok: true as const, daemon_pid: 1234 })),
      signalPid: vi.fn(() => 'alive' as const),
      waitForExit: vi.fn(async () => 'gone' as const),
    };
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const reclaim = () =>
    reclaimStaleDaemonIfPresent({
      pidFilePath,
      socketPath,
      logger,
      deps,
      gracefulMs: 17,
      killGraceMs: 23,
      pingTimeoutMs: 31,
    });

  it('returns no_pid_file without inspecting or signalling a process', async () => {
    rmSync(pidFilePath);
    expect(await reclaim()).toEqual({ action: 'no_pid_file' });
    expect(deps.signalPid).not.toHaveBeenCalled();
    expect(deps.runPs).not.toHaveBeenCalled();
  });

  it('returns stale_dead_pid without trying to terminate a dead process', async () => {
    vi.mocked(deps.signalPid).mockReturnValue('gone');
    expect(await reclaim()).toEqual({ action: 'stale_dead_pid', pid: 1234 });
    expect(deps.signalPid).toHaveBeenCalledExactlyOnceWith(1234, 0);
    expect(deps.runPs).not.toHaveBeenCalled();
    expect(deps.waitForExit).not.toHaveBeenCalled();
  });

  it('rejects a garbage pid file without signalling any process', async () => {
    writeFileSync(pidFilePath, 'not-a-pid\n');
    expect(await reclaim()).toEqual({ action: 'stale_dead_pid', pid: 0 });
    expect(deps.signalPid).not.toHaveBeenCalled();
    expect(deps.runPs).not.toHaveBeenCalled();
  });

  it.each([
    ['permission denied', 'a_eperm'],
    ['missing socket', 'b_cmdline_mismatch'],
    ['missing pid', 'b_cmdline_mismatch'],
    ['sibling directory', 'b_cmdline_mismatch'],
    ['ping pid mismatch', 'c_ping_pid_mismatch'],
    ['invalid ping', 'd_ping_invalid'],
  ] as const)('refuses %s before any destructive signal', async (condition, check) => {
    switch (condition) {
      case 'permission denied':
        vi.mocked(deps.signalPid).mockReturnValue('eperm');
        break;
      case 'missing socket':
        cmdline = `silverhand-daemon --pid-file ${pidFilePath}`;
        break;
      case 'missing pid':
        cmdline = `silverhand-daemon --socket-path ${socketPath}`;
        break;
      case 'sibling directory':
        cmdline = `silverhand-daemon --socket-path ${join(dir, 'other.sock')} --pid-file ${join(dir, 'other.pid')}`;
        break;
      case 'ping pid mismatch':
        vi.mocked(deps.pingDaemon).mockResolvedValue({ ok: true, daemon_pid: 9999 });
        break;
      case 'invalid ping':
        vi.mocked(deps.pingDaemon).mockResolvedValue({ ok: false, reason: 'invalid_response' });
        break;
    }
    const result = await reclaim();
    expect(result).toMatchObject({ action: 'fail_loudly', pid: 1234, check });
    if (condition === 'permission denied')
      expect(result).toHaveProperty('detail', expect.stringContaining('EPERM'));
    expect(deps.signalPid).toHaveBeenCalledExactlyOnceWith(1234, 0);
    expect(deps.waitForExit).not.toHaveBeenCalled();
  });

  it.each(['matching pid', 'unreachable', 'timeout'] as const)(
    'reclaims an identified daemon with %s using SIGTERM only when it exits',
    async (ping) => {
      if (ping !== 'matching pid')
        vi.mocked(deps.pingDaemon).mockResolvedValue({ ok: false, reason: ping });
      expect(await reclaim()).toEqual({
        action: 'reclaimed',
        pid: 1234,
        method: 'sigterm',
        cmdline,
      });
      expect(vi.mocked(deps.signalPid).mock.calls).toEqual([
        [1234, 0],
        [1234, 'SIGTERM'],
      ]);
      expect(deps.runPs).toHaveBeenCalledExactlyOnceWith(1234);
      expect(deps.pingDaemon).toHaveBeenCalledExactlyOnceWith(socketPath, 31);
      expect(deps.waitForExit).toHaveBeenCalledExactlyOnceWith(1234, 17);
    },
  );

  it.each(['gone', 'still_alive'] as const)(
    'escalates after graceful timeout and reports %s after SIGKILL',
    async (afterKill) => {
      vi.mocked(deps.waitForExit)
        .mockResolvedValueOnce('still_alive')
        .mockResolvedValueOnce(afterKill);
      expect(await reclaim()).toMatchObject(
        afterKill === 'gone'
          ? { action: 'reclaimed', pid: 1234, method: 'sigkill' }
          : { action: 'fail_loudly', pid: 1234, check: 'survived_sigkill' },
      );
      expect(vi.mocked(deps.signalPid).mock.calls).toEqual([
        [1234, 0],
        [1234, 'SIGTERM'],
        [1234, 'SIGKILL'],
      ]);
      expect(vi.mocked(deps.waitForExit).mock.calls).toEqual([
        [1234, 17],
        [1234, 23],
      ]);
    },
  );
});

it('ReclaimFailLoudlyError carries the result for callers to inspect', () => {
  const err = new ReclaimFailLoudlyError({
    action: 'fail_loudly',
    pid: 42,
    check: 'a_eperm',
    detail: 'EPERM',
  });
  expect(err.code).toBe('reclaim_fail_loudly');
  expect(err.result.check).toBe('a_eperm');
  expect(err.message).toContain('a_eperm');
  expect(err.message).toContain('42');
});
