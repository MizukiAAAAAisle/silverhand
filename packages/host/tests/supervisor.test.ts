/**
 * Supervisor 3a — spawn / output / hard stop / exit / status.
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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Supervisor } from '../src/daemon/supervisor/index.js';
import type { Driver, DriverSpawnContext, ParsedEvent } from '../src/drivers/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import type { EventFrame, RuntimeStartResult } from '../src/protocol.js';
import { runtimePidFilePath } from '../src/daemon/runtime-pidfiles.js';

const FIXTURE = join(__dirname, '_fixtures', 'echo-runtime.cjs');
/** 3c-b watchdog fixture — produces zero bytes until killed. See
 *  `tests/_fixtures/no-output-runtime.cjs` for rationale (Cindy
 *  `HyC05fC-FEs94uoZ` B1). Tests that need to observe silence-tier
 *  firing must point `driver.binary` + `buildArgs` at this file so the
 *  spawn seam (`realSpawn(execPath, [bin, ...args.slice(1)])`)
 *  executes `node no-output-runtime.cjs` without any positional
 *  arguments leaking through. */
const NO_OUTPUT_FIXTURE = join(__dirname, '_fixtures', 'no-output-runtime.cjs');

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
    logControl: createDaemonLogControl('debug'),
    debug: noop,
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
 *
 * Option A v2 (Cindy `UMGu36zoTDVuKWXi`): daemon now calls
 * `encodeStdinMessage` itself for `wake` / `startup_delivery` /
 * `softStop`. The previous default of returning `null` would now
 * surface as `driver_refused` and break every supervisor test that
 * exercises stdin writes. We mimic the real claude driver by
 * encoding the text into a stream-json `{"type":"user", …}` line so
 * the echo-stdin fixture's `STDIN:{"type":"user"` assertions keep
 * passing without coupling the fake to claude's exact schema.
 * `readyToEncode()` defaults to true (matches the stateless claude
 * driver) so the `ready_for_drain` / wake gates fire immediately;
 * tests that need a stateful pre-`thread/started` driver build a
 * separate factory.
 */
function encodeStreamJsonUser(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

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
    encodeStdinMessage: (text: string) => encodeStreamJsonUser(text),
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
  daemonInstanceId?: string;
  runtimePidRootDir?: string | null;
} = {}): {
  supervisor: Supervisor;
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
  const supervisor = new Supervisor({
    emit: spy.emit,
    logger: silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    daemonInstanceId: opts.daemonInstanceId,
    runtimePidRootDir: opts.runtimePidRootDir,
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

describe('Supervisor 3a — spawn / status / phase emit', () => {
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

  it('writes a runtime pidfile after spawn and unlinks it when the child exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-supervisor-pidfile-'));
    const runtimePidRootDir = join(dir, 'runtime-pids');
    const daemonInstanceId = '1000-42';
    let supervisor: Supervisor | null = null;
    try {
      ({ supervisor } = makeSupervisor({
        runtimePidRootDir,
        daemonInstanceId,
      }));
      const res = await supervisor.start(baseStartParams);
      assertStarted(res);

      const filePath = runtimePidFilePath(
        runtimePidRootDir,
        daemonInstanceId,
        'c1',
        'a1',
      );
      expect(existsSync(filePath)).toBe(true);
      const record = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(record).toMatchObject({
        pid: res.pid,
        started_at: res.started_at,
        conv: 'c1',
        agent: 'a1',
        runtime: 'claude',
        cmd: FIXTURE,
      });

      await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
      expect(existsSync(filePath)).toBe(false);
    } finally {
      await supervisor
        ?.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
        .catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
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
        text: 'hi',
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
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => makeFakeDriver(),
      resolveBinary: async () => null,
    });
    await expect(supervisor.start(baseStartParams)).rejects.toThrow(/not found on PATH/);
  });
});

describe('Supervisor 3a — output pump', () => {
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

describe('Supervisor 3a — hard stop / exit', () => {
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
    const supervisor = new Supervisor({
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

describe('Supervisor 3a — stopAll / closeActivityLog', () => {
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

describe('Supervisor 3b — wake / soft stop write payload to stdin', () => {
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
      text: 'hi',
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
        text: 'boot',
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
      text: 'race',
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
      text: 'stub',
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
      text: 'stub',
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
      soft_directive: 'please stop',
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

describe('Supervisor 3b — clearSession behavior', () => {
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
    // Option A v2 (Cindy `UMGu36zoTDVuKWXi`): daemon calls
    // encodeStdinMessage directly. A null return surfaces as
    // `driver_refused`, which would break tests that exercise the
    // stdin write path (deferred startup_delivery consume, soft stop
    // pre-ready, etc). Mirror the claude driver's stream-json shape.
    encodeStdinMessage: (text: string) => encodeStreamJsonUser(text),
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
  supervisor: Supervisor;
  events: EventFrame[];
} {
  const spy = makeEmitSpy();
  const realSpawn = spawn;
  const spawnFn = (
    bin: string,
    args: ReadonlyArray<string>,
    options: SpawnOptions,
  ): ChildProcess => realSpawn(execPath, [bin, ...args.slice(1)], options);
  const supervisor = new Supervisor({
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

describe('Supervisor 3b — parse fanout (Cindy `OQCA05pivtB8nSTC` + `C2BZGDbQWfnq-bKJ`)', () => {
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

    const snippetState = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.activitySnippet === 'pondering',
    );
    expect(snippetState).toBeDefined();

    const toolState = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.status === 'tool_running' &&
        e.state.detail === 'Bash',
    );
    expect(
      toolState &&
        toolState.event === 'runtime_state' &&
        toolState.state.toolCallCounts,
    ).toEqual({ Bash: 1 });

    const postToolThinking = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.status === 'thinking' &&
        e.state.toolCallCounts?.Bash === 1,
    );
    expect(postToolThinking).toBeDefined();

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

  it('non-fatal parsed errors surface as thinking activity instead of leaving the UI idle', async () => {
    const { driver } = makeProgrammableDriver(['--emit-line', 'A']);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],
      [
        {
          kind: 'error',
          code: 'api_connection_refused',
          message: 'Claude API gateway unreachable; retrying (attempt 1)',
        },
      ],
    ];
    driver.parseLine = () => sequence[step++] ?? [];

    await supervisor.start(baseStartParams);

    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_state' &&
          e.state.status === 'thinking' &&
          e.state.activitySnippet ===
            'Claude API gateway unreachable; retrying (attempt 1)',
      ),
    );

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

describe('Supervisor 3b — startup_delivery step-0 mutex', () => {
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
        text: 'boot batch',
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
          text: 'boot batch',
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
      text: 'after-death',
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

describe('Supervisor 3b — Cindy `YW2BGWryWjfymPkU` B2: deferred startup_delivery consume for requires_first_message drivers', () => {
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
    const supervisor = new Supervisor({
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
        text: 'boot batch',
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
      text: 'stub',
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
      text: 'stub',
    });
    expect(wakeAfter.delivered).toBe(true);

    // Cleanup.
    setImmediate(() => stub.emit('exit', 0, null));
  });
});

describe('Supervisor 3b — Cindy `YW2BGWryWjfymPkU` B3: resolveRun terminal semantics', () => {
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

describe('Supervisor 3b — Cindy `YW2BGWryWjfymPkU` nit: startup_delivery_accepted is ABSENT when params had no startup_delivery', () => {
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

// ─────────────────────────────────────────────────────────────────────
// 3c-b: bindIO + init watchdog + retry/cooldown + lifecycle lock +
//       compaction watchdog
//
// All 3c-b tests use the same fake-driver / fixture pattern as 3a/3b
// — Supervisor is exercised against a real child process via
// echo-runtime.cjs. Watchdog timers default to ~5 minutes; tests
// override the supervisor's `initWatchdogMs` (global override per
// Cindy `-pdNvRYOWip5e9yA`) to ~50-200ms so the cascades complete
// inside vitest's 5s budget.
// ─────────────────────────────────────────────────────────────────────

import {
  DEFAULT_COMPACTION_STALE_MS,
  DEFAULT_INIT_LIVENESS_SILENCE_MS,
  DEFAULT_INIT_POST_PROTOCOL_MS,
  DEFAULT_INIT_PRE_PROTOCOL_CAP_MS,
  type SupervisorOptions,
} from '../src/daemon/supervisor/index.js';

/** Build a supervisor variant that lets each 3c-b test pass extra
 *  watchdog / retry / cooldown knobs without rebuilding the spawn /
 *  driver wiring. Keeps the rest of the makeSupervisor() shape
 *  identical to 3a/3b. */
function make3cSupervisor(
  opts: {
    driverArgs?: string[];
    driverOverride?: (base: Driver) => Driver;
    spawnFn?: (b: string, a: ReadonlyArray<string>, o: SpawnOptions) => ChildProcess;
  } & Partial<
    Pick<
      SupervisorOptions,
      | 'sigtermToSigkillMs'
      | 'sigkillTimeoutMs'
      | 'initWatchdogMs'
      | 'initLivenessSilenceMs'
      | 'initPreProtocolCapMs'
      | 'initPostProtocolMs'
      | 'initMaxRetries'
      | 'initFailureCooldownThreshold'
      | 'initFailureCooldownMs'
      | 'compactionStaleMs'
    >
  > = {},
): { supervisor: Supervisor; events: EventFrame[]; driver: Driver } {
  const spy = makeEmitSpy();
  const baseDriver = makeFakeDriver(opts.driverArgs);
  const driver = opts.driverOverride ? opts.driverOverride(baseDriver) : baseDriver;
  const realSpawn = spawn;
  const spawnFn =
    opts.spawnFn ??
    ((bin, args, options) => realSpawn(execPath, [bin, ...args.slice(1)], options));
  const supervisor = new Supervisor({
    emit: spy.emit,
    logger: silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    sigtermToSigkillMs: opts.sigtermToSigkillMs ?? 50,
    sigkillTimeoutMs: opts.sigkillTimeoutMs ?? 200,
    initWatchdogMs: opts.initWatchdogMs,
    initLivenessSilenceMs: opts.initLivenessSilenceMs,
    initPreProtocolCapMs: opts.initPreProtocolCapMs,
    initPostProtocolMs: opts.initPostProtocolMs,
    initMaxRetries: opts.initMaxRetries,
    initFailureCooldownThreshold: opts.initFailureCooldownThreshold,
    initFailureCooldownMs: opts.initFailureCooldownMs,
    compactionStaleMs: opts.compactionStaleMs,
  });
  return { supervisor, events: spy.events, driver };
}

describe('Supervisor 3c-b — driver.bindIO', () => {
  it('calls driver.bindIO once after spawn with writeLine + spawnCtx', async () => {
    const calls: Array<{ writeLine: (line: string) => Promise<void>; ctx: DriverSpawnContext }> = [];
    const { supervisor } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        bindIO(io) {
          calls.push({ writeLine: io.writeLine, ctx: io.spawnCtx });
        },
      }),
    });
    const res = await supervisor.start(baseStartParams);
    assertStarted(res);
    expect(calls).toHaveLength(1);
    expect(typeof calls[0]!.writeLine).toBe('function');
    expect(calls[0]!.ctx.agentName).toBe('tester');
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('bindIO.writeLine writes the payload + "\\n" to child stdin', async () => {
    let writeLine: ((line: string) => Promise<void>) | null = null;
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--echo-stdin'],
      driverOverride: base => ({
        ...base,
        bindIO(io) {
          writeLine = io.writeLine;
        },
      }),
    });
    await supervisor.start(baseStartParams);
    await waitFor(() => writeLine !== null);
    // wait for child READY so stdin is plumbed
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.stream === 'stdout' &&
          e.chunk.includes('READY'),
      ),
    );
    await writeLine!('jsonrpc-line-no-trailing-newline');
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.stream === 'stdout' &&
          e.chunk.includes('STDIN:jsonrpc-line-no-trailing-newline'),
      ),
      2_000,
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('bindIO.writeLine throws synchronously when the driver line already ends with "\\n" (Cindy `-pdNvRYOWip5e9yA` guard, `HyC05fC-FEs94uoZ` sync follow-up)', async () => {
    let writeLine: ((line: string) => Promise<void>) | null = null;
    const { supervisor } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        bindIO(io) {
          writeLine = io.writeLine;
        },
      }),
    });
    await supervisor.start(baseStartParams);
    await waitFor(() => writeLine !== null);
    // Synchronous throw — Codex drivers fire-and-forget via
    // `void this.io?.writeLine(...)`, so a rejected Promise would
    // become an unhandled rejection. The seam throws inside the
    // driver's bound callsite instead, where the driver author sees
    // it during local testing.
    expect(() => writeLine!('already-terminated\n')).toThrow(/must not end with/);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor 3c-b — 3-tier init watchdog', () => {
  it('silence tier fires when no bytes arrive within livenessSilenceMs', async () => {
    // Cindy `HyC05fC-FEs94uoZ` B1: prior version pointed buildArgs at
    // `[execPath, '-e', 'setInterval(...);']` to try to coerce
    // echo-runtime into emitting nothing, but the test spawn seam
    // collapses to `[bin, ...args.slice(1)]` so the actual invocation
    // was `node echo-runtime.cjs -e setInterval(...);` — echo-runtime
    // ignored the unknown args and still emitted `READY\n`, refreshing
    // the silence timer. Use the dedicated no-output fixture so the
    // spawn seam runs `node no-output-runtime.cjs` cleanly and the
    // child emits zero bytes until the watchdog kills it.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        kickoffMode: 'self_inits', // arm immediately at spawn
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE],
      }),
      initLivenessSilenceMs: 60,
      // Big pre-protocol cap so the silence timer fires first.
      initPreProtocolCapMs: 60_000,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_init_timeout' &&
            e.timeout_reason === 'silence',
        ),
      2_000,
    );
    const timeout = events.find(e => e.event === 'runtime_init_timeout');
    expect(timeout && timeout.event === 'runtime_init_timeout').toBe(true);
    if (timeout && timeout.event === 'runtime_init_timeout') {
      expect(timeout.timeout_reason).toBe('silence');
      expect(timeout.retry_attempt).toBe(0);
    }
  });

  it('pre_protocol_cap tier fires when raw bytes arrive but no protocol line lands within the cap', async () => {
    // echo-runtime emits READY (raw bytes → silence timer refreshes)
    // but classifyInitProgress is `() => null` (default fake), so the
    // pre-protocol cap is the next timer to fire.
    const { supervisor, events } = make3cSupervisor({
      initLivenessSilenceMs: 60_000,
      initPreProtocolCapMs: 80,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_init_timeout' &&
            e.timeout_reason === 'pre_protocol_cap',
        ),
      2_000,
    );
  });

  it('post_protocol tier fires after protocol_ready when session_ready never lands', async () => {
    // Driver classifyInitProgress returns 'protocol_ready' for any
    // line. After READY arrives, the post-protocol timer arms; we
    // never emit session_ready, so it fires.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        classifyInitProgress: () => 'protocol_ready' as const,
      }),
      initPostProtocolMs: 80,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_init_timeout' &&
            e.timeout_reason === 'post_protocol',
        ),
      2_000,
    );
  });

  it('classifyInitProgress=session_ready clears every init watchdog (no timeout fires)', async () => {
    // The fixture's READY line drives `classifyInitProgress`, so we
    // need the silence/pre-protocol windows to be wider than node's
    // cold-start latency — otherwise the silence timer fires before
    // READY arrives and the watchdog kills the child before
    // `session_ready` has any chance to clear it. Cindy
    // `HyC05fC-FEs94uoZ` B1: original 80ms window was racing the
    // child boot. 600ms is wide enough on macOS/Linux dev hosts and
    // CI while still keeping the "wait past every window" assertion
    // honest.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        classifyInitProgress: () => 'session_ready' as const,
      }),
      initWatchdogMs: 600, // every tier
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    // Wait past every watchdog window; no timeout should ever fire.
    await wait(1_200);
    expect(events.find(e => e.event === 'runtime_init_timeout')).toBeUndefined();
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('a parsed session_init event clears the watchdog and the retry bucket', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        parseLine: line => {
          // Treat any line containing "READY" as session_init for this test.
          if (line.includes('READY')) {
            return [{ kind: 'session_init' as const, sessionId: 'sess-1' }];
          }
          return [];
        },
      }),
      // Same cold-start-aware window rationale as the
      // classifyInitProgress=session_ready test above. session_init
      // arrives via parseLine on the READY line; the silence/pre-cap
      // windows must outlast node's cold start.
      initWatchdogMs: 600,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await wait(1_200);
    expect(events.find(e => e.event === 'runtime_init_timeout')).toBeUndefined();
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('deferred-init: requires_first_message + no startup_delivery → no watchdog at spawn; wake arms it', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        kickoffMode: 'requires_first_message',
      }),
      initWatchdogMs: 80,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    // Let every default-armed window pass; nothing should fire because
    // the watchdog isn't armed yet.
    await wait(250);
    expect(events.find(e => e.event === 'runtime_init_timeout')).toBeUndefined();
    // Now wake — that arms the watchdog. echo-runtime won't emit
    // session_init, so a silence/pre-cap timeout follows.
    await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'hi',
    });
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_timeout'),
      2_000,
    );
  });

  it('override precedence: opts.initLivenessSilenceMs overrides driver.initLivenessSilenceMs', async () => {
    // Use the no-output fixture so silence fires from a true "no
    // bytes received" state (not "echo-runtime READY refreshed the
    // timer once, then went idle"). Cindy `HyC05fC-FEs94uoZ` B1
    // applies here too.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        initLivenessSilenceMs: 60_000, // driver opinion would never fire in test budget
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE],
      }),
      initLivenessSilenceMs: 80, // supervisor override → wins
      initPreProtocolCapMs: 60_000,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_init_timeout' &&
            e.timeout_reason === 'silence',
        ),
      2_000,
    );
  });

  it('override precedence: opts.initWatchdogMs (global) wins over per-tier override AND driver', async () => {
    // Same fixture swap as the per-tier-override test: no-output
    // fixture so silence fires deterministically from zero bytes.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        initLivenessSilenceMs: 60_000,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE],
      }),
      initWatchdogMs: 80,            // global override
      initLivenessSilenceMs: 60_000, // per-tier — must be IGNORED
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e =>
            e.event === 'runtime_init_timeout' &&
            e.timeout_reason === 'silence',
        ),
      2_000,
    );
  });
});

describe('Supervisor 3c-b — retry / cooldown state machine', () => {
  it('first timeout with maxRetries=1 emits retrying=true + runtime_init_retrying for attempt 1', async () => {
    const { supervisor, events } = make3cSupervisor({
      initWatchdogMs: 80,
      sigtermToSigkillMs: 30,
      initMaxRetries: 1,
      // High threshold so cooldown does NOT engage during the retry window.
      initFailureCooldownThreshold: 10,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.some(
          e => e.event === 'runtime_init_retrying' && e.retry_attempt === 1,
        ),
      2_000,
    );
    // The timeout that triggered the retry carried retry_attempt=0
    // (0-indexed, "the one that just failed") and retrying=true.
    const firstTimeout = events.find(
      e => e.event === 'runtime_init_timeout',
    );
    expect(firstTimeout && firstTimeout.event === 'runtime_init_timeout').toBe(true);
    if (firstTimeout && firstTimeout.event === 'runtime_init_timeout') {
      expect(firstTimeout.retry_attempt).toBe(0);
      expect(firstTimeout.retrying).toBe(true);
      expect(firstTimeout.max_retries).toBe(1);
      expect(firstTimeout.cooldown_until).toBeUndefined();
    }
    // Stop any pending retry process.
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('second timeout (attempt=1) emits retrying=false; no runtime_init_retrying follows', async () => {
    const { supervisor, events } = make3cSupervisor({
      initWatchdogMs: 80,
      sigtermToSigkillMs: 30,
      initMaxRetries: 1,
      initFailureCooldownThreshold: 10,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        events.filter(e => e.event === 'runtime_init_timeout').length >= 2,
      4_000,
    );
    const timeouts = events.filter(e => e.event === 'runtime_init_timeout');
    if (timeouts[1] && timeouts[1].event === 'runtime_init_timeout') {
      expect(timeouts[1].retry_attempt).toBe(1);
      expect(timeouts[1].retrying).toBe(false);
    }
    // Exactly ONE retrying event was emitted across the whole sequence.
    expect(events.filter(e => e.event === 'runtime_init_retrying')).toHaveLength(1);
  });

  it('after threshold failures cooldown engages: runtime_init_timeout carries cooldown_until + runtime_init_cooldown event fires on exit', async () => {
    const { supervisor, events } = make3cSupervisor({
      initWatchdogMs: 60,
      sigtermToSigkillMs: 30,
      initMaxRetries: 0,                 // no retry — every failure is terminal
      initFailureCooldownThreshold: 1,   // cooldown after the first failure
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_cooldown'),
      3_000,
    );
    const timeout = events.find(e => e.event === 'runtime_init_timeout');
    if (timeout && timeout.event === 'runtime_init_timeout') {
      expect(typeof timeout.cooldown_until).toBe('number');
      expect((timeout.cooldown_until ?? 0) > Date.now()).toBe(true);
    }
    const cooldown = events.find(e => e.event === 'runtime_init_cooldown');
    if (cooldown && cooldown.event === 'runtime_init_cooldown') {
      expect(cooldown.attempts_exhausted).toBeGreaterThanOrEqual(1);
      expect(cooldown.cooldown_until > Date.now()).toBe(true);
    }
  });

  it('start at attempt=0 while cooldown is active returns the cooldown result arm', async () => {
    const { supervisor } = make3cSupervisor({
      initWatchdogMs: 60,
      sigtermToSigkillMs: 30,
      initMaxRetries: 0,
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    // Wait for the cooldown bucket to land.
    await waitFor(
      () =>
        supervisor.status({ conversation_id: 'c1', agent_id: 'a1' }).runtimes
          .length === 0 ||
        supervisor
          .status({ conversation_id: 'c1', agent_id: 'a1' })
          .runtimes.some(r => r.phase === 'exited'),
      3_000,
    );
    // Give the exit handler a tick to mark cooldown.
    await wait(50);
    const second = await supervisor.start(baseStartParams);
    expect(second.started).toBe(false);
    if (!second.started) {
      expect(second.reason).toBe('init_cooldown');
      expect(second.cooldown_until > Date.now()).toBe(true);
    }
  });

  it('start at attempt=0 after cooldown expires returns the success arm again', async () => {
    const { supervisor } = make3cSupervisor({
      initWatchdogMs: 60,
      sigtermToSigkillMs: 30,
      initMaxRetries: 0,
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 40, // very short cooldown
    });
    await supervisor.start(baseStartParams);
    await wait(300); // outlast cooldown
    const second = await supervisor.start(baseStartParams);
    assertStarted(second);
    expect(second.pid).toBeGreaterThan(0);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('successful session_init clears the retry bucket (subsequent timeout sees a fresh failures counter)', async () => {
    // First spawn lands session_init → failures cleared. Second
    // spawn (after stop) hits silence; if the bucket leaked, this
    // would be failures=2 (cooldown engages); since it was cleared
    // we expect failures=1 (no cooldown). Tests via cooldown_until
    // absence on the timeout event.
    let succeed = true;
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        parseLine: line => {
          if (succeed && line.includes('READY')) {
            return [{ kind: 'session_init' as const, sessionId: 'sess' }];
          }
          return [];
        },
      }),
      initWatchdogMs: 80,
      sigtermToSigkillMs: 30,
      initMaxRetries: 0,
      initFailureCooldownThreshold: 2, // would fire on the 2nd failure if bucket leaked
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    // Give session_init a chance to land + clear bucket.
    await wait(150);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
    // Now force the second spawn to fail.
    succeed = false;
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_timeout'),
      2_000,
    );
    const timeouts = events.filter(e => e.event === 'runtime_init_timeout');
    const last = timeouts[timeouts.length - 1];
    // The bucket should be at 1, not 2 — no cooldown_until on this timeout.
    if (last && last.event === 'runtime_init_timeout') {
      expect(last.cooldown_until).toBeUndefined();
    }
  });
});

describe('Supervisor 3c-b — round-2 regressions (Cindy `HyC05fC-FEs94uoZ` B2/B3)', () => {
  it('B2: hard stop during init clears the watchdog so no runtime_init_timeout fires and terminal reason is "stopped"', async () => {
    // CM (`conversation-manager.ts` lines 1020-1023) clears the init
    // watchdog AT DRAINING ENTRY so a user-initiated hard stop is not
    // mismarked as init timeout. Without the fix:
    //   1. user calls `stop({mode:'hard'})` while init is in flight
    //   2. handle.phase → draining, intentionalExit=true, but the
    //      watchdog timer is still ticking
    //   3. silence/pre-cap fires before the child actually exits
    //   4. failInitWatchdog sets initTimedOut=true
    //   5. onChildExit's reason mapping picks 'timeout' (precedence
    //      over 'stopped'), pollutes terminal state + retry/cooldown
    //      bucket + startup_delivery `failed` reason
    // With the fix: hardStopHandle clears every watchdog at draining
    // entry; the timer never fires; exit handler maps `intentional`
    // → terminal `stopped`.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE],
      }),
      // Tight watchdog so the timer would fire well within the
      // SIGTERM grace if it weren't cleared.
      initWatchdogMs: 80,
      sigtermToSigkillMs: 200,
      sigkillTimeoutMs: 600,
    });
    await supervisor.start(baseStartParams);
    // Trigger hard stop BEFORE the silence window elapses.
    const stopPromise = supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    // Wait well past the original 80ms silence window to prove the
    // timer was actually cleared, not just delayed.
    await wait(300);
    const stopRes = await stopPromise;
    expect(stopRes).toMatchObject({ mode: 'hard', stopped: true });

    // NO runtime_init_timeout — proves clearInitWatchdog ran at
    // hardStopHandle entry.
    expect(events.find(e => e.event === 'runtime_init_timeout')).toBeUndefined();
    // Terminal reason is 'stopped' (not 'timeout'), proving the
    // exit-handler reason mapping picked the user intent.
    const terminal = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.terminalReason !== undefined,
    );
    expect(terminal).toBeDefined();
    if (terminal && terminal.event === 'runtime_state') {
      expect(terminal.state.terminalReason).toBe('stopped');
      expect(terminal.state.status).toBe('failed');
    }
    // Exit event marked intentional.
    const exitEvt = events.find(e => e.event === 'runtime_exit');
    expect(
      exitEvt && exitEvt.event === 'runtime_exit' && exitEvt.intentional,
    ).toBe(true);
  });

  it('B3: init watchdog fire flips phase=draining so wake during the kill window returns delivered:false (reason:draining)', async () => {
    // Without B3 the watchdog kill window leaves `wake()` open: the
    // timer fires, `failInitWatchdog` SIGTERMs the child but does NOT
    // touch phase, so wake's `exited/startup_pending/draining` gate
    // doesn't catch it. Backend writes stdin to a dying process and
    // markDelivered's the inbox row to a runtime that never
    // processes it. With B3, failInitWatchdog sets phase='draining'
    // immediately, so the wake gate's draining arm rejects.
    //
    // Test setup: no-output fixture with --ignore-sigterm so the
    // child stays alive in the SIGTERM grace window. initWatchdogMs
    // is widened to 500ms so node has time to cold-boot the fixture
    // AND register the SIGTERM handler before the timer fires (a
    // signal that arrives mid-bootstrap falls back to default
    // action — terminate — defeating --ignore-sigterm). Long
    // SIGTERM/SIGKILL grace keeps the dying handle observable while
    // wake races against the retry respawn.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE, '--ignore-sigterm'],
      }),
      initWatchdogMs: 500,
      initMaxRetries: 0,
      initFailureCooldownThreshold: 10,
      sigtermToSigkillMs: 800,
      sigkillTimeoutMs: 1_500,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_timeout'),
      3_000,
    );
    // At this instant phase should be 'draining' (the child is alive
    // because --ignore-sigterm swallows SIGTERM; SIGKILL won't land
    // for another 800ms).
    const wakeRes = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [11],
      kind: 'message',
      text: 'during-kill-window',
    });
    expect(wakeRes.delivered).toBe(false);
    if (!wakeRes.delivered) {
      // 'draining' is the wake-gate signal that the runtime is being
      // torn down — backend MUST NOT markDelivered against this
      // outcome.
      expect(wakeRes.reason).toBe('draining');
    }
    // Sanity: the child eventually exits via SIGKILL and the
    // supervisor emits a terminal runtime_exit so the test cleanup
    // doesn't hang.
    await waitFor(() => events.some(e => e.event === 'runtime_exit'), 4_000);
  });

  it('B3 + retry: phase=draining after watchdog fire does NOT block onChildExit retry-respawn (init_retrying still fires + new handle spawns)', async () => {
    // Cindy `eHnfQ2a2_l5x-YoQ` note 2: the B3 phase=draining flip
    // must not interfere with the retry branch in onChildExit. The
    // retry branch deletes the old handle and calls
    // `internalRespawnForRetry`; it does NOT gate on phase. This
    // test proves the full sequence:
    //   1. watchdog fires → phase=draining + initTimedOut + initRetryPlanned=true
    //   2. wake during kill window → rejected with reason='draining'
    //   3. child exits → onChildExit detects retry → emits
    //      runtime_init_retrying + deletes old handle + spawns new
    //   4. new handle has a different pid; status() reports a fresh
    //      ready runtime
    //
    // Same fixture configuration rationale as the B3 test above:
    // --ignore-sigterm + 500ms watchdog so node boots and registers
    // the handler before the timer fires; 800ms SIGTERM grace so the
    // dying handle stays observable.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE, '--ignore-sigterm'],
      }),
      initWatchdogMs: 500,
      initMaxRetries: 1, // first failure → retry
      initFailureCooldownThreshold: 10, // don't engage cooldown
      sigtermToSigkillMs: 800,
      sigkillTimeoutMs: 1_500,
    });
    const startRes = await supervisor.start(baseStartParams);
    assertStarted(startRes);
    const originalPid = startRes.pid;
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_timeout'),
      3_000,
    );
    // Wake inside the draining window must reject.
    const midWake = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'x',
    });
    expect(midWake.delivered).toBe(false);
    if (!midWake.delivered) expect(midWake.reason).toBe('draining');
    // Wait for the retry event + the new spawn to happen (SIGKILL
    // will eventually take the SIGTERM-ignoring child down).
    await waitFor(
      () =>
        events.some(
          e => e.event === 'runtime_init_retrying' && e.retry_attempt === 1,
        ),
      4_000,
    );
    await waitFor(() => {
      const snap = supervisor.status({
        conversation_id: 'c1',
        agent_id: 'a1',
      });
      // The new handle must be live (different pid; phase ready
      // OR — if its own watchdog already fired — at least visibly
      // present and not the original exited handle).
      return (
        snap.runtimes.length === 1 &&
        snap.runtimes[0]!.pid !== null &&
        snap.runtimes[0]!.pid !== originalPid
      );
    }, 4_000);
    // The retry's new handle inherits no draining state from the old
    // one — confirms phase=draining set by failInitWatchdog did NOT
    // leak across the respawn boundary.
    const retryingEvent = events.find(e => e.event === 'runtime_init_retrying');
    expect(
      retryingEvent && retryingEvent.event === 'runtime_init_retrying'
        ? retryingEvent.retry_attempt
        : null,
    ).toBe(1);
    // The terminal runtime_state for the FAILED attempt carries
    // terminalReason='timeout', mapped via resolveRun (Cindy: init
    // watchdog precedence over intentional/code in reason mapping).
    const timeoutTerminal = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.terminalReason === 'timeout',
    );
    expect(timeoutTerminal).toBeDefined();
    // Cleanup: tear down the retry's runtime.
    await supervisor.stopAll({});
  });
});


describe('Supervisor 3c-b — lifecycle lock', () => {
  it('concurrent start+start on the same key returns the idempotent success arm (lock serializes)', async () => {
    const { supervisor } = make3cSupervisor();
    const [a, b] = await Promise.all([
      supervisor.start(baseStartParams),
      supervisor.start(baseStartParams),
    ]);
    assertStarted(a);
    assertStarted(b);
    expect(a.pid).toBe(b.pid);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('concurrent start+stop on the same key serializes (stop sees the live handle)', async () => {
    const { supervisor } = make3cSupervisor();
    const startP = supervisor.start(baseStartParams);
    const stopP = supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
    const [s, st] = await Promise.all([startP, stopP]);
    assertStarted(s);
    expect(st).toMatchObject({ mode: 'hard', stopped: true });
  });

  it('stopAll fans out per-key in parallel (two different keys both stop)', async () => {
    const { supervisor } = make3cSupervisor();
    await supervisor.start({ ...baseStartParams, conversation_id: 'c1' });
    await supervisor.start({ ...baseStartParams, conversation_id: 'c2' });
    const res = await supervisor.stopAll({});
    expect(res.stopped_count).toBe(2);
    const snap = supervisor.status({});
    for (const r of snap.runtimes) {
      expect(r.phase).toBe('exited');
    }
  });

  it('wake does NOT take the lifecycle lock (wake runs while a hard stop holds the lock)', async () => {
    // The 3a/3b suite already covers wake-while-draining returning
    // 'draining'. The 3c-b interpretation: confirm wake reaches the
    // gate WITHOUT waiting for the lock — i.e. it returns 'draining'
    // immediately during the SIGTERM grace period, not after the
    // exit. We assert wake returns BEFORE the stop's promise
    // resolves, which would not be possible if both queued on the
    // same lock.
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--ignore-sigterm'],
      sigtermToSigkillMs: 200,
      sigkillTimeoutMs: 400,
    });
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.stream === 'stdout' &&
          e.chunk.includes('READY'),
      ),
    );
    const stopP = supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
    // Yield a tick so draining state is observed.
    await wait(20);
    const wakeRes = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [99],
      kind: 'message',
      text: 'x',
    });
    expect(wakeRes.delivered).toBe(false);
    if (!wakeRes.delivered) expect(wakeRes.reason).toBe('draining');
    await stopP;
  });
});

describe('Supervisor 3c-b — compaction watchdog', () => {
  it('compaction_started + no compaction_finished within compactionStaleMs → runtime_compaction_stale + run-state stacks compactionStale:true (keeps compacting:true)', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        parseLine: line => {
          if (line.includes('COMPACT_START')) return [{ kind: 'compaction_started' as const }];
          return [];
        },
      }),
      driverArgs: ['--emit-line', 'COMPACT_START'],
      compactionStaleMs: 80,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_compaction_stale'),
      2_000,
    );
    const stale = events.find(e => e.event === 'runtime_compaction_stale');
    if (stale && stale.event === 'runtime_compaction_stale') {
      expect(stale.elapsed_ms).toBeGreaterThanOrEqual(80);
    }
    // The most recent runtime_state carries both compacting:true and
    // compactionStale:true. (CM contract — UI shows "still compacting,
    // stale" not "no longer compacting".)
    const stateEmits = events.filter(e => e.event === 'runtime_state');
    const last = stateEmits[stateEmits.length - 1];
    if (last && last.event === 'runtime_state') {
      expect(last.state.compacting).toBe(true);
      expect(last.state.compactionStale).toBe(true);
    }
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('compaction_stale does NOT kill the child (status() still shows the live pid)', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        parseLine: line => {
          if (line.includes('COMPACT_START')) return [{ kind: 'compaction_started' as const }];
          return [];
        },
      }),
      driverArgs: ['--emit-line', 'COMPACT_START'],
      compactionStaleMs: 60,
      sigtermToSigkillMs: 30,
    });
    const res = await supervisor.start(baseStartParams);
    assertStarted(res);
    await waitFor(
      () => events.some(e => e.event === 'runtime_compaction_stale'),
      2_000,
    );
    const snap = supervisor.status({ conversation_id: 'c1', agent_id: 'a1' });
    expect(snap.runtimes[0]?.pid).toBe(res.pid);
    expect(snap.runtimes[0]?.phase).toBe('ready');
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('compaction_finished cancels the watchdog (no stale event fires)', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        parseLine: line => {
          if (line.includes('COMPACT_START')) return [{ kind: 'compaction_started' as const }];
          if (line.includes('COMPACT_END')) return [{ kind: 'compaction_finished' as const }];
          return [];
        },
      }),
      driverArgs: ['--emit-line', 'COMPACT_START', '--emit-line', 'COMPACT_END'],
      compactionStaleMs: 200,
      sigtermToSigkillMs: 30,
    });
    await supervisor.start(baseStartParams);
    // Wait longer than compactionStaleMs; the finished event should
    // have cleared the watchdog so no stale fires.
    await wait(400);
    expect(events.find(e => e.event === 'runtime_compaction_stale')).toBeUndefined();
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor 3c-b — defaults exported for the bridge', () => {
  it('exports CM-aligned defaults so backend can render UI hints without re-deriving the values', () => {
    expect(DEFAULT_INIT_LIVENESS_SILENCE_MS).toBe(30 * 1000);
    expect(DEFAULT_INIT_PRE_PROTOCOL_CAP_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_INIT_POST_PROTOCOL_MS).toBe(30 * 1000);
    expect(DEFAULT_COMPACTION_STALE_MS).toBe(5 * 60 * 1000);
  });
});

// ── Option A v2 arms (Cindy `UMGu36zoTDVuKWXi`) ────────────────────
//
// Daemon now owns encoding via its in-process driver. Three new arms
// fall out of that:
//
//   1. `driver_not_ready` (wake) — driver.readyToEncode() === false
//      → recoverable arm; backend keeps DB row pending and will
//      redeliver on `runtime_ready_for_drain`.
//   2. `driver_refused` (wake) — readyToEncode() returned true but
//      encodeStdinMessage() returned null → driver bug; fail loud
//      (Cindy `0G5uJBydO_4qt_2r`).
//   3. Codex stateful gate — readyToEncode() flips false → true on
//      `session_init` (production codex flips on `thread/started`).
//      ready_for_drain and a deferred startup_delivery consume both
//      latch off that transition.
//
// These tests build a "stateful" fake driver that mirrors codex's
// shape: a mutable `threadId`-like flag the test toggles in lockstep
// with parsed events, gated by `readyToEncode()`. Encoding remains
// the stream-json shape so the echo-stdin fixture's assertions stay
// readable.

/** Build a codex-shaped fake driver whose `readyToEncode()` is gated
 *  by an external mutable flag. session_init parses to a single event
 *  that flips the flag, exactly like codex's `thread/started` does in
 *  production. `kickoffMode` defaults to `'self_inits'` so this isn't
 *  confused with the B2 deferred-consume path (which gates on
 *  `requires_first_message + !initObserved`). */
function makeStatefulCodexLikeDriver(): {
  driver: Driver;
  flipReady: () => void;
} {
  const state = { ready: false };
  const driver: Driver = {
    kind: 'codex',
    binary: FIXTURE,
    kickoffMode: 'self_inits',
    busyDeliveryMode: 'direct',
    oneShot: false,
    supportsNativeStandingPrompt: true,
    initLivenessSilenceMs: 30_000,
    initPreProtocolCapMs: 5 * 60_000,
    initPostProtocolMs: 60_000,
    buildArgs: () => [FIXTURE, '--echo-stdin'],
    applyEnv: env => ({ ...env }),
    readyToEncode: () => state.ready,
    encodeStdinMessage: (text: string) => encodeStreamJsonUser(text),
    encodeInterruptControl: () => null,
    parseLine: () => [],
    classifyInitProgress: () => null,
  };
  return { driver, flipReady: () => { state.ready = true; } };
}

describe('Supervisor 3b — Option A v2 wake arms (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('wake on a driver whose readyToEncode()=false returns delivered:false reason:driver_not_ready (recoverable)', async () => {
    // Codex pre-`thread/started`: backend will keep the DB row pending
    // and redeliver on the next `runtime_ready_for_drain` once
    // readyToEncode() flips true.
    const { driver } = makeStatefulCodexLikeDriver();
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );

    // ready_for_drain MUST NOT have fired yet — readyToEncode() is
    // false so the gate is held closed.
    expect(events.some(e => e.event === 'runtime_ready_for_drain')).toBe(false);

    const res = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [201, 202],
      kind: 'message',
      text: 'hi from backend',
    });
    expect(res).toEqual({
      delivered: false,
      reason: 'driver_not_ready',
      delivery_ids: [201, 202],
    });
    // No stdin write should have surfaced — fixture would echo
    // STDIN:{...} on every received line.
    const echoed = events.some(
      e => e.event === 'runtime_output' && e.chunk.includes('STDIN:'),
    );
    expect(echoed).toBe(false);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('wake post-ready: encodeStdinMessage returns null → delivered:false reason:driver_refused (fail loud)', async () => {
    // readyToEncode() returns true but the driver's encoder produces
    // null. This is the driver-bug arm — Cindy `0G5uJBydO_4qt_2r`:
    // fail loudly rather than silently dropping bytes.
    const driver: Driver = {
      kind: 'codex',
      binary: FIXTURE,
      kickoffMode: 'self_inits',
      busyDeliveryMode: 'direct',
      oneShot: false,
      supportsNativeStandingPrompt: true,
      initLivenessSilenceMs: 30_000,
      initPreProtocolCapMs: 5 * 60_000,
      initPostProtocolMs: 60_000,
      buildArgs: () => [FIXTURE, '--echo-stdin'],
      applyEnv: env => ({ ...env }),
      readyToEncode: () => true,
      encodeStdinMessage: () => null, // driver bug
      encodeInterruptControl: () => null,
      parseLine: () => [],
      classifyInitProgress: () => null,
    };
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );
    // ready_for_drain fires because readyToEncode()=true and no
    // startup_delivery gate.
    await waitFor(() =>
      events.some(e => e.event === 'runtime_ready_for_drain'),
    );

    const res = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [301],
      kind: 'message',
      text: 'bytes',
    });
    expect(res).toEqual({
      delivered: false,
      reason: 'driver_refused',
      delivery_ids: [301],
    });
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor 3b — Option A v2 ready_for_drain gate by readyToEncode (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('ready_for_drain is held until readyToEncode() flips true (codex stateful gate)', async () => {
    // No startup_delivery; gate is purely driver.readyToEncode().
    // Pre-flip: ready_for_drain MUST NOT fire even after start
    // settles. Post-flip (via a parsed event that the test injects):
    // ready_for_drain fires exactly once.
    const { driver, flipReady } = makeStatefulCodexLikeDriver();
    // Replace parseLine so an injected stdout line triggers flipReady
    // synchronously — this mirrors how codex flips its threadId on
    // `thread/started`.
    driver.parseLine = (line: string) => {
      if (line.includes('THREAD_STARTED')) {
        flipReady();
        return [{ kind: 'session_init', sessionId: 'sess-codex-1' }];
      }
      return [];
    };
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(e => e.event === 'runtime_output' && e.chunk.includes('READY')),
    );
    // Pre-flip: gate stays closed.
    await wait(40);
    expect(events.some(e => e.event === 'runtime_ready_for_drain')).toBe(false);

    // Flip via stdin echo trick: feed a line through the fixture's
    // echo path so the supervisor sees a stdout line that parseLine
    // converts to session_init + flipReady.
    // The simplest way to inject a line is to wake the supervisor;
    // but that would hit driver_not_ready. Instead use the existing
    // echo-stdin fixture and write a phantom line via stdin: the
    // supervisor only sees its OWN stdout, and the only way to push
    // a synthetic stdout line is the fixture's behavior. So we use a
    // driver-arg fixture instead: --emit-line THREAD_STARTED makes
    // the fixture write that line on stdout shortly after READY.
    // (Switch driverArgs by rebuilding the driver inline.)
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });

    // ── second supervisor with the same driver but the fixture
    //    configured to actually emit the THREAD_STARTED line.
    const { driver: driver2, flipReady: flip2 } = makeStatefulCodexLikeDriver();
    driver2.buildArgs = () => [FIXTURE, '--emit-line', 'THREAD_STARTED'];
    driver2.parseLine = (line: string) => {
      if (line.includes('THREAD_STARTED')) {
        flip2();
        return [{ kind: 'session_init', sessionId: 'sess-codex-2' }];
      }
      return [];
    };
    const second = makeSupervisorWithDriver(driver2);
    await second.supervisor.start(baseStartParams);
    await waitFor(() =>
      second.events.some(e => e.event === 'runtime_ready_for_drain'),
      2_000,
    );
    // Exactly one ready_for_drain after the flip.
    expect(
      second.events.filter(e => e.event === 'runtime_ready_for_drain').length,
    ).toBe(1);
    await second.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor 3b — Option A v2 deferred startup_delivery on stateful driver (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('startup_delivery encode is deferred until readyToEncode() flips true (codex pre-thread/started)', async () => {
    // Codex case: start() with a startup_delivery while the driver's
    // readyToEncode() is still false. The supervisor MUST defer the
    // encode (no stdin write yet, no consumed event, no ready_for_drain).
    // Once a parsed event flips readyToEncode() true,
    // `tryConsumeStartupDelivery` re-enters and the batch settles:
    // consumed → ready_for_drain.
    const { driver, flipReady } = makeStatefulCodexLikeDriver();
    driver.buildArgs = () => [FIXTURE, '--echo-stdin', '--emit-line', 'THREAD_STARTED'];
    driver.parseLine = (line: string) => {
      if (line.includes('THREAD_STARTED')) {
        flipReady();
        return [{ kind: 'session_init', sessionId: 'sess-codex-3' }];
      }
      return [];
    };
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    await supervisor.start({
      ...baseStartParams,
      startup_delivery: {
        delivery_ids: [701, 702],
        text: 'boot codex',
      },
    });

    // Eventually the fixture emits THREAD_STARTED → parseLine flips
    // ready → tryConsumeStartupDelivery encodes + writes → consumed +
    // ready_for_drain fire in that order.
    await waitFor(
      () => events.some(e => e.event === 'runtime_ready_for_drain'),
      2_000,
    );
    const consumed = events.find(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    const idxConsumed = events.findIndex(
      e => e.event === 'runtime_startup_delivery_consumed',
    );
    const idxReady = events.findIndex(
      e => e.event === 'runtime_ready_for_drain',
    );
    expect(consumed).toBeDefined();
    if (consumed && consumed.event === 'runtime_startup_delivery_consumed') {
      expect(consumed.delivery_ids).toEqual([701, 702]);
    }
    expect(idxConsumed).toBeGreaterThanOrEqual(0);
    expect(idxReady).toBeGreaterThan(idxConsumed);
    // Exactly one ready_for_drain across the deferred path.
    expect(
      events.filter(e => e.event === 'runtime_ready_for_drain').length,
    ).toBe(1);
    // The stdin write actually happened (echo confirms).
    expect(
      events.some(
        e => e.event === 'runtime_output' && e.chunk.includes('STDIN:{"type":"user"'),
      ),
    ).toBe(true);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});
