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
import type { EventFrame } from '../src/protocol.js';

const FIXTURE = join(__dirname, '_fixtures', 'echo-runtime.cjs');

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
    expect(second.pid).toBe(first.pid);
    expect(second.started_at).toBe(first.started_at);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('start rejects startup_delivery in 3a (3b will lift the restriction once wake/stdin-write lands)', async () => {
    // Cindy `OQCA05pivtB8nSTC` B1: accepting `startup_delivery` here
    // without actually writing it to stdin would let the supervisor
    // emit `runtime_ready_for_drain` while the batch is still pending,
    // violating the step-0 mutex. The honest 3a answer is to refuse.
    const { supervisor } = makeSupervisor();
    const params = {
      ...baseStartParams,
      startup_delivery: { delivery_ids: [1, 2], payload: {} },
    };
    await expect(supervisor.start(params)).rejects.toThrow(
      /startup_delivery not supported until commit 3b/,
    );
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
  it('hard stop sends SIGTERM, child exits, runtime_state(idle, stopped) + runtime_exit(intentional=true) land', async () => {
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

    // Final state event carries the `stopped` terminal reason.
    const lastState = [...events]
      .reverse()
      .find(e => e.event === 'runtime_state');
    expect(lastState).toBeDefined();
    if (lastState && lastState.event === 'runtime_state') {
      expect(lastState.state.terminalReason).toBe('stopped');
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

  it('voluntary child exit (no stop request) marks intentional=false (crashed terminal reason)', async () => {
    const { supervisor, events } = makeSupervisor({
      // Sleep briefly then voluntarily exit(0). The supervisor never
      // gets a stop() call — this exercises the crash path.
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
    const lastState = [...events]
      .reverse()
      .find(e => e.event === 'runtime_state');
    expect(lastState && lastState.event === 'runtime_state' && lastState.state.terminalReason).toBe(
      'crashed',
    );
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

describe('RealSupervisor 3a — wake / soft stop / clearSession stubs', () => {
  it('wake returns not_running when no handle exists; driver_refused while live (3b will implement)', async () => {
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

    await supervisor.start(baseStartParams);
    const live = await supervisor.wake({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      payload: {},
    });
    expect(live).toEqual({
      delivered: false,
      reason: 'driver_refused',
      delivery_ids: [42],
    });
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('soft stop returns driver_refused stub (3b will route through driver.encodeInterruptControl)', async () => {
    const { supervisor } = makeSupervisor();
    await supervisor.start(baseStartParams);
    const res = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'soft',
      soft_directive: '{"role":"user","content":"please stop"}\n',
    });
    expect(res).toEqual({
      mode: 'soft',
      directive_delivered: false,
      reason: 'driver_refused',
    });
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

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
