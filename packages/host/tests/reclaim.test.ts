/**
 * Reclaim tests — deterministic simulation of every guard outcome
 * via injected `ReclaimDeps`. No real daemon spawned.
 *
 * Step 1 review boundary (per Cindy `1vRk1SIAFfa1x10t`): assert each
 * guard branch + reclaim flow makes the right decision against the
 * 4-check contract in design doc §1.2.1. Real-process integration
 * (actually spawning a stale daemon and reclaiming it) is covered
 * by the existing `spawn-daemon.test.ts` end-to-end fixture and
 * does not need expanding here for the protocol-level review.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReclaimFailLoudlyError,
  reclaimStaleDaemonIfPresent,
  type ReclaimDeps,
} from '../src/daemon/reclaim.js';
import type { DaemonLogger } from '../src/daemon/logger.js';

function silentLogger(): DaemonLogger {
  return {
    filePath: '/dev/null',
    info: () => {},
    warn: () => {},
    error: () => {},
    close: async () => {},
  };
}

interface Fixture {
  dir: string;
  pidFilePath: string;
  socketPath: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-reclaim-'));
  return {
    dir,
    pidFilePath: join(dir, 'daemon.pid'),
    socketPath: join(dir, 'daemon.sock'),
  };
}

function writePid(f: Fixture, pid: number): void {
  writeFileSync(f.pidFilePath, `${pid}\n`, { mode: 0o600 });
}

/** Build a minimal `ReclaimDeps` with all calls auto-failing —
 *  individual tests override only the calls they care about. */
function deps(over: Partial<ReclaimDeps> = {}): Partial<ReclaimDeps> {
  return {
    runPs: async () => '',
    pingDaemon: async () => ({ ok: false, reason: 'unreachable' }),
    signalPid: () => 'gone',
    waitForExit: async () => 'gone',
    ...over,
  };
}

describe('reclaim — pre-conditions', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    while (fixtures.length) {
      const f = fixtures.pop()!;
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('returns no_pid_file when the file does not exist', async () => {
    const f = makeFixture();
    fixtures.push(f);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps(),
    });
    expect(r).toEqual({ action: 'no_pid_file' });
  });

  it('returns stale_dead_pid when pid in file is not alive', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 99_999);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({ signalPid: () => 'gone' }),
    });
    expect(r).toEqual({ action: 'stale_dead_pid', pid: 99_999 });
  });

  it('returns stale_dead_pid for garbage pid file', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writeFileSync(f.pidFilePath, 'not-a-pid\n');
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps(),
    });
    expect(r.action).toBe('stale_dead_pid');
  });
});

describe('reclaim — guard (a) EPERM', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    while (fixtures.length) rmSync(fixtures.pop()!.dir, { recursive: true, force: true });
  });

  it('fails loudly with check=a_eperm when kill(0) returns EPERM', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({ signalPid: () => 'eperm' }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') {
      expect(r.check).toBe('a_eperm');
      expect(r.detail).toContain('EPERM');
    }
  });
});

describe('reclaim — guard (b) cmdline match', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    while (fixtures.length) rmSync(fixtures.pop()!.dir, { recursive: true, force: true });
  });

  it('fails loudly when cmdline lacks --socket-path token', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () => `node /some/silverhand-daemon --pid-file ${f.pidFilePath}`,
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('b_cmdline_mismatch');
  });

  it('fails loudly when cmdline lacks --pid-file token', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () => `node silverhand-daemon --socket-path ${f.socketPath}`,
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('b_cmdline_mismatch');
  });

  it('fails loudly when cmdline matches a sibling silverhand-dir', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const otherSocket = join(f.dir, 'other.sock');
    const otherPid = join(f.dir, 'other.pid');
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({
        signalPid: () => 'alive',
        // cmdline uses *different* paths — sibling daemon → guard (b) should fail.
        runPs: async () =>
          `silverhand-daemon --socket-path ${otherSocket} --pid-file ${otherPid}`,
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('b_cmdline_mismatch');
  });
});

describe('reclaim — guard (c)/(d) ping vs cmdline', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    while (fixtures.length) rmSync(fixtures.pop()!.dir, { recursive: true, force: true });
  });

  it('fails loudly when ping returns mismatching daemon_pid', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        // Live daemon on socket reports a *different* pid than the
        // file said — pid file lies; do not kill.
        pingDaemon: async () => ({ ok: true, daemon_pid: 9999 }),
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('c_ping_pid_mismatch');
  });

  it('proceeds to reclaim when ping succeeds and daemon_pid matches', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    let calledTerm = false;
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      gracefulMs: 10,
      killGraceMs: 10,
      deps: deps({
        signalPid: (_pid, signal) => {
          if (signal === 'SIGTERM') calledTerm = true;
          return 'alive';
        },
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: true, daemon_pid: 1234 }),
        waitForExit: async () => 'gone',
      }),
    });
    expect(r.action).toBe('reclaimed');
    expect(calledTerm).toBe(true);
  });

  it('proceeds to reclaim half-dead daemon (cmdline match + ECONNREFUSED)', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      gracefulMs: 10,
      killGraceMs: 10,
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: false, reason: 'unreachable' }),
        waitForExit: async () => 'gone',
      }),
    });
    expect(r.action).toBe('reclaimed');
  });

  it('fails loudly on ping invalid_response (other ping error modes)', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: false, reason: 'invalid_response' }),
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('d_ping_invalid');
  });
});

describe('reclaim — SIGTERM / SIGKILL / survived cascade', () => {
  const fixtures: Fixture[] = [];
  afterEach(() => {
    while (fixtures.length) rmSync(fixtures.pop()!.dir, { recursive: true, force: true });
  });

  it('reports method=sigterm when graceful exit is observed', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      gracefulMs: 10,
      killGraceMs: 10,
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: true, daemon_pid: 1234 }),
        waitForExit: async () => 'gone',
      }),
    });
    expect(r.action).toBe('reclaimed');
    if (r.action === 'reclaimed') expect(r.method).toBe('sigterm');
  });

  it('escalates to sigkill if SIGTERM does not exit within gracefulMs', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    let waitCount = 0;
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      gracefulMs: 10,
      killGraceMs: 10,
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: true, daemon_pid: 1234 }),
        waitForExit: async () => {
          waitCount++;
          // First call (after SIGTERM) → still alive; second call
          // (after SIGKILL) → gone.
          return waitCount === 1 ? 'still_alive' : 'gone';
        },
      }),
    });
    expect(r.action).toBe('reclaimed');
    if (r.action === 'reclaimed') expect(r.method).toBe('sigkill');
  });

  it('fails loudly with check=survived_sigkill when nothing kills the pid', async () => {
    const f = makeFixture();
    fixtures.push(f);
    writePid(f, 1234);
    const r = await reclaimStaleDaemonIfPresent({
      pidFilePath: f.pidFilePath,
      socketPath: f.socketPath,
      logger: silentLogger(),
      gracefulMs: 10,
      killGraceMs: 10,
      deps: deps({
        signalPid: () => 'alive',
        runPs: async () =>
          `silverhand-daemon --socket-path ${f.socketPath} --pid-file ${f.pidFilePath}`,
        pingDaemon: async () => ({ ok: true, daemon_pid: 1234 }),
        waitForExit: async () => 'still_alive',
      }),
    });
    expect(r.action).toBe('fail_loudly');
    if (r.action === 'fail_loudly') expect(r.check).toBe('survived_sigkill');
  });
});

describe('reclaim — error projection', () => {
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
});
