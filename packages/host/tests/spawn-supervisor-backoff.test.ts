/**
 * Unit tests for the `spawnDaemonChild` supervisor's restart/backoff
 * state machine (D3.b Commit 1). The goal is to drive the full
 * spawnOnce → handshake → crash → backoff → respawn → reset cycle
 * without paying the cost (or flakiness) of a real `tsx` subprocess.
 *
 * Two test seams are exercised together:
 *
 *  - `SpawnClock` — a fake clock whose `now()` and `setTimeout()` are
 *    driven by the test, so backoff delays are zero wall-clock cost
 *    and deterministically observable.
 *  - `SpawnProcessImpl` — a fake `node:child_process.spawn` whose
 *    return value is a hand-rolled `ChildProcess` shape we can
 *    `emit('exit')` / `stdout.emit('data')` on synchronously. The
 *    test fabricates the daemon's `ready` NDJSON frame itself so
 *    the supervisor sees a real handshake without any subprocess.
 *
 * The fake supplies the minimum surface `spawnDaemonChild` calls into:
 *  - `child.stdout` / `child.stderr` event emitters with `setEncoding`
 *  - `child.kill(signal)` recorded for assertions
 *  - `child.once('exit'|'error', ...)` lifecycle
 *
 * Reclaim is disabled via `reclaimStaleDaemon: false` — these tests
 * don't write a real pid-file and shouldn't go down the reclaim path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  spawnDaemonChild,
  type DaemonHandle,
  type DaemonGenerationInfo,
  type SpawnClock,
  type SpawnProcessImpl,
  type SpawnTimer,
} from '../src/spawn.js';
import { HOST_PROTOCOL_VERSION } from '../src/protocol.js';
import { wireFixtures } from './fixtures/wire/wire-fixtures.js';

// ── Ready-frame fixture base ───────────────────────────────────────
//
// Pull the canonical `event/ready` frame from the wire fixtures
// catalogue (the byte-level contract source-of-truth — see
// `protocol.ts` "Authority layering"). Tests only override the
// per-spawn varying fields (pid / version / instance_id /
// socket_path); the rest (host_descriptor / capabilities /
// protocol_version) stays in lock-step with the fixture, so a future
// schema change fails one place instead of N hand-rolled copies.

interface ReadyFrameOverrides {
  pid: number;
  version: string;
  socketPath: string;
}

const READY_FIXTURE = wireFixtures.find(f => f.name === 'event/ready');
if (!READY_FIXTURE) {
  throw new Error('expected wireFixtures to include event/ready');
}
const READY_BASE = JSON.parse(READY_FIXTURE.frame.trim()) as Record<string, unknown>;
// Sanity-check the fixture matches the protocol constant the supervisor
// validates against; if a future bump diverges them this test catches it.
if (READY_BASE.protocol_version !== HOST_PROTOCOL_VERSION) {
  throw new Error(
    `wire fixture protocol_version (${String(READY_BASE.protocol_version)}) ` +
      `!= HOST_PROTOCOL_VERSION (${HOST_PROTOCOL_VERSION})`,
  );
}

function buildReadyFrame(o: ReadyFrameOverrides): string {
  return JSON.stringify({
    ...READY_BASE,
    daemon_version: o.version,
    instance_id: `instance-${o.pid}`,
    socket_path: o.socketPath,
    daemon_pid: o.pid,
  }) + '\n';
}

// ── Fake clock ─────────────────────────────────────────────────────
//
// A monotonically-advancing clock; `setTimeout(fn, ms)` records a
// timer at deadline = currentNow + ms. `advance(ms)` walks the clock
// forward and fires any timers whose deadline is now reached. Firing
// is order-stable: ties resolve by registration order. Test code
// asserts on `pending.length` to prove "no timer scheduled" cases.

interface FakeTimer {
  id: number;
  deadline: number;
  fn: () => void;
  cleared: boolean;
}

class FakeClock implements SpawnClock {
  private current = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): SpawnTimer {
    const timer: FakeTimer = {
      id: this.nextId++,
      deadline: this.current + ms,
      fn,
      cleared: false,
    };
    this.timers.push(timer);
    return {
      clear: () => {
        timer.cleared = true;
      },
    };
  }

  /** Walk forward `ms` and fire matured timers in deadline order. */
  advance(ms: number): void {
    const target = this.current + ms;
    // Loop because fired timer callbacks may register new ones.
    // Hard cap iterations to catch runaway test bugs early.
    for (let safety = 0; safety < 1000; safety++) {
      const due = this.timers
        .filter(t => !t.cleared && t.deadline <= target)
        .sort((a, b) => a.deadline - b.deadline || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0]!;
      this.current = next.deadline;
      // Mark fired by removing from registry BEFORE invoking, so
      // re-arming the same slot inside the callback is observable.
      this.timers = this.timers.filter(t => t !== next);
      next.fn();
    }
    this.current = target;
  }

  /** Count of un-cleared, un-fired timers. */
  get pendingCount(): number {
    return this.timers.filter(t => !t.cleared).length;
  }
}

// ── Fake child process ─────────────────────────────────────────────
//
// Minimal `ChildProcess` stand-in. The supervisor only touches:
//   - .stdout (event emitter with .setEncoding)
//   - .stderr (event emitter with .setEncoding)
//   - .once('exit'|'error', ...)
//   - .kill(signal)
// and nothing else. We expose `emitReady()` / `emitExit()` so tests
// can drive lifecycle deterministically.

class FakeStdStream extends EventEmitter {
  // The supervisor calls setEncoding('utf8') on stdout/stderr; we
  // accept and ignore it (data already arrives as strings).
  setEncoding(_enc: string): this {
    return this;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStdStream();
  readonly stderr = new FakeStdStream();
  /** Signals the supervisor sent to this child, in order. */
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  // Mirror Node ChildProcess state surface so supervisor code that
  // probes `exitCode` / `signalCode` to detect "already dead" sees
  // realistic values. `null` while alive; populated on `exit`.
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.exited) {
      // Real Node ChildProcess: kill() on an already-exited child
      // returns false and does NOT re-emit `exit`. Honour that
      // semantic so tests that probe the "crash → pending respawn →
      // kill() must not hang" path actually exercise the supervisor
      // bug fix (Cindy #task:627 P1) instead of being masked by a
      // fake-only courtesy re-emit.
      return false;
    }
    // Live child got a signal — simulate OS-driven exit-after-signal
    // in a microtask so the supervisor's `proc.once('exit', ...)`
    // listener registers first.
    queueMicrotask(() => {
      if (this.exited) return;
      this.exited = true;
      // Convention: kill-driven exits mirror Node's signalCode path
      // when the signal name is a NodeJS.Signals string.
      if (typeof signal === 'string') {
        this.signalCode = signal;
      } else {
        this.exitCode = 0;
      }
      this.emit('exit', this.exitCode);
    });
    return true;
  }

  /** Drive a successful handshake. The supervisor will resolve.
   *  The frame body is sourced from the canonical wire fixture so
   *  schema drift fails in one place, not N. */
  emitReady(opts: { pid: number; version: string; socketPath: string }): void {
    this.stdout.emit('data', buildReadyFrame(opts));
  }

  /** Drive a crash exit. */
  emitExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.emit('exit', code);
  }
}

// ── Test fixture ───────────────────────────────────────────────────

interface SupervisorFixture {
  clock: FakeClock;
  /** Children handed back by the fake spawn, in spawn order. */
  children: FakeChildProcess[];
  spawnImpl: SpawnProcessImpl;
  generationEvents: DaemonGenerationInfo[];
  exitEvents: Array<{ reason: string; code: number | null }>;
}

function setupFixture(): SupervisorFixture {
  const clock = new FakeClock();
  const children: FakeChildProcess[] = [];
  const spawnImpl: SpawnProcessImpl = (
    _command: string,
    _args: ReadonlyArray<string>,
    _options: SpawnOptions,
  ): ChildProcess => {
    const child = new FakeChildProcess();
    children.push(child);
    return child as unknown as ChildProcess;
  };
  return {
    clock,
    children,
    spawnImpl,
    generationEvents: [],
    exitEvents: [],
  };
}

/**
 * Spawn helper that drives the initial handshake. Returns the
 * resolved `DaemonHandle` plus the fixture so the test can keep
 * driving subsequent lifecycle events.
 */
async function spawnAndHandshake(args?: {
  maxRestarts?: number;
  backoffSchedule?: ReadonlyArray<number>;
  successResetMs?: number;
  initialPid?: number;
  initialVersion?: string;
}): Promise<SupervisorFixture & { handle: DaemonHandle }> {
  const fx = setupFixture();
  const pending = spawnDaemonChild({
    launcher: { command: 'fake-node', args: ['fake-entry.js'] },
    socketPath: '/tmp/silverhand-fake.sock',
    pidFilePath: '/tmp/silverhand-fake.pid',
    logDir: '/tmp/silverhand-fake-logs',
    alsoStderr: false,
    reclaimStaleDaemon: false,
    maxRestarts: args?.maxRestarts ?? 5,
    backoffSchedule: args?.backoffSchedule,
    successResetMs: args?.successResetMs,
    clock: fx.clock,
    spawnProcess: fx.spawnImpl,
  });
  // Yield so the supervisor's `spawnOnce` registers stdout listeners
  // before we push the ready frame.
  await Promise.resolve();
  await Promise.resolve();
  const first = fx.children[0];
  if (!first) throw new Error('expected initial child to be spawned');
  first.emitReady({
    pid: args?.initialPid ?? 12_345,
    version: args?.initialVersion ?? '0.1.0-fake',
    socketPath: '/tmp/silverhand-fake.sock',
  });
  const handle = await pending;
  handle.onDaemonGenerationChanged(info => fx.generationEvents.push(info));
  handle.onExit(info => fx.exitEvents.push(info));
  return { ...fx, handle };
}

/**
 * Drive a single crash → respawn → handshake cycle. `advanceMs`
 * walks the clock forward enough to trip the supervisor's scheduled
 * backoff timer; the new child's ready frame is then emitted.
 */
async function crashAndRespawn(
  fx: SupervisorFixture,
  args: { advanceMs: number; pid: number; version?: string },
): Promise<FakeChildProcess> {
  const prior = fx.children[fx.children.length - 1]!;
  const childCountBefore = fx.children.length;
  prior.emitExit(1);
  fx.clock.advance(args.advanceMs);
  // Allow the scheduled `tryRespawn` microtask + the new spawnOnce
  // to register their listeners before we feed in the next ready frame.
  await Promise.resolve();
  await Promise.resolve();
  if (fx.children.length !== childCountBefore + 1) {
    throw new Error(
      `expected one new child spawn after advance; got ${fx.children.length - childCountBefore}`,
    );
  }
  const fresh = fx.children[fx.children.length - 1]!;
  fresh.emitReady({
    pid: args.pid,
    version: args.version ?? '0.1.0-fake',
    socketPath: '/tmp/silverhand-fake.sock',
  });
  // Let `tryRespawn` await spawnOnce's promise + run its sync work.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return fresh;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('spawnDaemonChild supervisor — backoff + respawn', () => {
  let liveHandles: DaemonHandle[] = [];
  beforeEach(() => {
    liveHandles = [];
  });
  afterEach(async () => {
    for (const h of liveHandles) {
      try { await h.kill({ gracefulMs: 10 }); } catch { /* ignore */ }
    }
  });

  /**
   * D3.b contract: `onDaemonGenerationChanged` only fires after a
   * CRASH-triggered restart's handshake succeeds. The initial spawn
   * is consumed by the resolved `DaemonHandle` itself.
   */
  it('initial spawn does NOT trigger onDaemonGenerationChanged; first restart does', async () => {
    const fx = await spawnAndHandshake({ initialPid: 100, initialVersion: '0.1.0-a' });
    liveHandles.push(fx.handle);

    // After initial handshake, no generation event yet.
    expect(fx.generationEvents).toEqual([]);
    expect(fx.handle.pid).toBe(100);
    expect(fx.handle.daemonVersion).toBe('0.1.0-a');

    // Crash + respawn with new pid + version → generation hook fires
    // once with attempt=1, and the handle's pid/version reflect the
    // new daemon. Backoff[0] = 500ms by default. instanceId must
    // come from the new handshake (FakeChildProcess.emitReady
    // derives `instance-<pid>`).
    await crashAndRespawn(fx, { advanceMs: 500, pid: 200, version: '0.1.0-b' });

    expect(fx.generationEvents).toHaveLength(1);
    expect(fx.generationEvents[0]).toEqual({
      pid: 200,
      daemonVersion: '0.1.0-b',
      instanceId: 'instance-200',
      startedAt: 1_700_000_000_000,
      attempt: 1,
    });
    expect(fx.handle.pid).toBe(200);
    expect(fx.handle.daemonVersion).toBe('0.1.0-b');
  });

  /**
   * The backoff schedule actually gates respawn — advancing the
   * clock to T < delay must not spawn a new child; advancing past
   * delay must.
   */
  it('respawn fires only after backoff delay elapses', async () => {
    const fx = await spawnAndHandshake();
    liveHandles.push(fx.handle);

    fx.children[0]!.emitExit(1);
    // Below default backoff[0]=500ms → no new child yet.
    fx.clock.advance(499);
    await Promise.resolve();
    await Promise.resolve();
    expect(fx.children).toHaveLength(1);

    // One more ms → timer fires, new child spawned.
    fx.clock.advance(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(fx.children).toHaveLength(2);
  });

  /**
   * The "do not resurrect after quit" invariant: if `kill()` runs
   * while a backoff timer is pending, that timer must NOT spawn
   * another daemon when the clock later advances.
   *
   * This is also the regression for Cindy `#task:627` P1-B: in real
   * Node the crashed child's `ChildProcess` has already emitted its
   * single `exit`; `proc.once('exit', resolve)` registered later
   * never fires, and `proc.kill(SIGTERM)` is a no-op. Pre-fix
   * `kill()` would hang forever waiting on that exit event. The
   * supervisor's `proc.exitCode !== null` early-return resolves
   * immediately when the current child has already died. The fake
   * now mirrors real Node by NOT re-emitting `exit` on
   * already-dead `kill()`, so this test would hang pre-fix.
   */
  it('kill() resolves immediately when called during pending respawn window (does not hang on dead child)', async () => {
    const fx = await spawnAndHandshake();
    liveHandles.push(fx.handle);

    fx.children[0]!.emitExit(1);
    expect(fx.clock.pendingCount).toBeGreaterThan(0); // backoff timer armed

    // Don't await the kill — kill() awaits an inner Promise; the
    // supervisor's exitCode early-return must short-circuit it.
    const killP = fx.handle.kill({ gracefulMs: 10 });
    await Promise.resolve();
    // kill() must clear pending timers (restart + success-reset).
    expect(fx.clock.pendingCount).toBe(0);

    // The kill promise must resolve WITHOUT us advancing the clock,
    // i.e. without relying on the gracefulMs fallback SIGKILL timer.
    await killP;

    // Even advancing far past the would-be backoff fires nothing.
    fx.clock.advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(fx.children).toHaveLength(1);
    expect(fx.generationEvents).toEqual([]);
  });

  /**
   * If the respawn attempt's handshake itself fails, the supervisor
   * must emit a fatal `onExit` (and NOT `onDaemonGenerationChanged`).
   * We trigger this by emitting `exit` from the freshly-spawned
   * child before any ready frame.
   */
  it('respawn handshake failure → fatal onExit, NOT generation event', async () => {
    const fx = await spawnAndHandshake();
    liveHandles.push(fx.handle);

    fx.children[0]!.emitExit(1);
    fx.clock.advance(500);
    await Promise.resolve();
    await Promise.resolve();
    expect(fx.children).toHaveLength(2);

    // Second child exits before handshake → spawnOnce rejects →
    // tryRespawn fires fatal onExit.
    fx.children[1]!.emitExit(7);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fx.generationEvents).toEqual([]);
    expect(fx.exitEvents).toHaveLength(1);
    expect(fx.exitEvents[0]!.reason).toContain('daemon restart failed');
  });

  /**
   * Budget exhaustion: with `maxRestarts=2`, the first 2 crashes
   * each trigger a generation event; the 3rd crash (exitTimes.length=3
   * > maxRestarts=2) emits a fatal onExit and stops scheduling.
   *
   * Using a small budget keeps the test focused; the production
   * default is 5, and D3.b Commit 2 lets Electron main raise it
   * to express UI-layer policy.
   */
  it('budget exhaustion → fatal onExit after maxRestarts+1 crashes', async () => {
    const fx = await spawnAndHandshake({
      maxRestarts: 2,
      successResetMs: 60_000, // long enough that the reset never fires
    });
    liveHandles.push(fx.handle);

    await crashAndRespawn(fx, { advanceMs: 500, pid: 201 });
    await crashAndRespawn(fx, { advanceMs: 1_000, pid: 202 });
    expect(fx.generationEvents).toHaveLength(2);
    expect(fx.exitEvents).toHaveLength(0);

    // Third crash exceeds budget — supervisor stops scheduling.
    fx.children[fx.children.length - 1]!.emitExit(1);
    await Promise.resolve();
    expect(fx.exitEvents).toHaveLength(1);
    expect(fx.exitEvents[0]!.reason).toContain('giving up');
    // And critically: no new spawn was scheduled.
    fx.clock.advance(60_000);
    await Promise.resolve();
    expect(fx.children).toHaveLength(3);
  });

  /**
   * The success-reset wipes consecutive-crash bookkeeping: if a
   * respawned daemon runs successfully for `successResetMs`, the
   * NEXT isolated crash starts at backoff[0] and counts as attempt 1
   * again. This is what protects long-lived processes from drifting
   * into budget exhaustion over weeks.
   */
  it('successful run > successResetMs resets backoff + attempt counter', async () => {
    const fx = await spawnAndHandshake({
      maxRestarts: 1,             // budget = 1 unique crash before fatal
      successResetMs: 5_000,
      backoffSchedule: [100, 9_999], // [0]=100ms easy to assert
    });
    liveHandles.push(fx.handle);

    // First crash → respawn (uses backoff[0]=100ms).
    await crashAndRespawn(fx, { advanceMs: 100, pid: 301 });
    expect(fx.generationEvents).toHaveLength(1);
    expect(fx.generationEvents[0]!.attempt).toBe(1);

    // Run healthy past successResetMs → reset timer fires, wipes
    // the consecutive-crash bookkeeping.
    fx.clock.advance(5_000);

    // Next crash must again schedule at backoff[0]=100ms (not [1]),
    // and the attempt counter must be 1 (not 2).
    await crashAndRespawn(fx, { advanceMs: 100, pid: 302 });
    expect(fx.generationEvents).toHaveLength(2);
    expect(fx.generationEvents[1]!.attempt).toBe(1);

    // And with maxRestarts=1, since the counter was reset, this
    // second crash did NOT trigger fatal exit.
    expect(fx.exitEvents).toEqual([]);
  });
});
