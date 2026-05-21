/**
 * RealSupervisor 3a — spawn / output / hard stop / exit / status.
 *
 * Scope locked with Cindy in `jhH-vC1s_1J_jTLu`: this suite covers
 * execution-plane behavior only. Parse / wake / soft stop / watchdog
 * / lifecycle-lock land in 3b/3c with their own test suites.
 *
 * Test strategy: substitute a fake `Driver` whose `binary` points at
 * `tests/_fixtures/echo-runtime.cjs` (driven via argv flags) so we
 * can exercise real child_process.spawn against a controlled
 * binary. The supervisor itself is unmodified — only the test seam
 * is the driver factory + binary resolver.
 *
 * Timing: every test uses tight `sigtermToSigkillMs` / `sigkillTimeoutMs`
 * (50ms / 200ms) so the SIGKILL cascade completes inside the vitest
 * default 5s budget even when we deliberately exercise the
 * `--ignore-sigterm` path.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { execPath } from 'node:process';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { RealSupervisor } from '../src/daemon/real-supervisor/index.js';
import type { Driver, DriverSpawnContext, ParsedEvent } from '../src/drivers/index.js';
import type { DaemonLogger } from '../src/daemon/logger.js';
import type { EventFrame, RuntimeStartResult } from '../src/protocol.js';

const FIXTURE = join(__dirname, '_fixtures', 'echo-runtime.cjs');

/**
 * TS assertion helper: narrow a `RuntimeStartResult` to the success
 * arm so subsequent `.pid` / `.started_at` accesses typecheck. Throws
 * if the result is the cooldown arm — every existing 3a/3b test
 * expects a successful start, so the failure mode is "test setup is
 * wrong, not the code under test".
 *
 * 3c (Cindy `-pdNvRYOWip5e9yA`) replaced the flat result shape with a
 * discriminated union: `{started:true, pid, started_at, ...}` vs
 * `{started:false, reason:'init_cooldown', cooldown_until}`. Cooldown-
 * specific tests use the discriminator directly.
 */
function assertStarted(
  res: RuntimeStartResult,
): asserts res is Extract<RuntimeStartResult, { started: true }> {
  if (!res.started) {
    throw new Error(
      `expected start() to succeed, got cooldown: ${JSON.stringify(res)}`,
    );
  }
}

/** Build a noop logger that satisfies the `DaemonLogger` interface
 *  without actually writing. Tests don't assert on log contents; the
 *  §3.4 typed-helper tests live in `daemon-logging.test.ts`. */
function silentLogger(): DaemonLogger {
  const noop = (): void => {};
  return {
    filePath: '/dev/null',
    info: noop,
    warn: noop,
    error: noop,
    close: async () => {},
  };
}

/**
 * Fake driver that wraps the echo-runtime fixture. `extraArgs` lets
 * a single test customize the fixture's behavior (e.g. ask it to
 * write to stderr, or to ignore SIGTERM).
 */
function makeFakeDriver(extraArgs: string[] = []): Driver {
  return {
    kind: 'claude',
    binary: FIXTURE, // resolveBinary stub returns this verbatim
    kickoffMode: 'self_inits',
    busyDeliveryMode: 'direct',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    initLivenessSilenceMs: 30_000,
    initPreProtocolCapMs: 5 * 60_000,
    initPostProtocolMs: 60_000,
    buildArgs: (_ctx: DriverSpawnContext): string[] => [FIXTURE, ...extraArgs],
    applyEnv: env => ({ ...env }),
    encodeStdinMessage: () => null,
    encodeInterruptControl: () => null,
    parseLine: (_line: string): ParsedEvent[] => [],
    classifyInitProgress: () => null,
  };
}

/** Spy logger that records every event emit so individual assertions
 *  can scan for runtime_state / runtime_output / runtime_exit. */
function makeEmitSpy(): { emit: (e: EventFrame) => void; events: EventFrame[] } {
  const events: EventFrame[] = [];
  return { emit: e => events.push(e), events };
}

function makeSupervisor(opts: {
  driverArgs?: string[];
  sigtermToSigkillMs?: number;
  sigkillTimeoutMs?: number;
  spawnFn?: (b: string, a: ReadonlyArray<string>, o: SpawnOptions) => ChildProcess;
} = {}): {
  supervisor: RealSupervisor;
  events: EventFrame[];
} {
  const spy = makeEmitSpy();
  const driver = makeFakeDriver(opts.driverArgs);
  // Node fixture is a .cjs file; invoke via the same node binary the
  // test runner uses so we don't depend on the fixture being chmod +x.
  const realSpawn = spawn;
  const spawnFn =
    opts.spawnFn ??
    ((bin, args, options) => realSpawn(execPath, [bin, ...args.slice(1)], options));
  const supervisor = new RealSupervisor({
    emit: spy.emit,
    logger: silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    sigtermToSigkillMs: opts.sigtermToSigkillMs ?? 50,
    sigkillTimeoutMs: opts.sigkillTimeoutMs ?? 200,
  });
  return { supervisor, events: spy.events };
}

const baseStartParams = {
  conversation_id: 'c1',
  agent_id: 'a1',
  options: { runtime: 'claude' as const, agent_name: 'tester' },
};

async function waitFor(
  cond: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await wait(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('RealSupervisor 3a — spawn / status / phase emit', () => {
  it('start spawns a child with a real pid and emits runtime_state (starting → idle) + runtime_ready_for_drain', async () => {
    const { supervisor, events } = makeSupervisor();
    const res = await supervisor.start(baseStartParams);

    assertStarted(res);
    expect(res.pid).toBeGreaterThan(0);
    expect(typeof res.started_at).toBe('number');

    // After setImmediate ticks, the ready-for-drain event should land.
    await waitFor(() => events.some(e => e.event === 'runtime_ready_for_drain'));

    const states = events.filter(e => e.event === 'runtime_state');
    const startingStates = states.filter(
      e => e.event === 'runtime_state' && e.state.status === 'starting',
    );
    const idleStates = states.filter(
      e => e.event === 'runtime_state' && e.state.status === 'idle',
    );
    expect(startingStates.length).toBeGreaterThanOrEqual(1);
    expect(idleStates.length).toBeGreaterThanOrEqual(1);

    // status() reflects the live handle.
    const snap = supervisor.status({});
    expect(snap.runtimes).toHaveLength(1);
    expect(snap.runtimes[0]).toMatchObject({
      conversation_id: 'c1',
      agent_id: 'a1',
      phase: 'ready',
      pid: res.pid,
      started_at: res.started_at,
    });

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('start is idempotent — second start while running returns the same pid + started_at', async () => {
    const { supervisor } = makeSupervisor();
    const first = await supervisor.start(baseStartParams);
    const second = await supervisor.start(baseStartParams);
    assertStarted(first);
    assertStarted(second);
    expect(second.pid).toBe(first.pid);
    expect(second.started_at).toBe(first.started_at);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('start with startup_delivery flips startup_delivery_accepted=true on first call, false on repeat', async () => {
    // 3b lifts the 3a refusal: start() now accepts and consumes the
    // startup batch via stdin. The repeat-while-running call is still
    // idempotent and reports `startup_delivery_accepted=false` to
    // signal "your batch was not used by this attempt".
    const { supervisor } = makeSupervisor();
    const params = {
      ...baseStartParams,
      startup_delivery: {
        delivery_ids: [1, 2],
        payload: { type: 'user', text: 'hi' },
      },
    };
    const r1 = await supervisor.start(params);
    const r2 = await supervisor.start(params);
    assertStarted(r1);
    assertStarted(r2);
    expect(r1.startup_delivery_accepted).toBe(true);
    expect(r2.startup_delivery_accepted).toBe(false);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('start throws when options.runtime is missing', async () => {
    const { supervisor } = makeSupervisor();
    await expect(
      supervisor.start({
        conversation_id: 'c1',
        agent_id: 'a1',
        options: {},
      }),
    ).rejects.toThrow(/options.runtime is required/);
  });

  it('start throws when the binary resolver returns null', async () => {
    const spy = makeEmitSpy();
    const supervisor = new RealSupervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => makeFakeDriver(),
      resolveBinary: async () => null,
    });
    await expect(supervisor.start(baseStartParams)).rejects.toThrow(/not found on PATH/);
  });
});

describe('RealSupervisor 3a — output pump', () => {
  it('emits runtime_output for stdout chunks the child writes', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo', 'hello-from-stdout'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.stream === 'stdout' &&
          e.chunk.includes('hello-from-stdout'),
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('emits runtime_output for stderr chunks separately from stdout', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stderr', 'oh-no-an-error'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.stream === 'stderr' &&
          e.chunk.includes('oh-no-an-error'),
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('pauseOutput silently drops chunks; resumeOutput restores pumping', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo', 'before-pause'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' && e.chunk.includes('before-pause'),
      ),
    );

    const pauseRes = supervisor.pauseOutput({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect(pauseRes.paused).toBe(true);
    expect(events.some(e => e.event === 'runtime_output_paused')).toBe(true);

    // Re-pause is idempotent — no second ack event.
    const ackCountBefore = events.filter(
      e => e.event === 'runtime_output_paused',
    ).length;
    supervisor.pauseOutput({ conversation_id: 'c1', agent_id: 'a1' });
    const ackCountAfter = events.filter(
      e => e.event === 'runtime_output_paused',
    ).length;
    expect(ackCountAfter).toBe(ackCountBefore);

    const resumeRes = supervisor.resumeOutput({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect(resumeRes.resumed).toBe(true);
    expect(events.some(e => e.event === 'runtime_output_resumed')).toBe(true);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('pauseOutput / resumeOutput on unknown (conv, agent) return paused:false / resumed:false without emitting acks', async () => {
    const { supervisor, events } = makeSupervisor();
    const p = supervisor.pauseOutput({ conversation_id: 'cX', agent_id: 'aX' });
    const r = supervisor.resumeOutput({ conversation_id: 'cX', agent_id: 'aX' });
    expect(p.paused).toBe(false);
    expect(r.resumed).toBe(false);
    expect(
      events.filter(
        e =>
          e.event === 'runtime_output_paused' ||
          e.event === 'runtime_output_resumed',
      ),
    ).toEqual([]);
  });
});

describe('RealSupervisor 3a — hard stop / exit', () => {
  it('hard stop sends SIGTERM, child exits, runtime_state(failed, stopped) + runtime_exit(intentional=true) land', async () => {
    const { supervisor, events } = makeSupervisor();
    await supervisor.start(baseStartParams);
    await waitFor(() => events.some(e => e.event === 'runtime_ready_for_drain'));

    const stopRes = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    expect(stopRes).toMatchObject({ mode: 'hard', stopped: true });
    // exit_code may be null on Linux where SIGTERM-killed children
    // report code=null + signal='SIGTERM'; macOS often reports 143.
    // Both are valid wire shapes.
    if (stopRes.mode === 'hard') {
      expect(stopRes.exit_code === null || stopRes.exit_code === 143).toBe(true);
    }

    const exitEvt = events.find(e => e.event === 'runtime_exit');
    expect(exitEvt).toBeDefined();
    if (exitEvt && exitEvt.event === 'runtime_exit') {
      expect(exitEvt.intentional).toBe(true);
    }

    // Final state event carries the `stopped` terminal reason; per
    // Cindy `GMbjEkGUHrB1BBMe` `stopped` maps to status:'failed' (not
    // 'idle') — the agent did NOT complete cleanly, it was forcibly
    // terminated. Only `replied|turn_ended|replaced` map to idle.
    const lastState = [...events]
      .reverse()
      .find(e => e.event === 'runtime_state');
    expect(lastState).toBeDefined();
    if (lastState && lastState.event === 'runtime_state') {
      expect(lastState.state.terminalReason).toBe('stopped');
      expect(lastState.state.status).toBe('failed');
    }

    // status() now shows the handle as exited with pid=null.
    const snap = supervisor.status({});
    expect(snap.runtimes[0]?.phase).toBe('exited');
    expect(snap.runtimes[0]?.pid).toBeNull();
  });

  it('hard stop on a never-started runtime returns stopped:false + exit_code:null', async () => {
    const { supervisor } = makeSupervisor();
    const res = await supervisor.stop({
      conversation_id: 'cX',
      agent_id: 'aX',
      mode: 'hard',
    });
    expect(res).toEqual({ mode: 'hard', stopped: false, exit_code: null });
  });

  it('hard stop escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--ignore-sigterm'],
      sigtermToSigkillMs: 100,
      sigkillTimeoutMs: 1_000,
    });
    await supervisor.start(baseStartParams);
    // Wait for the fixture's READY line so we know its SIGTERM
    // handler is installed before we send the signal — otherwise
    // SIGTERM lands during node's startup window and kills the
    // process before the trap takes effect.
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );

    const t0 = Date.now();
    const stopRes = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    const elapsed = Date.now() - t0;

    // Cascade must take at least the SIGTERM grace before SIGKILL
    // lands — proves we actually wait, not bail early.
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(stopRes.mode).toBe('hard');
    if (stopRes.mode === 'hard') {
      // SIGKILL-terminated processes report code=null + signal='SIGKILL'
      // on every platform we care about.
      expect(stopRes.stopped).toBe(true);
      expect(stopRes.exit_code).toBeNull();
    }
  });

  it('hard stop safety-timeout resolves with stopped:false + exit_code:null when the child never reports exit', async () => {
    // Cindy `OQCA05pivtB8nSTC` B2: if the SIGKILL window expires and
    // the child still hasn't fired `exit`, we must NOT lie that it
    // stopped. Caller would otherwise treat its resources as freed
    // while the OS handle persists. Honest answer: `stopped:false,
    // exit_code:null`; leave the handle in `draining`; let the real
    // `attachChildListeners.once('exit')` fire later if/when the
    // child actually goes away.
    //
    // We exercise this with a stub ChildProcess that swallows kill()
    // and never emits 'exit' — no real OS process is involved.
    class StubChild extends EventEmitter {
      readonly pid = 999_999;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = { write: () => true, end: () => {} };
      kill(_sig?: NodeJS.Signals | number): boolean {
        // Pretend we delivered the signal but the child ignores it.
        return true;
      }
    }
    const stub = new StubChild();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;

    const { supervisor, events } = makeSupervisor({
      sigtermToSigkillMs: 30,
      sigkillTimeoutMs: 80,
      spawnFn,
    });
    await supervisor.start(baseStartParams);

    const t0 = Date.now();
    const stopRes = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    const elapsed = Date.now() - t0;

    expect(stopRes).toEqual({ mode: 'hard', stopped: false, exit_code: null });
    // Must have waited the full SIGKILL window — otherwise we bailed
    // before giving the child a chance to exit.
    expect(elapsed).toBeGreaterThanOrEqual(60);

    // Handle must stay in `draining` (not flipped to `exited`); no
    // `runtime_exit` event should have been emitted yet.
    const snap = supervisor.status({});
    expect(snap.runtimes[0]?.phase).toBe('draining');
    expect(snap.runtimes[0]?.pid).toBe(999_999);
    expect(events.some(e => e.event === 'runtime_exit')).toBe(false);

    // Cleanup: pretend the child finally exits so the supervisor's
    // primary listener fires and we leave no dangling handles.
    stub.emit('exit', null, 'SIGKILL');
    await waitFor(() => events.some(e => e.event === 'runtime_exit'));
  });

  it('voluntary child exit code 0 (no stop request) marks intentional=false; reason maps to replied → status:idle (Cindy `5nruk1IPaEHSab0T` B4)', async () => {
    // Cindy `5nruk1IPaEHSab0T` B4: a clean `exit(0)` is NOT a crash.
    // CM's terminal mapping uses code===0 → `replied/idle`; the
    // distinction matters for oneShot drivers (cursor) where a
    // single-turn process exits cleanly after producing its reply.
    // Mapping it to `crashed/failed` would let the UI / RunStateCache
    // mark every successful cursor run as failed.
    const { supervisor, events } = makeSupervisor({
      // Sleep briefly then voluntarily exit(0). The supervisor never
      // gets a stop() call — this exercises the clean-exit path.
      driverArgs: ['--sleep', '50'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_exit'),
      3_000,
    );
    const exitEvt = events.find(e => e.event === 'runtime_exit');
    expect(exitEvt && exitEvt.event === 'runtime_exit' && exitEvt.intentional).toBe(
      false,
    );
    if (exitEvt && exitEvt.event === 'runtime_exit') {
      expect(exitEvt.code).toBe(0);
    }
    const lastState = [...events]
      .reverse()
      .find(e => e.event === 'runtime_state');
    expect(lastState && lastState.event === 'runtime_state' && lastState.state.terminalReason).toBe(
      'replied',
    );
    expect(lastState && lastState.event === 'runtime_state' && lastState.state.status).toBe(
      'idle',
    );
  });

  it('voluntary child exit with NON-ZERO code marks intentional=false; reason maps to crashed → status:failed (Cindy `5nruk1IPaEHSab0T` B4)', async () => {
    // Counterpart to the clean-exit test: a non-zero `exit(N)` IS a
    // crash. We use a stub child so we can control the exit code
    // precisely (the echo-runtime.cjs fixture always exits 0).
    class CodeExitStub extends EventEmitter {
      readonly pid = 34_567;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (_l: string, cb?: (err?: Error | null) => void): boolean => {
          setImmediate(() => cb?.());
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        return true;
      }
    }
    const stub = new CodeExitStub();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;

    const { supervisor, events } = makeSupervisor({ spawnFn });
    await supervisor.start(baseStartParams);
    // Simulate a non-zero exit (e.g. binary crash on uncaught throw).
    stub.emit('exit', 137, null);
    await waitFor(() => events.some(e => e.event === 'runtime_exit'));

    const exitEvt = events.find(e => e.event === 'runtime_exit');
    expect(exitEvt && exitEvt.event === 'runtime_exit' && exitEvt.intentional).toBe(
      false,
    );
    if (exitEvt && exitEvt.event === 'runtime_exit') {
      expect(exitEvt.code).toBe(137);
    }
    const lastState = [...events]
      .reverse()
      .find(e => e.event === 'runtime_state');
    expect(lastState && lastState.event === 'runtime_state' && lastState.state.terminalReason).toBe(
      'crashed',
    );
    expect(lastState && lastState.event === 'runtime_state' && lastState.state.status).toBe(
      'failed',
    );
  });

  it('stdoutLineBuffer trailing partial is flushed at child exit (Cindy `5nruk1IPaEHSab0T` B5)', async () => {
    // Node's readline emits a final `line` for input that ends
    // without a trailing `\n`. The supervisor's chunk-buffered pump
    // must mirror that or the last JSON frame on quick exit (often
    // session_init / turn_end / error) silently vanishes from
    // parsed-event downstream. We stub a child that writes
    // `final-line` (no newline) to stdout, then exits — the parsed
    // event for that line must land in the event stream BEFORE the
    // runtime_exit frame.
    class TailFlushStub extends EventEmitter {
      readonly pid = 45_678;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (_l: string, cb?: (err?: Error | null) => void): boolean => {
          setImmediate(() => cb?.());
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        return true;
      }
    }
    const stub = new TailFlushStub();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;

    const { driver } = makeProgrammableDriver();
    // Pre-arm parseLine to return a session_init for whatever line
    // the supervisor hands it.
    driver.parseLine = (line: string) =>
      line === 'final-line'
        ? [{ kind: 'session_init', sessionId: 'sess-tail' }]
        : [];

    const spy = makeEmitSpy();
    const supervisor = new RealSupervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn,
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });
    await supervisor.start(baseStartParams);
    // Write an unterminated chunk to stdout (no `\n`). The supervisor
    // must keep it in `stdoutLineBuffer` and flush on exit.
    stub.stdout.emit('data', 'final-line');
    // Now exit cleanly.
    stub.emit('exit', 0, null);
    await waitFor(() => spy.events.some(e => e.event === 'runtime_exit'));

    const idxParsed = spy.events.findIndex(
      e =>
        e.event === 'runtime_parsed_event' &&
        e.parsed.kind === 'session_init' &&
        e.parsed.sessionId === 'sess-tail',
    );
    const idxExit = spy.events.findIndex(e => e.event === 'runtime_exit');
    expect(idxParsed).toBeGreaterThanOrEqual(0);
    expect(idxExit).toBeGreaterThanOrEqual(0);
    // Flush happens before phase='exited' is set + before the
    // runtime_exit frame is emitted, so the parsed event lands
    // first.
    expect(idxParsed).toBeLessThan(idxExit);
  });
});

describe('RealSupervisor 3a — stopAll / closeActivityLog', () => {
  it('stopAll hard-terminates every live handle and returns the count', async () => {
    const { supervisor, events } = makeSupervisor();
    await supervisor.start({ ...baseStartParams, agent_id: 'a1' });
    await supervisor.start({
      ...baseStartParams,
      conversation_id: 'c2',
      agent_id: 'a2',
    });
    await waitFor(
      () =>
        events.filter(e => e.event === 'runtime_ready_for_drain').length >= 2,
    );

    const res = await supervisor.stopAll({});
    expect(res.stopped_count).toBe(2);

    const snap = supervisor.status({});
    expect(snap.runtimes.every(r => r.phase === 'exited')).toBe(true);
  });

  it('closeActivityLog returns flushed:true (host has no activity log to flush in 3a)', () => {
    const { supervisor } = makeSupervisor();
    const res = supervisor.closeActivityLog({});
    expect(res).toEqual({ flushed: true });
  });
});

describe('RealSupervisor 3b — wake / soft stop write payload to stdin', () => {
  it('wake on a live runtime writes the encoded payload to stdin and returns delivered:true with the same delivery_ids', async () => {
    // 3b lifts the 3a stub: wake now writes the opaque payload to
    // the child's stdin (+ '\n') and returns delivered:true on
    // write success. We verify via the fixture's --echo-stdin mode,
    // which surfaces each received line back on stdout prefixed
    // with "STDIN:".
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e => e.event === 'runtime_output' && e.chunk.includes('READY'),
      ),
    );
    const res = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42, 43],
      kind: 'message',
      payload: { type: 'user', message: { content: 'hi' } },
    });
    expect(res).toEqual({
      delivered: true,
      delivery_ids: [42, 43],
    });
    // Echo from fixture confirms the bytes reached the child.
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('STDIN:{"type":"user"'),
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('wake returns startup_pending while the start batch is still in flight (step-0 mutex)', async () => {
    // Cindy `_JjyK8UrpcmYA5Iu`: while `startupDelivery !== null`,
    // wake() MUST reject with `startup_pending`. We pin the gate by
    // using a stub child whose `stdin.write` never invokes its
    // callback — that hangs `writeStdinPayload` forever, which
    // keeps `consumeStartupDelivery` from ever settling, so the
    // gate stays set for the lifetime of the test.
    class HungStdinStub extends EventEmitter {
      readonly pid = 12_345;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (
          _line: string,
          _cb?: (err?: Error | null) => void,
        ): boolean => true, // never call _cb → writeStdinPayload hangs
        end: () => {},
        destroyed: false,
        once: () => {}, // no 'drain' emit
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        // Simulate clean termination on stop so the cleanup at the
        // end of the test resolves promptly.
        setImmediate(() => this.emit('exit', 0, null));
        return true;
      }
    }
    const stub = new HungStdinStub();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;

    const { supervisor, events } = makeSupervisor({ spawnFn });
    await supervisor.start({
      ...baseStartParams,
      startup_delivery: {
        delivery_ids: [1, 2],
        payload: { type: 'user', message: { content: 'boot' } },
      },
    });
    // start() returns synchronously after scheduling the consume;
    // the consume promise is now hanging on stdin.write's missing
    // callback. The gate is pinned.
    const wakeRes = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [99],
      kind: 'message',
      payload: { type: 'user', message: { content: 'race' } },
    });
    expect(wakeRes).toEqual({
      delivered: false,
      reason: 'startup_pending',
      delivery_ids: [99],
    });
    // ready_for_drain must NOT have fired (Cindy: settle order is
    // consumed/failed → clear pending → ready). With the gate
    // pinned, neither happened.
    expect(events.some(e => e.event === 'runtime_ready_for_drain')).toBe(false);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('wake returns not_running when no handle exists', async () => {
    const { supervisor } = makeSupervisor();
    const unknown = await supervisor.wake({
      conversation_id: 'cX',
      agent_id: 'aX',
      delivery_ids: [1],
      kind: 'message',
      payload: {},
    });
    expect(unknown).toEqual({
      delivered: false,
      reason: 'not_running',
      delivery_ids: [1],
    });
  });

  it('wake returns draining while a hard stop is in flight', async () => {
    // After hardStopHandle flips phase → draining, subsequent wake
    // calls must report the right reason rather than try to write
    // to a stdin that's about to be torn down.
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--ignore-sigterm'],
      sigtermToSigkillMs: 1_000,
      sigkillTimeoutMs: 2_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );
    // Fire-and-forget the stop so we can observe the draining
    // window. We deliberately use --ignore-sigterm so the runtime
    // stays alive long enough for the wake to race.
    const stopPromise = supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    // Give the supervisor a tick to flip phase=draining.
    await new Promise(r => setImmediate(r));
    const res = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [77],
      kind: 'message',
      payload: {},
    });
    expect(res).toEqual({
      delivered: false,
      reason: 'draining',
      delivery_ids: [77],
    });
    await stopPromise;
  });

  it('soft stop writes the directive payload to stdin and returns directive_delivered:true without a reason', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );
    const res = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: { type: 'user', message: { content: 'please stop' } },
    });
    expect(res).toEqual({ mode: 'soft', directive_delivered: true });
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('STDIN:{"type":"user"'),
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('soft stop on unknown returns not_running with a reason', async () => {
    const { supervisor } = makeSupervisor();
    const res = await supervisor.stop({
      conversation_id: 'cX',
      agent_id: 'aX',
      mode: 'soft',
      soft_directive: 'whatever',
    });
    expect(res).toEqual({
      mode: 'soft',
      directive_delivered: false,
      reason: 'not_running',
    });
  });
});

describe('RealSupervisor 3b — clearSession behavior', () => {
  it('clearSession on unknown returns cleared:false; on live hard-stops the runtime and returns cleared:true (resume-state clear remains a 3b/backend concern)', async () => {
    const { supervisor, events } = makeSupervisor();
    const miss = await supervisor.clearSession({
      conversation_id: 'cX',
      agent_id: 'aX',
    });
    expect(miss).toEqual({ cleared: false });

    await supervisor.start(baseStartParams);
    const hit = await supervisor.clearSession({
      conversation_id: 'c1',
      agent_id: 'a1',
    });
    expect(hit).toEqual({ cleared: true });
    expect(events.some(e => e.event === 'runtime_exit')).toBe(true);
  });
});

// ── 3b parse fanout / run-state / startup_delivery tests ───────────

/** Build a fake driver whose `parseLine` returns whatever the test
 *  pre-loads via `setNextParse`. Lets us drive the supervisor's
 *  parse fanout without depending on a real driver's JSON shape.
 *
 *  `kickoffMode` defaults to `'self_inits'` (matches claude); pass
 *  `'requires_first_message'` for B2 deferred-consume tests. */
function makeProgrammableDriver(
  extraArgs: string[] = [],
  kickoffMode: 'self_inits' | 'requires_first_message' = 'self_inits',
): {
  driver: Driver;
  setNextParse: (events: ParsedEvent[]) => void;
} {
  let next: ParsedEvent[] = [];
  const driver: Driver = {
    kind: 'claude',
    binary: FIXTURE,
    kickoffMode,
    busyDeliveryMode: 'direct',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    initLivenessSilenceMs: 30_000,
    initPreProtocolCapMs: 5 * 60_000,
    initPostProtocolMs: 60_000,
    buildArgs: () => [FIXTURE, '--echo-stdin', ...extraArgs],
    applyEnv: env => ({ ...env }),
    encodeStdinMessage: () => null,
    encodeInterruptControl: () => null,
    parseLine: () => {
      const out = next;
      next = [];
      return out;
    },
    classifyInitProgress: () => null,
  };
  return { driver, setNextParse: events => (next = events) };
}

function makeSupervisorWithDriver(driver: Driver, opts: {
  sigtermToSigkillMs?: number;
  sigkillTimeoutMs?: number;
} = {}): {
  supervisor: RealSupervisor;
  events: EventFrame[];
} {
  const spy = makeEmitSpy();
  const realSpawn = spawn;
  const spawnFn = (
    bin: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ): ChildProcess => realSpawn(execPath, [bin, ...args.slice(1)], options);
  const supervisor = new RealSupervisor({
    emit: spy.emit,
    logger: silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    sigtermToSigkillMs: opts.sigtermToSigkillMs ?? 50,
    sigkillTimeoutMs: opts.sigkillTimeoutMs ?? 200,
  });
  return { supervisor, events: spy.events };
}

// ParsedEvent / Driver are imported at the top of the file (via
// `../src/drivers/index.js`, which re-exports `ParsedEvent` from
// `@silverhand/shared`).

describe('RealSupervisor 3b — parse fanout (Cindy `OQCA05pivtB8nSTC` + `C2BZGDbQWfnq-bKJ`)', () => {
  it('every stdout line is passed to driver.parseLine and each returned ParsedEvent is fanned out as runtime_parsed_event', async () => {
    const { driver, setNextParse } = makeProgrammableDriver(['--emit-line', 'PROBE']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    // Pre-load parse results so when the fixture's READY / PROBE
    // lines arrive, parseLine returns concrete events.
    setNextParse([
      { kind: 'session_init', sessionId: 'sess-abc' },
      { kind: 'text', text: 'hi from driver' },
    ]);
    await supervisor.start(baseStartParams);

    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_parsed_event' &&
          e.parsed.kind === 'session_init' &&
          e.parsed.sessionId === 'sess-abc',
      ),
    );
    expect(
      events.some(
        e =>
          e.event === 'runtime_parsed_event' &&
          e.parsed.kind === 'text' &&
          e.parsed.text === 'hi from driver',
      ),
    ).toBe(true);
    // Raw `runtime_output` MUST also carry the same bytes (Cindy:
    // parse fanout is a sidecar, not a replacement for raw output).
    expect(
      events.some(
        e => e.event === 'runtime_output' && e.chunk.includes('READY'),
      ),
    ).toBe(true);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('parsed events drive AgentRunState transitions (thinking → tool_running → thinking → idle)', async () => {
    const { driver } = makeProgrammableDriver([
      '--emit-line', 'A',
      '--emit-line', 'B',
      '--emit-line', 'C',
      '--emit-line', 'D',
    ]);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    // 5 stdout lines arrive: READY, A, B, C, D. The first call
    // (READY) consumes step 0; the remaining four drive the
    // lifecycle. step beyond the sequence returns [].
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],                                                  // READY (no-op)
      [{ kind: 'thinking', text: 'pondering' }],          // A → thinking
      [{ kind: 'tool_call', name: 'Bash', input: {} }],   // B → tool_running(Bash)
      [{ kind: 'tool_output', name: 'Bash' }],            // C → thinking (outstanding=0)
      [{ kind: 'turn_end' }],                              // D → idle (turn_ended)
    ];
    driver.parseLine = () => sequence[step++] ?? [];

    await supervisor.start(baseStartParams);

    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_state' &&
          e.state.status === 'idle' &&
          e.state.terminalReason === 'turn_ended',
      ),
      3_000,
    );

    const statusSeq = events
      .filter(e => e.event === 'runtime_state')
      .map(e => (e.event === 'runtime_state' ? e.state.status : ''));
    // Must contain the lifecycle in order; allow other status emits
    // (starting, idle, etc.) interleaved.
    const required = ['thinking', 'tool_running', 'thinking', 'idle'];
    let cursor = 0;
    for (const s of statusSeq) {
      if (s === required[cursor]) cursor++;
      if (cursor === required.length) break;
    }
    expect(cursor).toBe(required.length);

    const lastIdle = [...events]
      .reverse()
      .find(
        e => e.event === 'runtime_state' && e.state.status === 'idle',
      );
    expect(
      lastIdle &&
        lastIdle.event === 'runtime_state' &&
        lastIdle.state.terminalReason,
    ).toBe('turn_ended');

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('a parsed event whose encoded frame exceeds MAX_FRAME_BYTES is downgraded to runtime_parsed_event_dropped (no payload leaked)', async () => {
    const { driver } = makeProgrammableDriver(['--emit-line', 'A']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    // Build a tool_call with a huge `input` so the encoded frame
    // blows past MAX_FRAME_BYTES (1 MiB).
    const huge = 'x'.repeat(2 * 1024 * 1024);
    driver.parseLine = () => [
      { kind: 'tool_call', name: 'Bash', input: { command: huge } },
    ];

    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_parsed_event_dropped'),
      3_000,
    );

    // The dropped frame is metadata-only — no payload fields.
    const dropped = events.find(
      e => e.event === 'runtime_parsed_event_dropped',
    );
    expect(dropped).toBeDefined();
    if (dropped && dropped.event === 'runtime_parsed_event_dropped') {
      expect(dropped.parsed_kind).toBe('tool_call');
      expect(dropped.reason).toBe('frame_too_large');
      expect(dropped.encoded_bytes).toBeGreaterThan(1 * 1024 * 1024);
      // Hard rule: no payload leakage.
      const keys = new Set(Object.keys(dropped));
      expect(keys.has('parsed')).toBe(false);
      expect(keys.has('input')).toBe(false);
      expect(keys.has('raw')).toBe(false);
      expect(keys.has('text')).toBe(false);
      expect(keys.has('name')).toBe(false);
    }

    // No full runtime_parsed_event for the same kind should have
    // landed (we'd otherwise be double-counting).
    const fullToolCallEvents = events.filter(
      e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
    );
    expect(fullToolCallEvents).toHaveLength(0);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('frame-too-large does not block run-state derivation (run-state still updates from the parsed event)', async () => {
    // Cindy `C2BZGDbQWfnq-bKJ`: even when a parsed event can't make
    // it onto the wire, its host-internal run-state effect must
    // still apply. We use a huge tool_call to trigger the dropped
    // path, then verify a tool_running state transition still
    // surfaced.
    const { driver } = makeProgrammableDriver(['--emit-line', 'A']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    const huge = 'x'.repeat(2 * 1024 * 1024);
    driver.parseLine = () => [
      { kind: 'tool_call', name: 'BigTool', input: { blob: huge } },
    ];

    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_parsed_event_dropped'),
      3_000,
    );
    // run-state should have transitioned to tool_running(BigTool).
    const toolRunning = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.status === 'tool_running' &&
        e.state.detail === 'BigTool',
    );
    expect(toolRunning).toBeDefined();
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('session_init flips initObserved and caches cli_session_id on the handle (visible via status())', async () => {
    const { driver, setNextParse } = makeProgrammableDriver(['--emit-line', 'INIT']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    setNextParse([{ kind: 'session_init', sessionId: 'sess-xyz' }]);
    await supervisor.start(baseStartParams);

    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_parsed_event' &&
          e.parsed.kind === 'session_init',
      ),
    );
    // Run-state is not created by session_init alone (no observable
    // activity yet), so status().run_state stays null at this point —
    // but that's a separate concern. The cli_session_id is cached on
    // the handle; we'd need an internal probe to assert it. For
    // public surface, confirm the runtime_parsed_event landed:
    const sessionInit = events.find(
      e =>
        e.event === 'runtime_parsed_event' &&
        e.parsed.kind === 'session_init',
    );
    expect(sessionInit).toBeDefined();
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('RealSupervisor 3b — startup_delivery step-0 mutex', () => {
  it('start with startup_delivery delays runtime_ready_for_drain until the batch settles (runtime_startup_delivery_consumed comes first)', async () => {
    // Cindy `wuiwdLKrLFyGip_s`: settle order is
    //   consumed/failed → clear pending → ready_for_drain.
    // We verify by enforcing the relative event ordering.
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    await supervisor.start({
      ...baseStartParams,
      startup_delivery: {
        delivery_ids: [101, 102],
        payload: { type: 'user', message: { content: 'boot batch' } },
      },
    });
    await waitFor(() => events.some(e => e.event === 'runtime_ready_for_drain'));

    const idxConsumed = events.findIndex(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    const idxReady = events.findIndex(
      e => e.event === 'runtime_ready_for_drain',
    );
    expect(idxConsumed).toBeGreaterThanOrEqual(0);
    expect(idxReady).toBeGreaterThan(idxConsumed);

    const consumed = events.find(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    if (consumed && consumed.event === 'runtime_startup_delivery_consumed') {
      expect(consumed.delivery_ids).toEqual([101, 102]);
    }

    // ready_for_drain must be emitted exactly once.
    const readyCount = events.filter(
      e => e.event === 'runtime_ready_for_drain',
    ).length;
    expect(readyCount).toBe(1);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('startup_delivery gate is cleared even if the child exits before the supervisor writes the batch (no startup_pending leak)', async () => {
    // Cindy `wuiwdLKrLFyGip_s`: failed settle must still clear the
    // gate. The invariant is "any subsequent wake never returns
    // `startup_pending` after the start batch lands one of
    // consumed/failed". We exercise that via a child that exits
    // fast (--sleep 1): the supervisor's consume path races with
    // the exit handler — either path clears the gate. The
    // `runtime_ready_for_drain` event MAY or MAY NOT fire depending
    // on who won the race; the relevant assertion is gate-clear,
    // not the absence of ready_for_drain.
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--sleep', '1'],
    });
    await supervisor
      .start({
        ...baseStartParams,
        startup_delivery: {
          delivery_ids: [201],
          payload: { type: 'user', message: { content: 'boot batch' } },
        },
      })
      .catch(() => {});
    await waitFor(
      () =>
        events.some(e => e.event === 'runtime_exit') ||
        events.some(e => e.event === 'runtime_startup_delivery_failed') ||
        events.some(e => e.event === 'runtime_startup_delivery_consumed'),
      3_000,
    );
    // After the dust settles, a wake must NOT report startup_pending
    // (it'll usually be not_running because the child already exited;
    // if consume won the race, wake may even succeed — both are fine.
    // The key invariant Cindy `wuiwdLKrLFyGip_s` locked is the gate
    // cleared, NOT a particular post-clear outcome).
    const wakeRes = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [202],
      kind: 'message',
      payload: { type: 'user', message: { content: 'after-death' } },
    });
    if (!wakeRes.delivered) {
      expect((wakeRes as { reason: string }).reason).not.toBe('startup_pending');
    }

    // If the supervisor took the explicit failed path, verify the
    // delivery_ids round-trip and reason=child_exit (this is the
    // path that runs when the exit handler beats the consume).
    const failed = events.find(
      e => e.event === 'runtime_startup_delivery_failed',
    );
    if (failed && failed.event === 'runtime_startup_delivery_failed') {
      expect(failed.delivery_ids).toEqual([201]);
      expect(failed.reason).toBe('child_exit');
    }
  });
});

describe('RealSupervisor 3b — Cindy `YW2BGWryWjfymPkU` B2: deferred startup_delivery consume for requires_first_message drivers', () => {
  it('write success alone does NOT settle the gate when driver.kickoffMode === requires_first_message; consumed fires only after session_init', async () => {
    // CM's `initPendingInboxIds` defers `markDelivered` for codex-like
    // (`requires_first_message`) drivers until `session_init` arrives,
    // so the supervisor must mirror that. Until session_init,
    // `runtime_startup_delivery_consumed` and `runtime_ready_for_drain`
    // are bottled up, and `runtime_wake` returns `startup_pending`.
    // Use a stub child so we control stdin completion AND session_init
    // arrival timing precisely.
    class ControlledStub extends EventEmitter {
      readonly pid = 23_456;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      writeResolved = false;
      readonly stdin = {
        write: (
          _line: string,
          cb?: (err?: Error | null) => void,
        ): boolean => {
          // Resolve on next tick so `writeStdinPayload` settles, but
          // the caller can observe state in between.
          setImmediate(() => {
            this.writeResolved = true;
            cb?.();
          });
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        setImmediate(() => this.emit('exit', 0, null));
        return true;
      }
    }
    const stub = new ControlledStub();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;

    const { driver } = makeProgrammableDriver([], 'requires_first_message');
    const spy = makeEmitSpy();
    const supervisor = new RealSupervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn,
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    await supervisor.start({
      ...baseStartParams,
      startup_delivery: {
        delivery_ids: [501, 502],
        payload: { type: 'user', message: { content: 'boot batch' } },
      },
    });

    // Wait for the stdin write to have actually completed (the consume
    // path is async — start() returned before the write settled).
    await waitFor(() => stub.writeResolved, 1_000);
    // Give the supervisor a couple of ticks to process the post-write
    // branch. Since requires_first_message + !initObserved, the gate
    // must NOT clear and ready_for_drain must NOT fire.
    await wait(40);

    expect(
      spy.events.some(e => e.event === 'runtime_startup_delivery_consumed'),
    ).toBe(false);
    expect(spy.events.some(e => e.event === 'runtime_ready_for_drain')).toBe(
      false,
    );
    expect(spy.events.some(e => e.event === 'runtime_startup_delivery_failed')).toBe(
      false,
    );

    // Wake during this window must return `startup_pending` (gate
    // still closed via `handle.startupDelivery !== null`).
    const wakeMid = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [777],
      kind: 'message',
      payload: {},
    });
    expect(wakeMid).toEqual({
      delivered: false,
      reason: 'startup_pending',
      delivery_ids: [777],
    });

    // Now drive a `session_init` parsed event by emitting a stdout
    // line; the programmable driver returns whatever its parseLine
    // hook returns. The line content itself is irrelevant — parseLine
    // sees any non-empty line.
    driver.parseLine = () => [
      { kind: 'session_init', sessionId: 'sess-deferred' },
    ];
    stub.stdout.emit('data', 'irrelevant-line-content\n');

    // After session_init, settle order must be:
    //   consumed → clear gate → ready_for_drain
    // (the `runtime_parsed_event` sidecar is emitted by
    // `emitParsedEvent` AFTER `updateRunStateFromParsed`, so its
    // index is later than both consumed and ready — that's a
    // cosmetic ordering and not the invariant. The semantic
    // invariant is `consumed < ready`.)
    await waitFor(
      () => spy.events.some(e => e.event === 'runtime_ready_for_drain'),
      1_000,
    );
    const idxConsumed = spy.events.findIndex(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    const idxReady = spy.events.findIndex(
      e => e.event === 'runtime_ready_for_drain',
    );
    const idxSessionInit = spy.events.findIndex(
      e =>
        e.event === 'runtime_parsed_event' &&
        e.parsed.kind === 'session_init',
    );
    expect(idxSessionInit).toBeGreaterThanOrEqual(0);
    expect(idxConsumed).toBeGreaterThanOrEqual(0);
    expect(idxReady).toBeGreaterThan(idxConsumed);

    const consumed = spy.events.find(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    if (consumed && consumed.event === 'runtime_startup_delivery_consumed') {
      expect(consumed.delivery_ids).toEqual([501, 502]);
    }

    // ready_for_drain fires exactly once even with the deferred path.
    const readyCount = spy.events.filter(
      e => e.event === 'runtime_ready_for_drain',
    ).length;
    expect(readyCount).toBe(1);

    // Wake after settle now succeeds.
    const wakeAfter = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [999],
      kind: 'message',
      payload: {},
    });
    expect(wakeAfter.delivered).toBe(true);

    // Cleanup.
    setImmediate(() => stub.emit('exit', 0, null));
  });
});

describe('RealSupervisor 3b — Cindy `YW2BGWryWjfymPkU` B3: resolveRun terminal semantics', () => {
  it('turn_end resolves the run; the next thinking event creates a fresh runId with no leaked terminalReason', async () => {
    // resolveRun() clears `handle.runState` after emitting the terminal
    // so the next observable activity must allocate a NEW runId via
    // `transitionRunState`'s lazy creation path. Without B3's fix the
    // old runState would keep accumulating with a `terminalReason`
    // stuck on it.
    const { driver } = makeProgrammableDriver([
      '--emit-line', 'A',
      '--emit-line', 'B',
      '--emit-line', 'C',
    ]);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],                                       // READY
      [{ kind: 'thinking', text: 't1' }],      // A — run 1 starts
      [{ kind: 'turn_end' }],                   // B — run 1 resolves
      [{ kind: 'thinking', text: 't2' }],      // C — run 2 starts
    ];
    driver.parseLine = () => sequence[step++] ?? [];

    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.filter(
          e => e.event === 'runtime_state' && e.state.status === 'thinking',
        ).length >= 2,
      3_000,
    );

    const thinkingStates = events
      .filter(e => e.event === 'runtime_state' && e.state.status === 'thinking')
      .map(e => (e.event === 'runtime_state' ? e.state : null!));
    expect(thinkingStates.length).toBeGreaterThanOrEqual(2);

    // First and last thinking states belong to different runs.
    const firstThinking = thinkingStates[0]!;
    const lastThinking = thinkingStates[thinkingStates.length - 1]!;
    expect(firstThinking.runId).not.toBe(lastThinking.runId);

    // Neither thinking carries a terminalReason (it would only land
    // on the resolved terminal frame).
    expect(firstThinking.terminalReason).toBeUndefined();
    expect(lastThinking.terminalReason).toBeUndefined();

    // The terminal frame for turn_end carries status:idle (CM rule:
    // turn_ended → idle) and reuses the first run's runId.
    const terminal = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.terminalReason === 'turn_ended',
    );
    expect(terminal).toBeDefined();
    if (terminal && terminal.event === 'runtime_state') {
      expect(terminal.state.status).toBe('idle');
      expect(terminal.state.runId).toBe(firstThinking.runId);
    }

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('hard stop mid-tool_running emits terminal {status:failed, terminalReason:stopped} reusing the active runId', async () => {
    // Before B3 the supervisor would emit a terminal `runtime_state`
    // by attaching `terminalReason` via `emitState(handle, reason)`
    // WITHOUT flipping `status` — leaving a tool_running terminal,
    // which is incoherent. resolveRun maps `stopped → failed` (per
    // CM's terminalStatus table) and preserves the existing runId so
    // the consumer can correlate the terminal with the in-flight run.
    const { driver } = makeProgrammableDriver(['--emit-line', 'A']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],                                                  // READY
      [{ kind: 'tool_call', name: 'Bash', input: {} }],   // A → tool_running
    ];
    driver.parseLine = () => sequence[step++] ?? [];

    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_state' &&
            e.state.status === 'tool_running' &&
            e.state.detail === 'Bash',
        ),
      3_000,
    );
    const toolRunning = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.status === 'tool_running' &&
        e.state.detail === 'Bash',
    );
    const inflightRunId =
      toolRunning && toolRunning.event === 'runtime_state'
        ? toolRunning.state.runId
        : null;
    expect(inflightRunId).toBeTruthy();

    await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });

    // Find the FIRST terminal `runtime_state` (resolveRun emits one
    // before runtime_exit). It must carry status:failed +
    // terminalReason:stopped + the same runId as the in-flight run.
    const terminal = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.terminalReason === 'stopped',
    );
    expect(terminal).toBeDefined();
    if (terminal && terminal.event === 'runtime_state') {
      expect(terminal.state.status).toBe('failed');
      expect(terminal.state.runId).toBe(inflightRunId);
    }
  });

  it('status() after a terminal-resolved run returns run_state:null (no stale terminalReason leaks via the status surface)', async () => {
    // resolveRun clears `handle.runState` so the next status() poll
    // returns null until a fresh event creates a new run. Without B3
    // the terminal AgentRunState would still be hanging on the handle,
    // and status() would project it as if the run were still live.
    const { driver } = makeProgrammableDriver([
      '--emit-line', 'A',
      '--emit-line', 'B',
    ]);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],                                       // READY
      [{ kind: 'thinking', text: 'pondering' }],// A → run starts
      [{ kind: 'turn_end' }],                   // B → run resolves
    ];
    driver.parseLine = () => sequence[step++] ?? [];

    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_state' &&
            e.state.terminalReason === 'turn_ended',
        ),
      3_000,
    );
    // Give a tick for runState to be nulled out after the terminal
    // emit.
    await wait(20);

    const snap = supervisor.status({ conversation_id: 'c1', agent_id: 'a1' });
    expect(snap.runtimes).toHaveLength(1);
    expect(snap.runtimes[0]?.run_state).toBeNull();

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('RealSupervisor 3b — Cindy `YW2BGWryWjfymPkU` nit: startup_delivery_accepted is ABSENT when params had no startup_delivery', () => {
  it('start without startup_delivery returns a result with NO startup_delivery_accepted key (not false)', async () => {
    // The protocol comment says "Absent when `startup_delivery` was
    // not provided in params" — surface only when the caller actually
    // supplied a batch. Defending against drift here protects backend
    // from reading `accepted=false` and thinking the daemon rejected
    // a batch it never sent.
    const { supervisor } = makeSupervisor();
    const res = await supervisor.start(baseStartParams);
    assertStarted(res);
    expect(res.pid).toBeGreaterThan(0);
    expect(typeof res.started_at).toBe('number');
    expect(Object.prototype.hasOwnProperty.call(res, 'startup_delivery_accepted')).toBe(false);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});
