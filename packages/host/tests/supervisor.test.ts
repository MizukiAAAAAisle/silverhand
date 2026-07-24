/**
 * Supervisor 3a — spawn / output / hard stop / exit / status.
 *
 * Scope locked with Cindy in `jhH-vC1s_1J_jTLu`: this suite covers
 * execution-plane behavior only. Parse / deliver / watchdog
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
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { execPath } from 'node:process';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import { Supervisor } from '../src/daemon/supervisor/index.js';
import { CodexDriver } from '../src/drivers/codex.js';
import type { Driver, DriverSpawnContext, ParsedEvent } from '../src/drivers/index.js';
import { createDaemonLogControl, type DaemonLogger } from '../src/daemon/logger.js';
import type { EventFrame, RuntimeStartResult } from '../src/protocol.js';
import { runtimePidFilePath } from '../src/daemon/runtime-pidfiles.js';
import {
  testStartOptions,
  testRuntimeStartResolveDeps,
} from './_helpers/runtime-start-options.js';
import { RuntimeStartResolveError } from '../src/daemon/runtime-start-resolve.js';

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
 * `encodeStdinMessage` itself for `deliver` (spawn + write arms).
 * The previous default of returning `null` would now
 * surface as `driver_refused` and break every supervisor test that
 * exercises stdin writes. We mimic the real claude driver by
 * encoding the text into a stream-json `{"type":"user", …}` line so
 * the echo-stdin fixture's `STDIN:{"type":"user"` assertions keep
 * passing without coupling the fake to claude's exact schema.
 * `readyToEncode()` defaults to true (matches the stateless claude
 * driver) so the `ready_for_drain` / deliver gates fire immediately;
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
    releaseProfile: 'native-steer',
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
  runtimeStartResolveDeps?: ReturnType<typeof testRuntimeStartResolveDeps>;
  emitRawRuntimeOutput?: boolean;
  logger?: DaemonLogger;
  /** Observe the DriverSpawnContext the supervisor hands to buildArgs. */
  onSpawnCtx?: (ctx: DriverSpawnContext) => void;
} = {}): {
  supervisor: Supervisor;
  events: EventFrame[];
} {
  const spy = makeEmitSpy();
  const baseDriver = makeFakeDriver(opts.driverArgs);
  const driver: Driver = opts.onSpawnCtx
    ? {
        ...baseDriver,
        buildArgs: ctx => {
          opts.onSpawnCtx!(ctx);
          return baseDriver.buildArgs(ctx);
        },
      }
    : baseDriver;
  // Node fixture is a .cjs file; invoke via the same node binary the
  // test runner uses so we don't depend on the fixture being chmod +x.
  const realSpawn = spawn;
  const spawnFn =
    opts.spawnFn ??
    ((bin, args, options) => realSpawn(execPath, [bin, ...args.slice(1)], options));
  const supervisor = new Supervisor({
    emit: spy.emit,
    logger: opts.logger ?? silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    daemonInstanceId: opts.daemonInstanceId,
    runtimePidRootDir: opts.runtimePidRootDir,
    runtimeStartResolveDeps:
      opts.runtimeStartResolveDeps ?? testRuntimeStartResolveDeps(),
    controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
    emitRawRuntimeOutput: opts.emitRawRuntimeOutput ?? true,
    sigtermToSigkillMs: opts.sigtermToSigkillMs ?? 50,
    sigkillTimeoutMs: opts.sigkillTimeoutMs ?? 200,
  });
  return { supervisor, events: spy.events };
}

const baseStartParams = {
  conversation_id: 'c1',
  agent_id: 'a1',
  options: testStartOptions({
    conversationId: 'c1',
    agentId: 'a1',
    agentName: 'tester',
    runtime: 'claude',
  }),
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

/**
 * Wait until a `deliver()` WRITE-arm batch has been admitted into the
 * per-stream observed boundary. Under `runtime_deliver` the WRITE arm
 * returns `admitted` SYNC but records the observed boundary ASYNC
 * (inside `consumeStartupDelivery`, before it emits
 * `runtime_delivery_consumed`). Tests that then call
 * `agentMessageSend` and assert on the per-stream boundary must wait
 * for that consumed ack first.
 */
async function waitForDeliveryConsumed(
  events: EventFrame[],
  deliveryId: number,
): Promise<void> {
  await waitFor(() =>
    events.some(
      e =>
        e.event === 'runtime_delivery_consumed' &&
        e.delivery_ids.includes(deliveryId),
    ),
  );
}

/**
 * Wait until the spawned runtime has surfaced its `READY` line, which
 * (for the self-init echo-runtime fixture) means the handle has left
 * the `spawning`/`startup_pending` phase and reached `ready`. A
 * `deliver()` WRITE arm only admits on a ready handle — delivering
 * before READY would hit the `startup_pending` refuse arm.
 */
async function waitForRuntimeReady(events: EventFrame[]): Promise<void> {
  await waitFor(() =>
    events.some(
      e => e.event === 'runtime_output' && e.chunk.includes('READY'),
    ),
  );
}

describe('Supervisor 3a — spawn / status / phase emit', () => {
  it('logs required Silverhand env presence for both child and CLI shim without values', async () => {
    const infoRecords: unknown[] = [];
    const logger: DaemonLogger = {
      ...silentLogger(),
      info: obj => infoRecords.push(obj),
    };
    const { supervisor } = makeSupervisor({ logger });

    try {
      const res = await supervisor.start(baseStartParams);
      assertStarted(res);
      const attempt = infoRecords.find(
        record =>
          typeof record === 'object' &&
          record !== null &&
          (record as { action?: unknown }).action === 'runtime_spawn_attempt',
      ) as
        | {
            silverhand_env_presence?: {
              child: unknown;
              shim: unknown;
            };
          }
        | undefined;

      const expectedPresence = {
        all_present: true,
        present_keys: [
          'SILVERHAND_CONVERSATION_ID',
          'SILVERHAND_AGENT_ID',
          'SILVERHAND_SERVER_URL',
          'SILVERHAND_AUTH_TOKEN',
        ],
        missing_keys: [],
      };
      expect(attempt?.silverhand_env_presence).toEqual({
        child: expectedPresence,
        shim: expectedPresence,
      });
    } finally {
      await supervisor
        .stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
        .catch(() => {});
    }
  });

  it('fails typed before spawn when the resolved workspace path is missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'silverhand-missing-cwd-'));
    const missingPath = join(parent, 'gone');
    let spawnCalled = false;
    const { supervisor } = makeSupervisor({
      runtimeStartResolveDeps: testRuntimeStartResolveDeps({
        workspacePath: missingPath,
      }),
      spawnFn: () => {
        spawnCalled = true;
        throw new Error('spawn should not be called');
      },
    });

    try {
      await expect(supervisor.start(baseStartParams)).rejects.toMatchObject({
        code: 'workspace_path_missing',
        message: expect.stringContaining(missingPath),
      });
      expect(spawnCalled).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('contains spawn children that report no pid so their async error cannot crash the daemon', async () => {
    const fakeChild = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdout: null,
      stderr: null,
      stdin: null,
      kill: () => true,
    }) as unknown as ChildProcess;
    const { supervisor } = makeSupervisor({
      spawnFn: () => fakeChild,
    });

    await expect(supervisor.start(baseStartParams)).rejects.toThrow(
      /child spawned without a pid/,
    );
    expect(() => {
      fakeChild.emit('error', new Error('spawn failed after return'));
    }).not.toThrow();
  });

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

  it('hydrates prompt/spawn/env on daemon side from typed runtime_start options and drains the deliver SPAWN batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'silverhand-d2g-hydrate-'));
    // D4.e-6: options are semantic-only; the daemon resolves home_dir via
    // computeAgentDir(agentId, homeDir) and the regular workspace via the
    // injected resolver. Lay out L1 under computeAgentDir so the resolved
    // home_dir points at the system_prompt.md we write.
    const homeDir = dir;
    const agentHome = join(dir, '.silverhand', 'agents', 'a1');
    const workspacePath = join(dir, 'workspace');
    const memoryDir = join(workspacePath, '.silverhand', 'agents', 'a1');
    mkdirSync(agentHome, { recursive: true });
    mkdirSync(join(memoryDir, 'notes'), { recursive: true });
    writeFileSync(join(agentHome, 'system_prompt.md'), 'ROLE_D2G', 'utf8');
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'MEMORY_D2G', 'utf8');
    writeFileSync(
      join(memoryDir, 'notes', 'runtime.md'),
      [
        '---',
        'name: runtime-evidence',
        'description: Runtime spawn evidence; read before changing hydration.',
        'metadata:',
        '  category: project',
        '---',
        '# Runtime evidence',
        'NOTE_BODY_MUST_NOT_BE_INJECTED',
      ].join('\n'),
      'utf8',
    );

    let promptText = '';
    const captured: { ctx?: DriverSpawnContext } = {};
    const driver: Driver = {
      ...makeFakeDriver(['--echo-stdin']),
      buildArgs: ctx => {
        captured.ctx = ctx;
        promptText = readFileSync(ctx.systemPromptPath, 'utf8');
        return [FIXTURE, '--echo-stdin'];
      },
    };
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn: (bin, args, options) =>
        spawn(execPath, [bin, ...args.slice(1)], options),
      runtimeStartResolveDeps: testRuntimeStartResolveDeps({
        homeDir,
        workspacePath,
      }),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    try {
      const res = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        spawn_options: testStartOptions({
          conversationId: 'c1',
          agentId: 'a1',
        }),
        delivery_ids: [11],
        kind: 'message',
        text: 'startup delivery D2G',
      }, { owner: 'test-owner' });
      expect(res.disposition).toBe('spawning');
      expect(captured.ctx).toBeDefined();
      const ctx = captured.ctx!;
      expect(ctx.workspacePath).toBe(workspacePath);
      expect(ctx.systemPromptPath).toMatch(/spawn-.+system-prompt\.md$/);
      expect(promptText).toContain('ROLE_D2G');
      expect(promptText).toContain('MEMORY_D2G');
      expect(promptText).toContain('## Memory Notes Catalog');
      expect(promptText).toContain('runtime-evidence');
      expect(promptText).toContain('Runtime spawn evidence');
      expect(promptText).not.toContain('NOTE_BODY_MUST_NOT_BE_INJECTED');
      expect(promptText).not.toContain('CONSENSUS_D2G');
      await waitFor(() =>
        spy.events.some(e => e.event === 'runtime_delivery_consumed'),
      );
      expect(
        spy.events.some(
          e =>
            e.event === 'runtime_delivery_consumed' &&
            e.delivery_ids[0] === 11,
        ),
      ).toBe(true);
      await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it('start throws on malformed direct-call options', async () => {
    const { supervisor } = makeSupervisor();
    await expect(
      supervisor.start({
        conversation_id: 'c1',
        agent_id: 'a1',
        options: {} as never,
      }),
    ).rejects.toThrow();
  });

  it('start throws when the binary resolver returns null', async () => {
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => makeFakeDriver(),
      resolveBinary: async () => null,
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
    });
    await expect(supervisor.start(baseStartParams)).rejects.toThrow(/not found on PATH/);
  });

  it('start fails closed when the registry resolver throws (D4.e-6 — no spawn for an unprovisioned regular workspace)', async () => {
    let spawned = false;
    const { supervisor } = makeSupervisor({
      spawnFn: (bin, args, options) => {
        spawned = true;
        return spawn(execPath, [bin, ...args.slice(1)], options);
      },
      runtimeStartResolveDeps: testRuntimeStartResolveDeps({
        resolveRegularWorkspacePath: () => {
          throw new RuntimeStartResolveError(
            'workspace_not_provisioned',
            'ws1 is not bound on this host',
          );
        },
      }),
    });
    // The typed error surfaces verbatim (the dispatcher maps its `.code`
    // onto the runtime_start error arm); path resolution runs BEFORE
    // binary/prompt/spawn, so nothing is spawned.
    await expect(supervisor.start(baseStartParams)).rejects.toMatchObject({
      code: 'workspace_not_provisioned',
    });
    expect(spawned).toBe(false);
    expect(supervisor.status({}).runtimes).toHaveLength(0);
  });
});

describe('Supervisor 3a — output pump', () => {
  it('does not emit raw runtime_output by default', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo', 'large-tool-output-stays-local'],
      emitRawRuntimeOutput: false,
    });
    await supervisor.start(baseStartParams);
    await waitFor(() => events.some(e => e.event === 'runtime_ready_for_drain'));
    await wait(100);
    expect(
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('large-tool-output-stays-local'),
      ),
    ).toBe(false);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

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

  it('oneShot clean exit code 0 (no stop request) marks intentional=false; reason maps to replied → status:idle (Cindy `5nruk1IPaEHSab0T` B4)', async () => {
    // Cindy `5nruk1IPaEHSab0T` B4: a clean `exit(0)` is NOT a crash.
    // CM's terminal mapping uses code===0 → `replied/idle`; the
    // distinction matters for oneShot drivers (cursor) where a
    // single-turn process exits cleanly after producing its reply.
    // Mapping it to `crashed/failed` would let the UI / RunStateCache
    // mark every successful cursor run as failed.
    //
    // #task:1460 sharpened this: the `code === 0 → replied` arm is for a
    // runtime that completed its work — a oneShot single-turn run, or a
    // long-lived runtime that reached `session_init`. A LONG-LIVED
    // runtime that exits (even code 0) BEFORE `session_init` never
    // replied and is now an init failure (`crashed`), so this contract is
    // pinned with a oneShot driver — the class whose normal completion is
    // a pre-init-looking clean exit. (See the #task:1460 describe block
    // for the long-lived pre-init → crashed counterpart.)
    const { supervisor, events } = make3cSupervisor({
      // Sleep briefly then voluntarily exit(0). The supervisor never
      // gets a stop() call — this exercises the clean-exit path.
      driverArgs: ['--sleep', '50'],
      driverOverride: base => ({ ...base, oneShot: true }),
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
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
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

describe('Supervisor 3b — deliver WRITE arm writes payload to stdin', () => {
  it('deliver on a live runtime writes the encoded payload to stdin and returns admitted, settling onto runtime_delivery_consumed', async () => {
    // 3b lifts the 3a stub: the WRITE arm now writes the opaque
    // payload to the child's stdin (+ '\n') and returns admitted on
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
    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42, 43],
      kind: 'message',
      text: 'hi',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res.disposition).toBe('admitted');
    // Echo from fixture confirms the bytes reached the child.
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('STDIN:{"type":"user"'),
      ),
    );
    // Custody ack settles on the unified consumed event.
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_delivery_consumed' &&
          e.delivery_ids.length === 2 &&
          e.delivery_ids[0] === 42 &&
          e.delivery_ids[1] === 43,
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('deliver on a dead runtime respawns-with-batch (SPAWN arm) rather than refusing not_running', async () => {
    // Old wake semantics returned not_running when no handle existed.
    // Under runtime_deliver, no live handle routes to the SPAWN arm:
    // the daemon spawns the runtime with the batch as its startup
    // delivery and returns `spawning`.
    const { supervisor } = makeSupervisor();
    const res = await supervisor.deliver({
      conversation_id: 'cX',
      agent_id: 'aX',
      delivery_ids: [1],
      kind: 'message',
      text: 'stub',
      spawn_options: testStartOptions({
        conversationId: 'cX',
        agentId: 'aX',
        agentName: 'tester',
        runtime: 'claude',
      }),
    }, { owner: 'test-owner' });
    expect(res.disposition).toBe('spawning');
    await supervisor.stop({ conversation_id: 'cX', agent_id: 'aX', mode: 'hard' });
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
 *  `kickoffMode` defaults to `'self_inits'` (real claude is
 *  `requires_first_message`; pick the mode that matches the surface
 *  under test — this default is chosen for round-trip test simplicity,
 *  not driver realism). */
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
    releaseProfile: 'native-steer',
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
    // stdin write path (deferred startup_delivery consume, etc).
    // Mirror the claude driver's stream-json shape.
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
  emitRawRuntimeOutput?: boolean;
  logger?: DaemonLogger;
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
    logger: opts.logger ?? silentLogger(),
    driverFor: () => driver,
    resolveBinary: async (_kind, fallback) => fallback,
    spawnFn,
    runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
    controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
    emitRawRuntimeOutput: opts.emitRawRuntimeOutput ?? true,
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

  it('correlates runtime lifecycle frames to the minted payload uuid end-to-end (#task:1557)', async () => {
    const captured: Array<string | undefined> = [];
    const { driver, setNextParse } = makeProgrammableDriver();
    const baseEncode = driver.encodeStdinMessage.bind(driver);
    driver.encodeStdinMessage = (text, sess, opts) => {
      captured.push(opts?.payloadUuid);
      return baseEncode(text, sess, opts);
    };
    const logs: Array<Record<string, unknown>> = [];
    const logger: DaemonLogger = {
      info: (fields: unknown) => {
        if (fields && typeof fields === 'object') logs.push(fields as Record<string, unknown>);
      },
      warn: (fields: unknown) => {
        if (fields && typeof fields === 'object') logs.push(fields as Record<string, unknown>);
      },
      error: () => {},
    } as unknown as DaemonLogger;
    const { supervisor, events } = makeSupervisorWithDriver(driver, { logger });

    await supervisor.start(baseStartParams);
    await waitForRuntimeReady(events);

    // Delivery #1: the supervisor mints a uuid for the lifecycle-capable
    // driver and hands it to the encoder.
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [21],
      kind: 'message',
      text: 'first payload',
      delivered_up_to_seq: 21,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitForDeliveryConsumed(events, 21);
    const uuidA = captured[0];
    expect(uuidA).toBeTruthy();

    // Delivery #2's stdin echo triggers parseLine, which replays the
    // runtime's lifecycle for payload A (queued → started → completed).
    setNextParse([
      { kind: 'input_lifecycle', commandUuid: uuidA!, state: 'queued' },
      { kind: 'input_lifecycle', commandUuid: uuidA!, state: 'started' },
      { kind: 'input_lifecycle', commandUuid: uuidA!, state: 'completed' },
    ]);
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [22],
      kind: 'message',
      text: 'second payload',
      delivered_up_to_seq: 22,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitFor(() =>
      logs.some(
        l => l['action'] === 'input_lifecycle' && l['state'] === 'completed',
      ),
    );
    const lifecycleLogs = logs.filter(l => l['action'] === 'input_lifecycle');
    expect(lifecycleLogs).toHaveLength(3);
    for (const entry of lifecycleLogs) {
      expect(entry['command_uuid']).toBe(uuidA);
      expect(entry['correlated']).toBe(true);
      expect(entry['delivery_ids']).toEqual([21]);
    }

    // completed pruned the mapping: replaying `started` for uuidA on
    // delivery #3's echo must log correlated:false.
    setNextParse([
      { kind: 'input_lifecycle', commandUuid: uuidA!, state: 'started' },
    ]);
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [23],
      kind: 'message',
      text: 'third payload',
      delivered_up_to_seq: 23,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitFor(() =>
      logs.some(
        l =>
          l['action'] === 'input_lifecycle' &&
          l['state'] === 'started' &&
          l['correlated'] === false,
      ),
    );
    const uncorrelated = logs.find(
      l => l['action'] === 'input_lifecycle' && l['correlated'] === false,
    );
    expect(uncorrelated?.['delivery_ids']).toBeNull();

    // Zero behavior change: lifecycle frames drove no run-state tool
    // transition and no freshness advance of their own. Only the first
    // delivery's startup admission advances observed (deliveries 2/3
    // arrive mid-turn and park in pending admission) — the three
    // lifecycle frames add exactly nothing on top of that.
    expect(
      events.some(
        e => e.event === 'runtime_state' && e.state?.status === 'tool_running',
      ),
    ).toBe(false);
    expect(
      logs.filter(l => l['action'] === 'freshness_observed_seq_advanced').length,
    ).toBe(1);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('parsed events drive AgentRunState transitions (thinking → tool_running → thinking → idle)', async () => {
    const { driver } = makeProgrammableDriver([
      '--emit-line', 'A',
      '--emit-line', 'B',
      '--emit-line', 'C',
      '--emit-line', 'D',
      '--emit-line', 'E',
    ]);
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    // 6 stdout lines arrive: READY, A, B, C, D, E. The first call
    // (READY) consumes step 0; the remaining five drive the
    // lifecycle. step beyond the sequence returns [].
    let step = 0;
    const sequence: ParsedEvent[][] = [
      [],                                                  // READY (no-op)
      [{ kind: 'thinking', text: 'pondering' }],          // A → thinking
      [{ kind: 'tool_call', name: 'Bash', input: {} }],   // B → tool_running(Bash)
      [{ kind: 'tool_output', name: 'Bash' }],            // C → thinking (outstanding=0)
      [{ kind: 'text', text: 'hello' }],                   // D → text snippet, still thinking
      [{ kind: 'turn_end' }],                              // E → idle (turn_ended)
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
        e.state.activitySnippet === 'pondering' &&
        e.state.activitySnippetKind === 'thinking',
    );
    expect(snippetState).toBeDefined();

    const textSnippetState = events.find(
      e =>
        e.event === 'runtime_state' &&
        e.state.activitySnippet === 'hello' &&
        e.state.activitySnippetKind === 'text',
    );
    expect(textSnippetState).toBeDefined();

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
            'Claude API gateway unreachable; retrying (attempt 1)' &&
          e.state.activitySnippetKind === undefined,
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

describe('Supervisor 3b — deliver SPAWN batch step-0 mutex', () => {
  it('deliver SPAWN arm delays runtime_ready_for_drain until the batch settles (runtime_delivery_consumed comes first)', async () => {
    // Cindy `wuiwdLKrLFyGip_s`: settle order is
    //   consumed/failed → clear pending → ready_for_drain.
    // We verify by enforcing the relative event ordering.
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [101, 102],
      kind: 'message',
      text: 'boot batch',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitFor(() => events.some(e => e.event === 'runtime_ready_for_drain'));

    const idxConsumed = events.findIndex(
      e => e.event === 'runtime_delivery_consumed',
    );
    const idxReady = events.findIndex(
      e => e.event === 'runtime_ready_for_drain',
    );
    expect(idxConsumed).toBeGreaterThanOrEqual(0);
    expect(idxReady).toBeGreaterThan(idxConsumed);

    const consumed = events.find(
      e => e.event === 'runtime_delivery_consumed',
    );
    if (consumed && consumed.event === 'runtime_delivery_consumed') {
      expect(consumed.delivery_ids).toEqual([101, 102]);
    }

    // ready_for_drain must be emitted exactly once.
    const readyCount = events.filter(
      e => e.event === 'runtime_ready_for_drain',
    ).length;
    expect(readyCount).toBe(1);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('SPAWN batch gate is cleared even if the child exits before the supervisor writes the batch (no startup_pending leak)', async () => {
    // Cindy `wuiwdLKrLFyGip_s`: failed settle must still clear the
    // gate. The invariant is "any subsequent deliver never returns
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
      .deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [201],
        kind: 'message',
        text: 'boot batch',
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' })
      .catch(() => {});
    await waitFor(
      () =>
        events.some(e => e.event === 'runtime_exit') ||
        events.some(e => e.event === 'runtime_delivery_failed') ||
        events.some(e => e.event === 'runtime_delivery_consumed'),
      3_000,
    );
    // After the dust settles, a deliver must NOT refuse startup_pending
    // (it'll usually SPAWN again because the child already exited; if
    // consume won the race it may be admitted — both are fine. The key
    // invariant Cindy `wuiwdLKrLFyGip_s` locked is the gate cleared,
    // NOT a particular post-clear outcome).
    const deliverRes = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [202],
      kind: 'message',
      text: 'after-death',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    if (deliverRes.disposition === 'refused') {
      expect(deliverRes.reason).not.toBe('startup_pending');
    }

    // If the supervisor took the explicit failed path, verify the
    // delivery_ids round-trip and reason=child_exit (this is the
    // path that runs when the exit handler beats the consume).
    const failed = events.find(
      e => e.event === 'runtime_delivery_failed',
    );
    if (failed && failed.event === 'runtime_delivery_failed') {
      expect(failed.delivery_ids).toEqual([201]);
      expect(failed.reason).toBe('child_exit');
    }

    await supervisor
      .stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
      .catch(() => {});
  });
});

describe('Supervisor 3b — Cindy `YW2BGWryWjfymPkU` B2: deferred SPAWN-batch consume for requires_first_message drivers', () => {
  it('write success alone does NOT settle the gate when driver.kickoffMode === requires_first_message; consumed fires only after session_init', async () => {
    // CM's `initPendingInboxIds` defers `markDelivered` for codex-like
    // (`requires_first_message`) drivers until `session_init` arrives,
    // so the supervisor must mirror that. Until session_init,
    // `runtime_delivery_consumed` and `runtime_ready_for_drain`
    // are bottled up, and a subsequent `deliver` refuses `startup_pending`.
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
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [501, 502],
      kind: 'message',
      text: 'boot batch',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });

    // Wait for the stdin write to have actually completed (the consume
    // path is async — deliver() returned before the write settled).
    await waitFor(() => stub.writeResolved, 1_000);
    // Give the supervisor a couple of ticks to process the post-write
    // branch. Since requires_first_message + !initObserved, the gate
    // must NOT clear and ready_for_drain must NOT fire.
    await wait(40);

    expect(
      spy.events.some(e => e.event === 'runtime_delivery_consumed'),
    ).toBe(false);
    expect(spy.events.some(e => e.event === 'runtime_ready_for_drain')).toBe(
      false,
    );
    expect(spy.events.some(e => e.event === 'runtime_delivery_failed')).toBe(
      false,
    );

    // #task:1417 Stage 3 — deliver during the write-in-flight window now
    // DEFERS (the handle is `ready` but the first batch's write is parked
    // awaiting session_init, so `handle.startupDelivery !== null`). Custody
    // transfers to the daemon's mid-turn queue; [777] flushes once the
    // parked write settles. (Stage 2 refused `startup_pending` here and made
    // the backend re-drive; Stage 3 keeps it, which is strictly better.)
    const deliverMid = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [777],
      kind: 'message',
      text: 'stub',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(deliverMid).toEqual({
      disposition: 'deferred',
      pid: expect.any(Number),
      started_at: expect.any(Number),
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
      e => e.event === 'runtime_delivery_consumed',
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
      e => e.event === 'runtime_delivery_consumed',
    );
    if (consumed && consumed.event === 'runtime_delivery_consumed') {
      expect(consumed.delivery_ids).toEqual([501, 502]);
    }

    // ready_for_drain fires exactly once even with the deferred path.
    const readyCount = spy.events.filter(
      e => e.event === 'runtime_ready_for_drain',
    ).length;
    expect(readyCount).toBe(1);

    // #task:1417 Stage 3 — the deferred [777] flushes once the parked
    // startup write settled + the boundary reopened. Its own consumed lands
    // AFTER the startup batch's, covering the deferred delivery_id.
    await waitFor(
      () =>
        spy.events.some(
          e =>
            e.event === 'runtime_delivery_consumed' &&
            e.delivery_ids.includes(777),
        ),
      1_000,
    );

    // Deliver after everything settled now succeeds (WRITE arm → admitted).
    const deliverAfter = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [999],
      kind: 'message',
      text: 'stub',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(deliverAfter.disposition).toBe('admitted');

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
      | 'emitRawRuntimeOutput'
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
    runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
    controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
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
    emitRawRuntimeOutput: opts.emitRawRuntimeOutput ?? true,
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

  it('deferred-init: requires_first_message + no startup batch → no watchdog at spawn; deliver arms it', async () => {
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
    // Now deliver — that arms the watchdog. echo-runtime won't emit
    // session_init, so a silence/pre-cap timeout follows.
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'hi',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_timeout'),
      2_000,
    );
  });

  it('deferred-init: requires_first_message + SPAWN batch arms watchdog only after the first stdin write', async () => {
    class DelayedWriteStub extends EventEmitter {
      readonly pid = 34_567;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      pendingWrite: ((err?: Error | null) => void) | null = null;
      readonly stdin = {
        write: (
          _line: string,
          cb?: (err?: Error | null) => void,
        ): boolean => {
          this.pendingWrite = cb ?? null;
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        setImmediate(() => this.emit('exit', null, 'SIGTERM'));
        return true;
      }
    }
    const stub = new DelayedWriteStub();
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        kickoffMode: 'requires_first_message',
      }),
      spawnFn: () => stub as unknown as ChildProcess,
      initWatchdogMs: 60,
      initMaxRetries: 0,
      sigtermToSigkillMs: 30,
    });

    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [901],
      kind: 'message',
      text: 'boot batch',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    await waitFor(() => stub.pendingWrite !== null, 1_000);

    // Wait past the watchdog window while the SPAWN-batch write is
    // still unresolved. A spawn-time watchdog would fire here; the
    // correct boundary for Claude-like runtimes is the first completed
    // stdin write, not process spawn.
    await wait(150);
    expect(events.find(e => e.event === 'runtime_init_timeout')).toBeUndefined();

    stub.pendingWrite?.();
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

describe('Supervisor #task:1460 — pre-init exit folds into init-failure cooldown', () => {
  // Incident #1459: a long-lived runtime (claude) was SIGKILL'd by EDR
  // BEFORE `session_init`. The init watchdog never fired (the child died
  // faster than any tier), so the failure bypassed the retry/cooldown
  // counter entirely and backend re-drove the pending inbox row without
  // bound — 1105 spawns in 10 min. These tests pin the fold: a pre-init
  // abnormal exit of a long-lived runtime is accounted in the SAME
  // sticky counter, engages the same cooldown, and the cooldown then
  // refuses the next fresh start — WITHOUT the watchdog ever firing.
  //
  // The child crashes via `--sleep N --exit-code 1` (an abnormal exit
  // that isn't user-intentional); the predicate is exit-code/signal
  // agnostic (it keys off `driver.oneShot`), so a fast crash stands in
  // for the external SIGKILL. `initWatchdogMs` is left at its 5-min
  // default so the watchdog provably does NOT fire inside the test.

  it('a long-lived pre-init crash engages cooldown with NO runtime_init_timeout (not disguised as a watchdog timeout)', async () => {
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--sleep', '30', '--exit-code', '1'],
      // parseLine never returns session_init → initObserved stays false.
      initFailureCooldownThreshold: 1, // cooldown on the first failure
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_cooldown'),
      3_000,
    );
    // The watchdog must NOT have fired — this is the pre-init path, not a
    // timeout re-labelled. (Core of Cindy's "don't disguise as timeout".)
    expect(events.some(e => e.event === 'runtime_init_timeout')).toBe(false);
    const cooldown = events.find(e => e.event === 'runtime_init_cooldown');
    if (cooldown && cooldown.event === 'runtime_init_cooldown') {
      expect(cooldown.attempts_exhausted).toBe(1);
      expect(cooldown.cooldown_until > Date.now()).toBe(true);
    }
  });

  it('cooldown from a pre-init crash refuses the next fresh start (the loop-stopping gate)', async () => {
    const { supervisor } = make3cSupervisor({
      driverArgs: ['--sleep', '30', '--exit-code', '1'],
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        supervisor
          .status({ conversation_id: 'c1', agent_id: 'a1' })
          .runtimes.every(r => r.phase === 'exited') ||
        supervisor.status({ conversation_id: 'c1', agent_id: 'a1' }).runtimes
          .length === 0,
      3_000,
    );
    await wait(50); // let the exit handler engage cooldown
    const second = await supervisor.start(baseStartParams);
    expect(second.started).toBe(false);
    if (!second.started) {
      expect(second.reason).toBe('init_cooldown');
      expect(second.cooldown_until > Date.now()).toBe(true);
    }
  });

  it('a long-lived runtime that exits code 0 BEFORE session_init still counts (lifecycle, not exit code)', async () => {
    // Cindy point 1: for a long-lived driver a clean code-0 exit before
    // `session_init` is STILL an init failure — it never replied and
    // would re-loop on the pending inbox — so it must engage cooldown.
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--sleep', '30', '--exit-code', '0'],
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_cooldown'),
      3_000,
    );
    expect(events.some(e => e.event === 'runtime_init_timeout')).toBe(false);
  });

  it('a oneShot runtime that exits CLEAN code-0 pre-init is EXCLUDED — no cooldown, next start still succeeds', async () => {
    // A oneShot / cursor `--print` runtime's compatible completion is a
    // clean code-0 exit before `initObserved`; counting it would cooldown
    // a healthy runtime. The predicate excludes ONLY the clean case, so
    // even a threshold of 1 never engages here.
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--sleep', '30', '--exit-code', '0'],
      driverOverride: base => ({ ...base, oneShot: true }),
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () =>
        supervisor
          .status({ conversation_id: 'c1', agent_id: 'a1' })
          .runtimes.every(r => r.phase === 'exited') ||
        supervisor.status({ conversation_id: 'c1', agent_id: 'a1' }).runtimes
          .length === 0,
      3_000,
    );
    await wait(50);
    expect(events.some(e => e.event === 'runtime_init_cooldown')).toBe(false);
    // Not gated — a oneShot's clean exit left the failure counter clean.
    const second = await supervisor.start(baseStartParams);
    expect(second.started).toBe(true);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('a oneShot runtime that exits ABNORMALLY (non-zero) pre-init IS counted (oneShot excuses success, not a kill)', async () => {
    // Cindy P1: `oneShot` only explains "exits after a successful turn",
    // NOT "gets signal-killed / exits non-zero before init". EDR can
    // SIGKILL cursor too, and backend's generic pending re-drive would
    // loop it just the same. A non-zero pre-init exit therefore counts
    // and engages cooldown. (A SIGKILL delivers code=null / signal set,
    // which takes the same `code !== 0` disjunct as this non-zero case.)
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--sleep', '30', '--exit-code', '1'],
      driverOverride: base => ({ ...base, oneShot: true }),
      initFailureCooldownThreshold: 1,
      initFailureCooldownMs: 60_000,
    });
    await supervisor.start(baseStartParams);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_cooldown'),
      3_000,
    );
    expect(events.some(e => e.event === 'runtime_init_timeout')).toBe(false);
    const cooldown = events.find(e => e.event === 'runtime_init_cooldown');
    if (cooldown && cooldown.event === 'runtime_init_cooldown') {
      expect(cooldown.attempts_exhausted).toBe(1);
    }
    // And the cooldown gate now refuses the next fresh start.
    await wait(20);
    const second = await supervisor.start(baseStartParams);
    expect(second.started).toBe(false);
  });

  it('threshold=3: the sticky counter accumulates across 3 independent pre-init crashes; only the 3rd engages cooldown; the 4th fresh start is refused (#1459 acceptance)', async () => {
    // The real #1459 acceptance: prove the per-(conv, agent) counter is
    // STICKY across separate handles (each `start()` is a fresh
    // user-initiated attempt=0, purging the prior exited handle), that
    // the first two crashes do NOT cooldown, that the 3rd emits exactly
    // one `runtime_init_cooldown` with `attempts_exhausted === 3`, and
    // that the 4th start is gated. Guards off-by-one and any per-handle
    // counter reset that a threshold=1 test cannot catch.
    const { supervisor, events } = make3cSupervisor({
      driverArgs: ['--sleep', '25', '--exit-code', '1'],
      initFailureCooldownThreshold: 3,
      initFailureCooldownMs: 60_000,
    });

    // Crash 1 and 2: fresh start each time, wait for the terminal exit so
    // the counter is bumped before the next start. Neither should cooldown.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await supervisor.start(baseStartParams);
      expect(res.started).toBe(true); // not gated yet
      await waitFor(
        () => events.filter(e => e.event === 'runtime_exit').length === attempt,
        3_000,
      );
      expect(events.some(e => e.event === 'runtime_init_cooldown')).toBe(false);
    }

    // Crash 3: still a permitted fresh start, but this exit crosses the
    // threshold and engages cooldown.
    const third = await supervisor.start(baseStartParams);
    expect(third.started).toBe(true);
    await waitFor(
      () => events.some(e => e.event === 'runtime_init_cooldown'),
      3_000,
    );
    const cooldowns = events.filter(e => e.event === 'runtime_init_cooldown');
    expect(cooldowns).toHaveLength(1);
    const cd = cooldowns[0];
    if (cd && cd.event === 'runtime_init_cooldown') {
      expect(cd.attempts_exhausted).toBe(3);
      expect(cd.cooldown_until > Date.now()).toBe(true);
    }
    // The watchdog never fired across the whole sequence.
    expect(events.some(e => e.event === 'runtime_init_timeout')).toBe(false);

    // 4th fresh start is refused by the cooldown gate.
    await wait(20);
    const fourth = await supervisor.start(baseStartParams);
    expect(fourth.started).toBe(false);
    if (!fourth.started) {
      expect(fourth.reason).toBe('init_cooldown');
      expect(fourth.cooldown_until > Date.now()).toBe(true);
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

  it('B3: init watchdog fire flips phase=draining so deliver during the kill window refuses draining', async () => {
    // Without B3 the watchdog kill window leaves `deliver()` open: the
    // timer fires, `failInitWatchdog` SIGTERMs the child but does NOT
    // touch phase, so deliver's `exited/startup_pending/draining` gate
    // doesn't catch it. Backend writes stdin to a dying process and
    // markDelivered's the inbox row to a runtime that never
    // processes it. With B3, failInitWatchdog sets phase='draining'
    // immediately, so the deliver gate's draining arm refuses.
    //
    // Test setup: no-output fixture with --ignore-sigterm so the
    // child stays alive in the SIGTERM grace window. initWatchdogMs
    // is widened to 1000ms so node has time to cold-boot the fixture
    // AND register the SIGTERM handler before the timer fires (a
    // signal that arrives mid-bootstrap falls back to default
    // action — terminate — defeating --ignore-sigterm). Long
    // SIGTERM/SIGKILL grace keeps the dying handle observable while
    // deliver races against the retry respawn.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE, '--ignore-sigterm'],
      }),
      initWatchdogMs: 1_000,
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
    const deliverRes = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [11],
      kind: 'message',
      text: 'during-kill-window',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(deliverRes.disposition).toBe('refused');
    if (deliverRes.disposition === 'refused') {
      // 'draining' is the deliver-gate signal that the runtime is being
      // torn down — backend MUST NOT markDelivered against this
      // outcome.
      expect(deliverRes.reason).toBe('draining');
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
    //   2. deliver during kill window → refused with reason='draining'
    //   3. child exits → onChildExit detects retry → emits
    //      runtime_init_retrying + deletes old handle + spawns new
    //   4. new handle has a different pid; status() reports a fresh
    //      ready runtime
    //
    // Same fixture configuration rationale as the B3 test above:
    // --ignore-sigterm + 1000ms watchdog so node boots and registers
    // the handler before the timer fires; 800ms SIGTERM grace so the
    // dying handle stays observable.
    const { supervisor, events } = make3cSupervisor({
      driverOverride: base => ({
        ...base,
        binary: NO_OUTPUT_FIXTURE,
        buildArgs: () => [NO_OUTPUT_FIXTURE, '--ignore-sigterm'],
      }),
      initWatchdogMs: 1_000,
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
    // Deliver inside the draining window must refuse.
    const midDeliver = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'x',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(midDeliver.disposition).toBe('refused');
    if (midDeliver.disposition === 'refused')
      expect(midDeliver.reason).toBe('draining');
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
//   1. `startup_pending` (deliver, readyToEncode() === false) —
//      → recoverable arm; backend keeps DB row pending and will
//      redeliver on `runtime_ready_for_drain`.
//   2. `driver_refused` (deliver WRITE arm) — readyToEncode() returned
//      true but encodeStdinMessage() returned null → driver bug; the
//      WRITE arm admits SYNC then fails ASYNC on runtime_delivery_failed
//      (Cindy `0G5uJBydO_4qt_2r`).
//   3. Codex stateful gate — readyToEncode() flips false → true on
//      `session_init` (production codex flips on `thread/started`).
//      ready_for_drain and a deferred SPAWN-batch consume both
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
    releaseProfile: 'native-steer',
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

describe('Supervisor 3b — Option A v2 deliver arms (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('deliver on a driver whose readyToEncode()=false refuses startup_pending (recoverable)', async () => {
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

    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [201, 202],
      kind: 'message',
      text: 'hi from backend',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res).toEqual({
      disposition: 'refused',
      reason: 'startup_pending',
    });
    // No stdin write should have surfaced — fixture would echo
    // STDIN:{...} on every received line.
    const echoed = events.some(
      e => e.event === 'runtime_output' && e.chunk.includes('STDIN:'),
    );
    expect(echoed).toBe(false);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('deliver post-ready: encodeStdinMessage returns null → admitted then async runtime_delivery_failed reason:driver_refused (fail loud)', async () => {
    // readyToEncode() returns true but the driver's encoder produces
    // null. This is the driver-bug arm — Cindy `0G5uJBydO_4qt_2r`:
    // fail loudly rather than silently dropping bytes. Under
    // runtime_deliver the WRITE arm admits SYNC (driverReadyToEncode
    // defaults/returns true) and the failure surfaces ASYNC on the
    // unified runtime_delivery_failed family.
    const driver: Driver = {
      kind: 'codex',
      binary: FIXTURE,
      kickoffMode: 'self_inits',
      releaseProfile: 'native-steer',
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
    // startup-batch gate.
    await waitFor(() =>
      events.some(e => e.event === 'runtime_ready_for_drain'),
    );

    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [301],
      kind: 'message',
      text: 'bytes',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res.disposition).toBe('admitted');
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_delivery_failed' &&
          e.delivery_ids.includes(301) &&
          e.reason === 'driver_refused',
      ),
    );
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor 3b — Option A v2 ready_for_drain gate by readyToEncode (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('ready_for_drain is held until readyToEncode() flips true (codex stateful gate)', async () => {
    // No startup batch; gate is purely driver.readyToEncode().
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
    // The simplest way to inject a line is to deliver to the supervisor;
    // but that would refuse startup_pending. Instead use the existing
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

describe('Supervisor 3b — Option A v2 deferred SPAWN batch on stateful driver (Cindy `UMGu36zoTDVuKWXi`)', () => {
  it('SPAWN-batch encode is deferred until readyToEncode() flips true (codex pre-thread/started)', async () => {
    // Codex case: deliver SPAWN arm with a batch while the driver's
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
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [701, 702],
      kind: 'message',
      text: 'boot codex',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });

    // Eventually the fixture emits THREAD_STARTED → parseLine flips
    // ready → tryConsumeStartupDelivery encodes + writes → consumed +
    // ready_for_drain fire in that order.
    await waitFor(
      () => events.some(e => e.event === 'runtime_ready_for_drain'),
      2_000,
    );
    const consumed = events.find(
      e => e.event === 'runtime_delivery_consumed',
    );
    const idxConsumed = events.findIndex(
      e => e.event === 'runtime_delivery_consumed',
    );
    const idxReady = events.findIndex(
      e => e.event === 'runtime_ready_for_drain',
    );
    expect(consumed).toBeDefined();
    if (consumed && consumed.event === 'runtime_delivery_consumed') {
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

describe('Supervisor — daemon-owned freshness boundary', () => {
  it('attaches a stale-send continuation only to normal delivery that covers the same stream, repeats until resolution, then stops', async () => {
    const encodedTexts: string[] = [];
    const { driver } = makeProgrammableDriver();
    const baseEncode = driver.encodeStdinMessage.bind(driver);
    driver.encodeStdinMessage = (text, sessionId, opts) => {
      encodedTexts.push(text);
      return baseEncode(text, sessionId, opts);
    };
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    let backendCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        backendCalls += 1;
        if (backendCalls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: 'stale-main-12',
                  stream_key: 'main',
                  seen_up_to_seq: 10,
                  current_seq: 12,
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const deliver = async (
      deliveryId: number,
      text: string,
      deliveredUpToSeq: number,
      deliveries?: Array<{
        delivery_id: number;
        message_id: string;
        seq: number;
        thread_root_id: string | null;
        delivery_kind: 'turn' | 'observe';
      }>,
    ) => {
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [deliveryId],
        kind: 'message',
        text,
        delivered_up_to_seq: deliveredUpToSeq,
        ...(deliveries ? { deliveries } : {}),
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, deliveryId);
    };
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await deliver(10, 'main-10', 10);

      const stale = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'draft',
      });
      expect(stale).toMatchObject({ ok: false, status: 409 });

      await deliver(20, 'thread-20', 20, [{
        delivery_id: 20,
        message_id: 'thread-message-20',
        seq: 20,
        thread_root_id: 'thread-root',
        delivery_kind: 'observe',
      }]);
      expect(encodedTexts.at(-1)).toBe('thread-20');

      await deliver(11, 'main-11', 11);
      expect(encodedTexts.at(-1)).toBe('main-11');

      await deliver(12, 'main-12', 12);
      expect(encodedTexts.at(-1)).toContain('stale-main-12');
      expect(encodedTexts.at(-1)).toContain('--stale-resolution revised');

      await deliver(13, 'main-13', 13);
      expect(encodedTexts.at(-1)).toContain('stale-main-12');

      const resolved = await supervisor.agentStaleResolve({
        conversation_id: 'c1',
        agent_id: 'a1',
        resolution_reason: 'obsolete',
      });
      expect(resolved).toEqual({ ok: true, resolved: true });

      await deliver(14, 'main-14', 14);
      expect(encodedTexts.at(-1)).toBe('main-14');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('carries the stale event and holds the boundary when the 409 window is empty', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (postedBodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: 'stale-1',
                  seen_up_to_seq: 12,
                  current_seq: 13,
                  newer_messages: [],
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ message_id: 'm14', message_seq: 14 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [12],
        kind: 'message',
        text: 'count upward from 1',
        delivered_up_to_seq: 12,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 12);

      const stale = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '1',
      });
      expect(stale).toMatchObject({ ok: false, status: 409 });

      const retry = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '2',
        stale_resolution_reason: 'revised',
      });

      expect(retry).toMatchObject({ ok: true, message_id: 'm14' });
      expect(postedBodies).toHaveLength(2);
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(12);
      // Empty `newer_messages` window: nothing was shown, so the observed
      // boundary must NOT advance to current_seq (13) — it stays at 12
      // and the CAS remains armed for the unseen message.
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(12);
      expect(postedBodies[1]?.['stale_event_id']).toBe('stale-1');
      expect(postedBodies[1]?.['stale_resolution_reason']).toBe('revised');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('api_response falsifier (#task:1582): waiting/ready own only their display lane, and the notice is NOT generation-boundary evidence (pending coverage stays parked)', async () => {
    const { driver, setNextParse } = makeProgrammableDriver();
    const logs: Array<Record<string, unknown>> = [];
    const logger = {
      info: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      warn: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      error: () => {},
    } as unknown as DaemonLogger;
    const { supervisor, events } = makeSupervisorWithDriver(driver, { logger });
    const advancedTo = (seq: number) =>
      logs.some(
        l =>
          l['action'] === 'freshness_observed_seq_advanced' &&
          l['observed_seq'] === seq,
      );
    const lastStatus = () => {
      const frames = events.filter(e => e.event === 'runtime_state');
      const last = frames.at(-1);
      return last && last.event === 'runtime_state' ? last.state : null;
    };
    let tick = 100;
    const deliverTick = async (parsedEvents: ParsedEvent[]) => {
      setNextParse(parsedEvents);
      tick += 1;
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [tick], kind: 'message',
        text: `tick-${tick}`, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, tick);
    };
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      // M1 (seq 10) admitted → observed 10, turn active.
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [10], kind: 'message',
        text: 'M1', delivered_up_to_seq: 10, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 10);

      // Provider queue notice → dedicated `waiting` status with the
      // normalized message on the snippet (was mislabeled `thinking`).
      await deliverTick([
        { kind: 'api_response', status: 'waiting', message: 'Qoder model request queued (queue size 3)' },
      ]);
      await waitFor(() => lastStatus()?.status === 'waiting');
      expect(lastStatus()?.activitySnippet).toContain('queue size 3');

      // `ready` restores ONLY the hold waiting created → back to thinking.
      await deliverTick([
        { kind: 'api_response', status: 'ready', message: 'Qoder model is available; resuming request' },
      ]);
      await waitFor(() => lastStatus()?.status === 'thinking');

      // `notice` is display-only: it never touches the run state.
      await deliverTick([
        { kind: 'api_response', status: 'notice', message: 'provider capacity degraded' },
      ]);
      expect(lastStatus()?.status).toBe('thinking');

      // Lane guard: a running tool owns the display. waiting must NOT
      // displace tool_running (same guard as tool_output's restore),
      // and ready must NOT touch a status waiting did not create.
      await deliverTick([{ kind: 'tool_call', name: 'Bash', input: {} }]);
      await waitFor(() => lastStatus()?.status === 'tool_running');
      await deliverTick([
        { kind: 'api_response', status: 'waiting', message: 'queued mid-tool' },
      ]);
      expect(lastStatus()?.status).toBe('tool_running');
      expect(lastStatus()?.detail).toBe('Bash');
      await deliverTick([
        { kind: 'api_response', status: 'ready', message: 'ready mid-tool' },
      ]);
      expect(lastStatus()?.status).toBe('tool_running');
      await deliverTick([{ kind: 'tool_output', name: 'Bash' }]);
      await waitFor(() => lastStatus()?.status === 'thinking');

      // Evidence falsifier: after turn_end, seq 12 is delivered mid-gap
      // and parks in pendingAdmission. A provider notice must NOT settle
      // it — api_response is a delivery/transport-side observation, not
      // proof a new model generation started.
      setNextParse([{ kind: 'turn_end' }]);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [12], kind: 'message',
        text: 'gap', delivered_up_to_seq: 12, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 12);
      await deliverTick([
        { kind: 'api_response', status: 'waiting', message: 'queued again' },
      ]);
      expect(advancedTo(12)).toBe(false);

      // A REAL generation start (thinking) settles the pending coverage.
      await deliverTick([{ kind: 'thinking', text: 'new action' }]);
      await waitFor(() => advancedTo(12));
    } finally {
      await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
        .catch(() => undefined);
    }
  });

  it('countgame round-2 falsifier (#task:1561): old action with locked snapshot gets a REAL signal-only 409; only after the userMessage-echo lifecycle does the informed resend pass CAS', async () => {
    const captured: Array<string | undefined> = [];
    const { driver, setNextParse } = makeProgrammableDriver();
    const baseEncode = driver.encodeStdinMessage.bind(driver);
    driver.encodeStdinMessage = (text, sess, opts) => {
      captured.push(opts?.payloadUuid);
      return baseEncode(text, sess, opts);
    };
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    const postedBodies: Record<string, unknown>[] = [];
    // CAS-aware fake backend (Cindy P1): the conversation head is at
    // seq 11 (M2 already landed). A send whose seen_up_to_seq trails the
    // head gets the production signal-only 409 shape — no bodies, no
    // count; a fresh send gets 200. This makes the falsifier end-to-end:
    // an unconditionally-200 fake had blessed exactly the round-2 bug.
    let backendHeadSeq = 11;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(body);
        const seen = body['seen_up_to_seq'];
        if (
          body['freshness_bypass'] !== true &&
          typeof seen === 'number' &&
          seen < backendHeadSeq
        ) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: `message is stale: conversation advanced from seq ${seen} to ${backendHeadSeq} before send`,
                retriable: false,
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: `se-${postedBodies.length}`,
                  stream_key: 'main',
                  seen_up_to_seq: seen,
                  current_seq: backendHeadSeq,
                  hint: 'unseen messages are queued for normal delivery',
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        backendHeadSeq += 1;
        return new Response(
          JSON.stringify({
            message_id: `m${postedBodies.length}`,
            message_seq: backendHeadSeq,
            thread_root_id: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      // M1 (seq 10) admitted at boundary → observed MAIN=10, turn active.
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [10], kind: 'message',
        text: 'M1', delivered_up_to_seq: 10, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 10);

      // M2 (seq 11) steered mid-turn: written into the active turn. The
      // JSON-RPC response to that steer is a TRANSPORT ack and (round-2
      // contract) produces NO parsed event at all — coverage stays parked
      // in pendingAdmission (#1471), observed stays 10.
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [11], kind: 'message',
        text: 'M2', delivered_up_to_seq: 11, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 11);
      const uuidM2 = captured[captured.length - 1];
      expect(uuidM2).toBeTruthy();

      // The already-in-flight action's send carries the LOCKED snapshot
      // (seen=10) and the backend CAS MUST stale it — this is the exact
      // event round 2 let through three times.
      const send1 = await supervisor.agentMessageSend({
        conversation_id: 'c1', agent_id: 'a1', content: '0-old-draft',
      });
      expect(send1.ok).toBe(false);
      expect(send1.ok === false && send1.status).toBe(409);
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(10);

      // Generation-boundary evidence: codex drains pending_input into
      // model history and echoes our clientUserMessageId on
      // item/started(userMessage) — the driver maps it to
      // input_lifecycle started; the real completed follows as its own
      // frame (Cindy P2). NOW observed promotes to 11.
      setNextParse([
        { kind: 'input_lifecycle', commandUuid: uuidM2!, state: 'started' },
      ]);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [12], kind: 'message',
        text: 'tick', spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 12);
      setNextParse([
        { kind: 'input_lifecycle', commandUuid: uuidM2!, state: 'completed' },
      ]);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [13], kind: 'message',
        text: 'tick2', spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 13);

      // The informed resend (revised draft under the recorded stale
      // event) carries seen=11 and passes CAS.
      const send2 = await supervisor.agentMessageSend({
        conversation_id: 'c1', agent_id: 'a1', content: '1',
        stale_resolution_reason: 'revised',
      });
      expect(send2.ok).toBe(true);
      const informed = postedBodies[postedBodies.length - 1]!;
      expect(informed['seen_up_to_seq']).toBe(11);
      expect(informed['stale_resolution_reason']).toBe('revised');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
        .catch(() => undefined);
    }
  });

  it('countgame P1-B falsifier: a bypass holds the watermark across the gap, then the own seq MERGES once the gap is admitted (no permanent hole)', async () => {
    const { driver, setNextParse } = makeProgrammableDriver([], 'self_inits');
    const { supervisor, events } = makeSupervisorWithDriver(driver);
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const isBypass = postedBodies[postedBodies.length - 1]?.['freshness_bypass'] === true;
        // Backend accepts the bypass send at seq 15, with the stream head
        // at insert time (14) as the merge prerequisite — everything the
        // sender skipped past.
        return new Response(
          JSON.stringify(
            isBypass
              ? {
                  message_id: 'forced',
                  message_seq: 15,
                  thread_root_id: null,
                  stream_head_before: 14,
                }
              : { message_id: `m${postedBodies.length}`, thread_root_id: null },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [11], kind: 'message',
        text: 'seed observed at 11', delivered_up_to_seq: 11,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 11);

      const forced = await supervisor.agentMessageSend({
        conversation_id: 'c1', agent_id: 'a1',
        content: 'forced past the gap',
        freshness_bypass: true,
      });
      expect(forced.ok).toBe(true);

      // Arm 1 — no immediate swallow (live regression 11→15/11→16): the
      // forced message lands but the cursor HOLDS; the next normal send
      // still declares seen=11 while 12–14 are unadmitted.
      const next = await supervisor.agentMessageSend({
        conversation_id: 'c1', agent_id: 'a1', content: 'next normal send',
      });
      expect(next.ok).toBe(true);
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(11);

      // Arm 2 — no permanent hole (Cindy follow-up P1): the sender is
      // excluded from its own fan-out, so seq 15 never arrives by inbox.
      // When the REAL gap (12..14) is legitimately admitted, observed
      // must converge THROUGH the prerequisite to the own seq 15 — not
      // stall at 14 with head=15 forever.
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [14], kind: 'message',
        text: 'gap batch 12..14', delivered_up_to_seq: 14,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 14);
      // Mid-turn write is not evidence (#1471): promote the pending gap
      // at the next parsed turn boundary (turn_end → new-turn thinking).
      // Seq-less tick deliveries flush the preset parse events via the
      // fixture's stdin echo without touching observed themselves.
      setNextParse([{ kind: 'turn_end' }]);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [90], kind: 'message',
        text: 'tick1', spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitFor(() =>
        events.some(
          e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'turn_end',
        ),
      );
      setNextParse([{ kind: 'thinking', text: 'new turn' }]);
      await supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [91], kind: 'message',
        text: 'tick2', spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitFor(() =>
        events.some(
          e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'thinking',
        ),
      );

      const converged = await supervisor.agentMessageSend({
        conversation_id: 'c1', agent_id: 'a1', content: 'post-gap send',
      });
      expect(converged.ok).toBe(true);
      expect(postedBodies[postedBodies.length - 1]?.['seen_up_to_seq']).toBe(15);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
        .catch(() => undefined);
    }
  });

  it('signal-only 409 never moves the observed cursor (#task:1561): an uninformed retry keeps the old boundary', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (postedBodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: 'stale-s',
                  stream_key: 'main',
                  seen_up_to_seq: 12,
                  current_seq: 30,
                  hint: 'wait for normal delivery',
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ message_id: 'm31', message_seq: 31 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [12],
        kind: 'message',
        text: 'seed observed at 12',
        delivered_up_to_seq: 12,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 12);

      const stale = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '1',
      });
      expect(stale).toMatchObject({ ok: false, status: 409 });

      await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '2',
        stale_resolution_reason: 'revised',
      });
      // Nothing was shown by the 409 (no bodies on the wire), so the
      // retry's boundary is STILL 12 — the CAS stays armed until the
      // unseen window arrives through normal delivery and admission
      // evidence advances the cursor. The retry also correlates the
      // pending stale event exactly once.
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(12);
      expect(postedBodies[1]?.['stale_event_id']).toBe('stale-s');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('fails closed on a malformed stale window: the observed cursor does not move', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    // Two consecutive degenerate 409 shapes: (1) malformed seen + entries
    // without usable seq; (2) seen absent entirely + empty window. Neither
    // yields evidence of what was shown, so neither may move the cursor.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (postedBodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: 'stale-m',
                  seen_up_to_seq: 'not-a-number',
                  current_seq: 30,
                  newer_messages: [{}, { seq: 'x' }],
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        if (postedBodies.length === 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: 'stale-n',
                  current_seq: 30,
                  newer_messages: [],
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ message_id: 'm31', message_seq: 31 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [12],
        kind: 'message',
        text: 'seed observed at 12',
        delivered_up_to_seq: 12,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 12);

      const stale = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '1',
      });
      expect(stale).toMatchObject({ ok: false, status: 409 });

      const stale2 = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '2',
        stale_resolution_reason: 'revised',
      });
      expect(stale2).toMatchObject({ ok: false, status: 409 });
      // Cursor unchanged after shape (1): still the delivery boundary.
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(12);
      expect(postedBodies[1]?.['stale_event_id']).toBe('stale-m');

      await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: '3',
        stale_resolution_reason: 'revised',
      });
      // Cursor unchanged after shape (2) as well: never 30.
      expect(postedBodies[2]?.['seen_up_to_seq']).toBe(12);
      expect(postedBodies[2]?.['stale_event_id']).toBe('stale-n');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });
});

// =============================================================================
// Supervisor — mid-turn delivery admission gate (#task:1471)
// -----------------------------------------------------------------------------
// CONTRACT (Do Not Weaken):
//
//   A delivery admitted into `observedSeqByStream` must reflect what the
//   *model* has actually observed as a bounded turn context — NOT what the
//   daemon has merely handed to stdin. When the model is mid-turn
//   (`inputTurnActive=true`), a fresh delivery's seq goes into
//   `pendingAdmissionSeqByStream` and is promoted to observed only at the
//   next parsed turn-start (`admitPendingSeqForNewTurn`), OR when a stale
//   response advances it via `message_stale_response`.
//
// WHY THIS EXISTS:
//
//   The pre-#1417 world had a `runtime_wake` contract test that pinned
//   this ("does not admit mid-turn wake delivery into the next send
//   boundary"). #1417 folded wake into `runtime_deliver →
//   consumeStartupDelivery` and that test was deleted with the old API,
//   leaving the behaviour untested. `consumeStartupDelivery` then
//   hard-coded `admitNow=true`, which silently bypassed the 409 stale
//   gate and broke turn-taking in countgame1 (5-agent race — the daemon
//   reported mid-turn deliveries as model-seen even though the model's
//   current action was generated from the earlier turn context, so the
//   backend CAS couldn't identify laggard sends as stale).
//
// REVIEW GATE — a modifier MUST answer these before changing this group:
//
//   1. Are you softening `expect(seen_up_to_seq).toBe(<pre-turn seq>)` in
//      the mid-turn send? If yes, you are removing a load-bearing proof
//      point of the #1417 regression guard — do not.
//   2. Are you deleting the 409-aware mock in the gated test (returning
//      200 unconditionally)? That collapses this into an error-handling
//      test and stops proving that stale is being *produced*.
//   3. Are you removing the race test? The pre-await snapshot invariant
//      (see supervisor/index.ts consumeStartupDelivery) is a
//      load-bearing proof point in this group — without an equivalent,
//      moving the admission-decision read to after any async barrier
//      that can interleave with `turn_end` will pass CI.
//   4. Are you migrating this behaviour to a new API? Port the
//      equivalent proof points to that API's inputs BEFORE deleting or
//      replacing this group; merging/renaming tests is fine, dropping
//      the contract is not.
// =============================================================================
describe('Supervisor — mid-turn delivery admission gate (#task:1471)', () => {
  it('queues mid-turn delivery into pending admission and promotes it at the next parsed turn-start, while runtime_delivery_consumed still fires per delivery', async () => {
    // INVARIANT: mid-turn delivery's seq must NOT reach the model-seen
    // cursor (observed) until the next parsed turn-start. Two proof
    // points, both load-bearing:
    //   (a) mid-turn send body carries seen=10 (pre-turn), not 11.
    //   (b) after turn_end + parsed thinking, next-turn send carries seen=11
    //       — pending WAS promoted, so the fix hasn't over-corrected into
    //       "never admit".
    // Delivery custody (runtime_delivery_consumed) fires for both
    // regardless. Do not weaken either proof point; (a) proves the gate,
    // (b) proves the promoter.
    class ControlledStub extends EventEmitter {
      readonly pid = 34_567;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (
          _line: string,
          cb?: (err?: Error | null) => void,
        ): boolean => {
          setImmediate(() => cb?.());
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

    const { driver } = makeProgrammableDriver([], 'self_inits');
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn,
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      emitRawRuntimeOutput: true,
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(body);
        // Deliberately omit `message_seq` on the send response so the
        // post-commit `advanceObservedStream(message_send_commit)` is a
        // no-op. This isolates what we're actually testing (the mid-turn
        // admit boundary) from the orthogonal send-commit advance path.
        return new Response(
          JSON.stringify({ message_id: `m${postedBodies.length}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    try {
      // M1 arrives via SPAWN arm — no prior handle → startUnlocked with
      // M1 as its startup_delivery. Handle materializes with
      // inputTurnActive=false (fake driver is not oneShot), so
      // consumeStartupDelivery admits M1 immediately into observed
      // (MAIN=10) and the admit flips inputTurnActive=true.
      const spawnResult = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [10],
        kind: 'message',
        text: 'first message (spawn batch)',
        delivered_up_to_seq: 10,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(spawnResult).toMatchObject({ disposition: 'spawning' });
      await waitForDeliveryConsumed(spy.events, 10);

      // M2 arrives while the model is still mid-turn (inputTurnActive=true).
      // Pre-fix: admitted immediately, bumped observed to 11 → the still-
      // in-flight model send would report seen=11 for a message it never
      // saw and CAS would never stale. Fixed: routed into
      // pendingAdmissionSeqByStream; observed stays at 10 until the next
      // parsed turn-start.
      const midTurnDeliver = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [11],
        kind: 'message',
        text: 'second message arriving mid-turn',
        delivered_up_to_seq: 11,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(midTurnDeliver).toMatchObject({ disposition: 'admitted' });
      await waitForDeliveryConsumed(spy.events, 11);

      // Delivery custody unchanged — both consumed events fire even though
      // only M1 advanced the model-seen cursor. Cindy: the fix only moves
      // observed-cursor timing; DB ack/`delivered_at` contract stays.
      const consumedIds = spy.events
        .flatMap(e =>
          e.event === 'runtime_delivery_consumed' ? [...e.delivery_ids] : [],
        )
        .sort((a, b) => a - b);
      expect(consumedIds).toEqual([10, 11]);

      // ── Mid-turn agent send. seen_up_to_seq must be 10 (M1 only), not 11.
      // Before the #task:1471 fix this was 11 → the regression.
      const midTurnSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'draft reply generated on M1 context',
      });
      expect(midTurnSend).toMatchObject({ ok: true });
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(10);
      expect(postedBodies[0]?.['stream_key']).toBe('main');

      // ── Turn boundary: parsed turn_end → resolveRun clears
      // inputTurnActive. Then a parsed thinking event (parsedStartsTurn=true)
      // triggers admitPendingSeqForNewTurn, promoting the queued M2 (11)
      // from pendingAdmissionSeqByStream into observedSeqByStream.
      driver.parseLine = () => [{ kind: 'turn_end' }];
      stub.stdout.emit('data', 'END\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'turn_end',
        ),
      );
      driver.parseLine = () => [
        { kind: 'thinking', text: 'starting next turn' },
      ];
      stub.stdout.emit('data', 'THINK\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'thinking',
        ),
      );
      driver.parseLine = () => [];

      // ── Next-turn send: pending was promoted, so seen now covers M2.
      // Guards against the sibling regression where the fix could over-
      // correct into "never admit" — must actually promote here.
      const nextTurnSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'reply generated on new turn context',
      });
      expect(nextTurnSend).toMatchObject({ ok: true });
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(11);
      expect(postedBodies[1]?.['stream_key']).toBe('main');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('gated driver — mid-turn deferred flush at tool_output boundary keeps observed at the pre-turn seq (countgame1 claude path)', async () => {
    // INVARIANTS (Cindy — do not weaken):
    //   1. Old-turn send must trigger a REAL 409 from the backend. The
    //      mock CAS on `seen_up_to_seq < BACKEND_CURRENT_SEQ` is
    //      load-bearing — reverting to unconditional 409 (or 200) turns
    //      this into an error-handling test and drops the *production
    //      condition* the regression bypassed.
    //   2. `delivery-consumed != model-seen`: both M1+M2 fire
    //      runtime_delivery_consumed, but only M1 advances observed
    //      until the next parsed turn-start.
    //   3. The boundary-gated profile is intentional. Reverting to the
    //      default `direct` picks a different consumeStartupDelivery
    //      entry and no longer exercises the deferred-queue path that
    //      broke countgame1.
    // The countgame1 regression path (boundary-gated profile):
    //   1. M1 delivered idle → SPAWN arm admits → observed=10, inputTurnActive=true
    //   2. Model emits tool_call → busy.outstandingToolUses=1 → boundary closed
    //   3. M2 delivered mid-tool_call → gated && !boundaryOpen → `deferred`
    //   4. Model emits tool_output → outstandingToolUses=0 → boundary reopens
    //      → maybeScheduleDeferredFlush → flushDeferred → consumeStartupDelivery
    //   5. HERE: inputTurnActive still true (no turn_end fired). Pre-fix
    //      unconditional admit at :1692 bumped observed to 11 before the
    //      model's in-turn `agentMessageSend`; the send then reported
    //      seen=11 for a message the model never saw. Fix routes to
    //      pending admission until the next parsed turn-start.
    class ControlledStub extends EventEmitter {
      readonly pid = 45_678;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (
          _line: string,
          cb?: (err?: Error | null) => void,
        ): boolean => {
          setImmediate(() => cb?.());
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

    const { driver: baseDriver } = makeProgrammableDriver([], 'self_inits');
    // Real claude driver is `gated` (tests/../drivers/claude.ts). The default
    // fake is `direct`; override so this test exercises the actual
    // countgame1 code path (deferred queue + boundary-reopen flush).
    // #1471's invariant (mid-turn writes must not advance observed
    // before turn-start) lives on tool-boundary-steer in the final
    // tree — the only profile that writes during an active turn.
    const driver: Driver = { ...baseDriver, releaseProfile: 'tool-boundary-steer' };
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn,
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      emitRawRuntimeOutput: true,
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    const postedBodies: Record<string, unknown>[] = [];
    // 409-aware mock: the backend's authoritative main-line seq after M1+M2
    // deliver is 11. A send with `seen_up_to_seq < 11` is stale under the
    // per-stream CAS; the backend returns 409 with `subkind='message_stale'`.
    // A revised retry (or any send with seen>=11) settles at 200. This is
    // the correctness gate the #task:1417 regression bypassed: mid-turn
    // deliveries bumped observed to 11 before the model's in-turn send,
    // so `seen_up_to_seq=11` slipped past CAS and never staled.
    const BACKEND_CURRENT_SEQ = 11;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(body);
        const seen = body['seen_up_to_seq'];
        if (typeof seen === 'number' && seen < BACKEND_CURRENT_SEQ) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: `stale-${postedBodies.length}`,
                  seen_up_to_seq: seen,
                  current_seq: BACKEND_CURRENT_SEQ,
                  newer_messages: [],
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ message_id: `m${postedBodies.length}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    try {
      // ── M1: SPAWN arm — startup admit, observed=10, inputTurnActive=true.
      const spawnResult = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [10],
        kind: 'message',
        text: 'first message (spawn batch)',
        delivered_up_to_seq: 10,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(spawnResult).toMatchObject({ disposition: 'spawning' });
      await waitForDeliveryConsumed(spy.events, 10);

      // ── Model enters a tool_call — boundary closes (outstandingToolUses=1).
      driver.parseLine = () => [
        { kind: 'tool_call', name: 'Bash', input: {} },
      ];
      stub.stdout.emit('data', 'TOOL\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'tool_call',
        ),
      );

      // ── M2 delivered mid-tool_call — tool-boundary-steer writes
      // IMMEDIATELY (B'); the admission decision (turn active → pending)
      // is the invariant under test in step 5.
      driver.parseLine = () => [];
      const midToolCallDeliver = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [11],
        kind: 'message',
        text: 'second message arriving mid tool_call',
        delivered_up_to_seq: 11,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(midToolCallDeliver).toMatchObject({ disposition: 'admitted' });
      await waitForDeliveryConsumed(spy.events, 11);

      // ── tool_output resolves; the model keeps working the same turn.
      driver.parseLine = () => [{ kind: 'tool_output', name: 'Bash' }];
      stub.stdout.emit('data', 'TOOL_OUT\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'tool_output',
        ),
      );
      driver.parseLine = () => [];

      // Custody unchanged: consumed for both, direct/gated alike.
      const consumedIds = spy.events
        .flatMap(e =>
          e.event === 'runtime_delivery_consumed' ? [...e.delivery_ids] : [],
        )
        .sort((a, b) => a - b);
      expect(consumedIds).toEqual([10, 11]);

      // ── In-turn agent send after the deferred flush. This is the exact
      // countgame1 06:08 moment: tool_output just resolved, model generates
      // its reply, calls message_send with a `seen_up_to_seq` that reflects
      // ONLY M1 context. With the fix, observed is still 10 (M2 sits in
      // pending), so the send body carries seen=10 and the backend's CAS
      // fires 409 message_stale — the correctness gate the regression
      // silently bypassed. Pre-fix, seen would be 11 and the send would
      // slip past CAS with 200 (the countgame1 turn-taking break).
      const midTurnSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'draft reply generated on M1 context after tool_output',
      });
      expect(midTurnSend).toMatchObject({ ok: false, status: 409 });
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(10);

      // ── Turn boundary + revised retry. Once the model surfaces
      // turn_end and a new turn-start (`thinking`), pending is folded into
      // observed via `admitPendingSeqForNewTurn`. In this test 409's own
      // `message_stale_response` observed-advance already reached seq=11,
      // so promotion is a monotonic no-op (proven separately by the
      // direct-mode test above); the point here is that the next send
      // carries the freshened boundary and the 409 gate no longer fires.
      driver.parseLine = () => [{ kind: 'turn_end' }];
      stub.stdout.emit('data', 'END\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'turn_end',
        ),
      );
      driver.parseLine = () => [
        { kind: 'thinking', text: 'starting next turn' },
      ];
      stub.stdout.emit('data', 'THINK\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'thinking',
        ),
      );
      driver.parseLine = () => [];

      const nextTurnSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'revised reply on refreshed context',
        stale_resolution_reason: 'revised',
      });
      expect(nextTurnSend).toMatchObject({ ok: true });
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(11);
      expect(postedBodies[1]?.['stale_event_id']).toBe('stale-1');
      expect(postedBodies[1]?.['stale_resolution_reason']).toBe('revised');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('snapshots admit decision BEFORE writeStdinPayload so a turn_end interleaving the write cannot bypass the pending gate', async () => {
    // INVARIANTS (do not weaken):
    //   1. The admission decision (admit-now vs queue-to-pending) must
    //      be bound BEFORE any async boundary that can interleave with
    //      `turn_end`. The current implementation achieves this by
    //      snapshotting `admitNow = shouldAdmitDeliveryImmediately(handle)`
    //      before `await this.writeStdinPayload(...)` in
    //      consumeStartupDelivery; a later serialisation or atomic
    //      state-machine rewrite is fine so long as the decision
    //      remains bound to the turn state at the moment the batch was
    //      chosen — post-await re-reads reintroduce the regression.
    //   2. The test must preserve a deterministic barrier proving the
    //      write can be in-flight while `turn_end` crosses it. The
    //      current fixture uses `parkWrites` + `resolveParkedWrite()`
    //      to make the interleaving reliable; refactor the fixture
    //      freely, but do NOT fall back to probabilistic timing
    //      (setImmediate / setTimeout scheduling doesn't hold the
    //      write callback long enough for `dispatchParsedLine` — which
    //      runs synchronously from the stdout listener, unlocked — to
    //      reliably interleave a `turn_end` line).
    //   3. The 409 assertion on `postedBodies[0]['seen_up_to_seq'] ===
    //      10` is the proof point that the decision honoured the
    //      pre-boundary turn state. Weakening it to `<= 11` allows the
    //      regression through.
    // Race window (Cindy): `dispatchParsedLine` runs synchronously from the
    // child stdout listener and is NOT under this handle's lifecycle lock.
    // So while `consumeStartupDelivery` is awaiting `writeStdinPayload`, a
    // `turn_end` line on stdout can be processed and flip
    // `inputTurnActive=false` before the write callback fires. A post-await
    // read of `shouldAdmitDeliveryImmediately(handle)` would then admit
    // immediately — even though this batch was decided upon and started
    // being written while the prior turn was still active. Correct
    // semantics: snapshot the decision BEFORE the write, matching the
    // pre-#task:1417 `runtime_wake` invariant.
    class ControlledStub extends EventEmitter {
      readonly pid = 56_789;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      parkWrites = false;
      pendingWriteCb: ((err?: Error | null) => void) | null = null;
      readonly stdin = {
        write: (
          _line: string,
          cb?: (err?: Error | null) => void,
        ): boolean => {
          if (this.parkWrites) {
            // Park the callback; the test resolves it manually after
            // interleaving a `turn_end` stdout line so we can prove the
            // decision is taken pre-await, not post-await.
            this.pendingWriteCb = cb ?? null;
          } else {
            setImmediate(() => cb?.());
          }
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      resolveParkedWrite(): void {
        const cb = this.pendingWriteCb;
        this.pendingWriteCb = null;
        cb?.();
      }
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

    const { driver: baseDriver } = makeProgrammableDriver([], 'self_inits');
    // #1471's invariant (mid-turn writes must not advance observed
    // before turn-start) lives on tool-boundary-steer in the final
    // tree — the only profile that writes during an active turn.
    const driver: Driver = { ...baseDriver, releaseProfile: 'tool-boundary-steer' };
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn,
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      emitRawRuntimeOutput: true,
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });

    const postedBodies: Record<string, unknown>[] = [];
    const BACKEND_CURRENT_SEQ = 11;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(body);
        const seen = body['seen_up_to_seq'];
        if (typeof seen === 'number' && seen < BACKEND_CURRENT_SEQ) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'conflict',
                message: 'message stale',
                details: {
                  subkind: 'message_stale',
                  conversation_id: 'c1',
                  stale_event_id: `stale-${postedBodies.length}`,
                  seen_up_to_seq: seen,
                  current_seq: BACKEND_CURRENT_SEQ,
                  newer_messages: [],
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ message_id: `m${postedBodies.length}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    try {
      // ── Setup identical to the countgame1 gated test, up to M2 deferred.
      const spawnResult = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [10],
        kind: 'message',
        text: 'first message',
        delivered_up_to_seq: 10,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(spawnResult).toMatchObject({ disposition: 'spawning' });
      await waitForDeliveryConsumed(spy.events, 10);

      driver.parseLine = () => [
        { kind: 'tool_call', name: 'Bash', input: {} },
      ];
      stub.stdout.emit('data', 'TOOL\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'tool_call',
        ),
      );

      // ── Race sequencing. Park M2's write BEFORE delivering, so the
      // immediate tool-boundary-steer write is captured in flight; then
      // interleave turn_end so `resolveRun` flips inputTurnActive=false
      // WHILE the write's promise is still awaiting. Pre-fix: a
      // post-await read of `shouldAdmitDeliveryImmediately(handle)`
      // would return true (turn just ended) → admit immediately →
      // observed=11 → send seen=11, no 409. With the pre-await
      // snapshot: decision taken as false (turn active) → pending →
      // observed stays 10 → send seen=10, 409.
      driver.parseLine = () => [];
      stub.parkWrites = true;
      const midToolCallDeliver = await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [11],
        kind: 'message',
        text: 'second message arriving mid tool_call',
        delivered_up_to_seq: 11,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      expect(midToolCallDeliver).toMatchObject({ disposition: 'admitted' });
      // The write is genuinely in flight before we interleave turn_end.
      await waitFor(() => stub.pendingWriteCb !== null, 1_000);

      driver.parseLine = () => [{ kind: 'turn_end' }];
      stub.stdout.emit('data', 'END\n');
      await waitFor(() =>
        spy.events.some(
          e =>
            e.event === 'runtime_parsed_event' &&
            e.parsed.kind === 'turn_end',
        ),
      );

      // Only NOW release the write. consumeStartupDelivery resumes; the
      // fixed code applies the pre-await snapshot (admitNow=false) and
      // routes M2 into pending. Without the fix it would read live state
      // (post-turn_end, admitNow=true) and admit immediately.
      driver.parseLine = () => [];
      stub.parkWrites = false;
      stub.resolveParkedWrite();
      await waitForDeliveryConsumed(spy.events, 11);

      // Custody still per-delivery regardless of the race timing.
      const consumedIds = spy.events
        .flatMap(e =>
          e.event === 'runtime_delivery_consumed' ? [...e.delivery_ids] : [],
        )
        .sort((a, b) => a - b);
      expect(consumedIds).toEqual([10, 11]);

      // The proof: an in-turn send generated before the turn boundary was
      // observed by the model must still stale. Backend returns 409
      // because seen=10 < BACKEND_CURRENT_SEQ=11.
      const raceSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'draft reply raced against turn_end',
      });
      expect(raceSend).toMatchObject({ ok: false, status: 409 });
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(10);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });
});

describe('Supervisor — per-stream observed boundary (reply-cluster §6.4)', () => {
  it('sends a bare reply to the channel main line even after a thread-only wake', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(parsedBody);
        return new Response(
          JSON.stringify({
            message_id: 'm54',
            message_seq: 54,
            thread_root_id: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [52, 53],
        kind: 'message',
        text: 'thread turn batch',
        delivered_up_to_seq: 53,
        deliveries: [
          {
            delivery_id: 52,
            message_id: 'm52',
            seq: 52,
            thread_root_id: 'mRoot',
            delivery_kind: 'turn',
          },
          {
            delivery_id: 53,
            message_id: 'm53',
            seq: 53,
            thread_root_id: 'mRoot',
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
      await waitForDeliveryConsumed(events, 53);

      const result = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'plain reply defaults to the channel main line',
      });

      // A thread-only wake no longer captures the reply target: a bare send
      // resolves to the channel main line. Main was never observed in this
      // session, so it is a first-touch send with no per-stream freshness.
      expect(result).toMatchObject({ ok: true, message_id: 'm54' });
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'channel' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]).not.toHaveProperty('stream_key');
      expect(postedBodies[0]).not.toHaveProperty('seen_up_to_seq');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('sends an explicit main-line target to the channel even after a thread-only wake', async () => {
    const { supervisor } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(parsedBody);
        return new Response(
          JSON.stringify({
            message_id: 'm54',
            message_seq: 54,
            thread_root_id: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [53],
        kind: 'message',
        text: 'thread turn',
        delivered_up_to_seq: 53,
        deliveries: [
          {
            delivery_id: 53,
            message_id: 'm53',
            seq: 53,
            thread_root_id: 'mRoot',
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      const result = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'explicit main-line reply',
        target: { kind: 'channel' },
      });

      expect(result).toMatchObject({ ok: true, message_id: 'm54' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'channel' });
      // Main was never observed in this daemon session. Treat it as a
      // first-touch send and omit per-stream freshness instead of turning the
      // missing boundary into seen=0 (which would stale against seq 1..N).
      expect(postedBodies[0]).not.toHaveProperty('stream_key');
      expect(postedBodies[0]).not.toHaveProperty('seen_up_to_seq');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('omits freshness for a bare main-line first-touch send', async () => {
    const { supervisor } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    let nextSeq = 50;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            message_id: `m${nextSeq}`,
            message_seq: nextSeq++,
            thread_root_id: null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);

      const first = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'first main-line send without observed main',
      });
      const second = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'second main-line send still has not observed main',
      });

      expect(first).toMatchObject({ ok: true, message_id: 'm50' });
      expect(second).toMatchObject({ ok: true, message_id: 'm51' });
      expect(postedBodies).toHaveLength(2);
      for (const body of postedBodies) {
        expect(body['target']).toEqual({ kind: 'channel' });
        expect(body).not.toHaveProperty('reply_to_message_id');
        expect(body).not.toHaveProperty('stream_key');
        expect(body).not.toHaveProperty('seen_up_to_seq');
      }
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('defaults a bare send to the channel main line across mixed and observe-only wakes', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(parsedBody);
        const target = parsedBody['target'];
        return new Response(
          JSON.stringify({
            message_id: `m${60 + postedBodies.length}`,
            message_seq: 60 + postedBodies.length,
            thread_root_id:
              target &&
              typeof target === 'object' &&
              'kind' in target &&
              target.kind === 'thread'
                ? 'mRoot'
                : null,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [50, 51],
        kind: 'message',
        text: 'mixed main + thread turn batch',
        delivered_up_to_seq: 51,
        deliveries: [
          {
            delivery_id: 50,
            message_id: 'mMain',
            seq: 50,
            thread_root_id: null,
            delivery_kind: 'turn',
          },
          {
            delivery_id: 51,
            message_id: 'm51',
            seq: 51,
            thread_root_id: 'mRoot',
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      await waitForDeliveryConsumed(events, 51);
      await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'mixed batch still defaults to the channel main line',
      });
      // The thread member of a mixed wake no longer captures the default; the
      // bare send goes to the main line, carrying the main boundary this batch
      // observed (seq 50).
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'channel' });
      expect(postedBodies[0]?.['stream_key']).toBe('main');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(50);

      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
      postedBodies.length = 0;

      await supervisor.start(baseStartParams);
      await waitFor(
        () =>
          events.filter(
            e => e.event === 'runtime_output' && e.chunk.includes('READY'),
          ).length >= 2,
      );
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [52],
        kind: 'message',
        text: 'observe-only thread batch',
        delivered_up_to_seq: 52,
        deliveries: [
          {
            delivery_id: 52,
            message_id: 'm52',
            seq: 52,
            thread_root_id: 'mRoot',
            delivery_kind: 'observe',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      await waitForDeliveryConsumed(events, 52);
      await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'observe-only batch defaults to main',
      });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'channel' });
      expect(postedBodies[0]).not.toHaveProperty('stream_key');
      expect(postedBodies[0]).not.toHaveProperty('seen_up_to_seq');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('sends a bare reply to the channel main line even when the turn received multiple thread streams', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ message_id: 'm83', message_seq: 83, thread_root_id: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [80, 81, 82],
        kind: 'message',
        text: 'two thread streams plus main',
        delivered_up_to_seq: 82,
        deliveries: [
          {
            delivery_id: 80,
            message_id: 'mMain',
            seq: 80,
            thread_root_id: null,
            delivery_kind: 'turn',
          },
          {
            delivery_id: 81,
            message_id: 'mA',
            seq: 81,
            thread_root_id: 'rootA',
            delivery_kind: 'turn',
          },
          {
            delivery_id: 82,
            message_id: 'mB',
            seq: 82,
            thread_root_id: 'rootB',
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      await waitForDeliveryConsumed(events, 82);
      // Multiple thread streams in one turn no longer make a bare send
      // ambiguous: it resolves to the channel main line and carries the main
      // boundary this batch observed (seq 80). No 422 / candidate_targets.
      const result = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'bare reply defaults to the channel main line',
      });

      expect(result).toMatchObject({ ok: true, message_id: 'm83' });
      expect(postedBodies).toHaveLength(1);
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'channel' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['stream_key']).toBe('main');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(80);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('keeps main and thread observed boundaries independent and picks the reply target stream seen', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    let nextSeq = 51;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        postedBodies.push(parsedBody);
        const seq = nextSeq++;
        // Echo a resolved root for reply sends; main-line sends carry null.
        const target = parsedBody['target'];
        const replyTo =
          target
          && typeof target === 'object'
          && 'kind' in target
          && target.kind === 'thread'
          && 'message_id' in target
          && typeof target.message_id === 'string'
            ? target.message_id
            : undefined;
        const threadRootId =
          typeof replyTo === 'string'
            ? replyTo === 'm51'
              ? 'mRoot'
              : replyTo
            : null;
        return new Response(
          JSON.stringify({
            message_id: `m${seq}`,
            message_seq: seq,
            thread_root_id: threadRootId,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      // A main-line delivery (mRoot @ seq 50) — advances observed[main]
      // and teaches the daemon that a reply to mRoot opens thread:mRoot.
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [50],
        kind: 'message',
        text: 'root message',
        delivered_up_to_seq: 50,
        deliveries: [
          {
            delivery_id: 50,
            message_id: 'mRoot',
            seq: 50,
            thread_root_id: null,
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      await waitForDeliveryConsumed(events, 50);
      // First reply to mRoot: thread:mRoot has never been observed → seen 0.
      const reply1 = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'first reply',
        target: { kind: 'thread', message_id: 'mRoot' },
      });
      expect(reply1).toMatchObject({ ok: true, message_id: 'm51' });
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'thread', message_id: 'mRoot' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['stream_key']).toBe('thread:mRoot');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(0);

      // A reply to our own reply (m51) joins the same root; observed
      // [thread:mRoot] was advanced to 51 by the prior send, independent
      // of observed[main]=50.
      const reply2 = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'second reply',
        target: { kind: 'thread', message_id: 'm51' },
      });
      expect(reply2).toMatchObject({ ok: true });
      expect(postedBodies[1]?.['target']).toEqual({ kind: 'thread', message_id: 'm51' });
      expect(postedBodies[1]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[1]?.['stream_key']).toBe('thread:mRoot');
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(51);

      // A main-line send still sees the main boundary (50), untouched by
      // the thread sends.
      const mainSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'main line',
      });
      expect(mainSend).toMatchObject({ ok: true });
      expect(postedBodies[2]?.['target']).toEqual({ kind: 'channel' });
      expect(postedBodies[2]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[2]?.['stream_key']).toBe('main');
      expect(postedBodies[2]?.['seen_up_to_seq']).toBe(50);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('omits seen+stream_key for an unknown reply target (Case A loose) and never advances observed', async () => {
    const { supervisor } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            message_id: 'm77',
            message_seq: 77,
            thread_root_id: 'mGhost',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      const result = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'reply to a message I never saw',
        target: { kind: 'thread', message_id: 'mGhost' },
      });
      expect(result).toMatchObject({ ok: true, message_id: 'm77' });
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'thread', message_id: 'mGhost' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]).not.toHaveProperty('seen_up_to_seq');
      expect(postedBodies[0]).not.toHaveProperty('stream_key');

      // The success taught the daemon mGhost's stream → a follow-up reply
      // is now known and carries seen 0 (observed was never advanced).
      const followup = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'follow-up reply',
        target: { kind: 'thread', message_id: 'mGhost' },
      });
      expect(followup).toMatchObject({ ok: true });
      expect(postedBodies[1]?.['target']).toEqual({ kind: 'thread', message_id: 'mGhost' });
      expect(postedBodies[1]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[1]?.['stream_key']).toBe('thread:mGhost');
      expect(postedBodies[1]?.['seen_up_to_seq']).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('records a pulled cluster boundary (agent_stream_observed) so a later reply-to carries seen=maxSeq', async () => {
    const { supervisor } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ message_id: 'm99', message_seq: 99, thread_root_id: 'mRoot' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      // The agent ran `history --target thread:mRoot` over plain HTTP (the
      // daemon never saw it) and the CLI fired this intent: replies up to
      // seq 60 were observed; root + reply ids surfaced.
      const observed = await supervisor.agentStreamObserved({
        conversation_id: 'c1',
        agent_id: 'a1',
        thread_root_id: 'mRoot',
        observed_seq: 60,
        reply_target_messages: ['mRoot', 'm55', 'm60'],
      });
      expect(observed).toEqual({ ok: true });

      // Reply to the root → known stream thread:mRoot, seen = the pulled max.
      const reply = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'late reply after reading',
        target: { kind: 'thread', message_id: 'mRoot' },
      });
      expect(reply).toMatchObject({ ok: true });
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'thread', message_id: 'mRoot' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['stream_key']).toBe('thread:mRoot');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(60);

      // A surfaced reply id maps to the same stream (root + replies all known).
      await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'reply to a surfaced reply',
        target: { kind: 'thread', message_id: 'm60' },
      });
      expect(postedBodies[1]?.['target']).toEqual({ kind: 'thread', message_id: 'm60' });
      expect(postedBodies[1]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[1]?.['stream_key']).toBe('thread:mRoot');
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('makes a reply-to-root known with seen=0 after observing a cluster that has no replies', async () => {
    const { supervisor } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ message_id: 'm12', message_seq: 12, thread_root_id: 'mLone' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      // Pulled a cluster with only the root (no replies yet): observed_seq 0,
      // root id surfaced.
      const observed = await supervisor.agentStreamObserved({
        conversation_id: 'c1',
        agent_id: 'a1',
        thread_root_id: 'mLone',
        observed_seq: 0,
        reply_target_messages: ['mLone'],
      });
      expect(observed).toEqual({ ok: true });

      // First reply to the root: known stream (the mapping made it known) and
      // seen 0 (no replies were observed) — exactly the freshness the backend
      // CAS expects for a thread's first reply.
      const reply = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'first reply to a freshly read root',
        target: { kind: 'thread', message_id: 'mLone' },
      });
      expect(reply).toMatchObject({ ok: true });
      expect(postedBodies[0]?.['target']).toEqual({ kind: 'thread', message_id: 'mLone' });
      expect(postedBodies[0]).not.toHaveProperty('reply_to_message_id');
      expect(postedBodies[0]?.['stream_key']).toBe('thread:mLone');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('does not advance the main observed boundary when a thread cluster is pulled', async () => {
    const { supervisor, events } = makeSupervisor();
    const postedBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        postedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ message_id: 'm51', message_seq: 51, thread_root_id: null }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    try {
      await supervisor.start(baseStartParams);
      // A main-line delivery advances observed[main] = 50.
      await waitForRuntimeReady(events);
      await supervisor.deliver({
        conversation_id: 'c1',
        agent_id: 'a1',
        delivery_ids: [50],
        kind: 'message',
        text: 'main message',
        delivered_up_to_seq: 50,
        deliveries: [
          {
            delivery_id: 50,
            message_id: 'mMain',
            seq: 50,
            thread_root_id: null,
            delivery_kind: 'turn',
          },
        ],
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

      await waitForDeliveryConsumed(events, 50);
      // Pulling a thread cluster up to seq 80 must touch ONLY thread:mRoot —
      // never main (the pull saw one root, not the whole main prefix to 80).
      await supervisor.agentStreamObserved({
        conversation_id: 'c1',
        agent_id: 'a1',
        thread_root_id: 'mRoot',
        observed_seq: 80,
        reply_target_messages: ['mRoot'],
      });

      const mainSend = await supervisor.agentMessageSend({
        conversation_id: 'c1',
        agent_id: 'a1',
        content: 'main line send',
      });
      expect(mainSend).toMatchObject({ ok: true });
      expect(postedBodies[0]?.['stream_key']).toBe('main');
      expect(postedBodies[0]?.['seen_up_to_seq']).toBe(50);
    } finally {
      vi.unstubAllGlobals();
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });

  it('hard-rejects a deliver whose deliveries[] id-set does not match delivery_ids', async () => {
    const { supervisor } = makeSupervisor();
    try {
      await supervisor.start(baseStartParams);
      await expect(
        supervisor.deliver({
          conversation_id: 'c1',
          agent_id: 'a1',
          delivery_ids: [1, 2],
          kind: 'message',
          text: 'mismatched batch',
          delivered_up_to_seq: 2,
          deliveries: [
            {
              delivery_id: 1,
              message_id: 'm1',
              seq: 1,
              thread_root_id: null,
              delivery_kind: 'turn',
            },
          ],
          spawn_options: baseStartParams.options,
        }, { owner: 'test-owner' }),
      ).rejects.toThrow(/delivery metadata mismatch/);
    } finally {
      await supervisor.stop({
        conversation_id: 'c1',
        agent_id: 'a1',
        mode: 'hard',
      }).catch(() => undefined);
    }
  });
});

describe('Supervisor Stage 2 — runtime_deliver (#task:1417)', () => {
  it('SPAWN arm: no live handle → spawns with the batch as startup delivery, returns spawning, and settles onto the UNIFIED runtime_delivery_consumed', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [7, 8],
      kind: 'message',
      text: 'boot via deliver',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res.disposition).toBe('spawning');
    if (res.disposition !== 'spawning') throw new Error('unreachable');
    expect(typeof res.pid).toBe('number');
    expect(typeof res.started_at).toBe('number');

    // The daemon wrote the batch to stdin (fixture echoes it back).
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('STDIN:{"type":"user"'),
      ),
    );
    // Custody is ack'd on the UNIFIED family, keyed by delivery_ids.
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_delivery_consumed' &&
          e.delivery_ids.length === 2 &&
          e.delivery_ids[0] === 7 &&
          e.delivery_ids[1] === 8,
      ),
    );

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('WRITE arm: ready handle → encodes+writes stdin, returns admitted, settles onto runtime_delivery_consumed', async () => {
    const { supervisor, events } = makeSupervisor({
      driverArgs: ['--echo-stdin'],
    });
    // Bare start (no batch) → the legacy startup family is never used.
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e => e.event === 'runtime_output' && e.chunk.includes('READY'),
      ),
    );
    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [42],
      kind: 'message',
      text: 'live deliver',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res.disposition).toBe('admitted');
    if (res.disposition !== 'admitted') throw new Error('unreachable');
    expect(typeof res.pid).toBe('number');

    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_output' &&
          e.chunk.includes('STDIN:{"type":"user"'),
      ),
    );
    await waitFor(() =>
      events.some(
        e =>
          e.event === 'runtime_delivery_consumed' &&
          e.delivery_ids.length === 1 &&
          e.delivery_ids[0] === 42,
      ),
    );

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('REFUSE arm: startup batch still in flight → refused startup_pending, no ready_for_drain (step-0 mutex)', async () => {
    // Same pinned-gate technique as the delivery step-0 test: a stdin stub
    // whose write callback never fires keeps consumeStartupDelivery
    // hung, so `startupDelivery !== null` stays true.
    class HungStdinStub extends EventEmitter {
      readonly pid = 22_345;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (
          _line: string,
          _cb?: (err?: Error | null) => void,
        ): boolean => true,
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
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
    // Put a batch in flight via the deliver SPAWN arm; the hung stdin
    // stub keeps consumeStartupDelivery from settling, so
    // `startupDelivery !== null` stays true.
    await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1, 2],
      kind: 'message',
      text: 'boot',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [99],
      kind: 'message',
      text: 'race',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res).toEqual({ disposition: 'refused', reason: 'startup_pending' });
    expect(events.some(e => e.event === 'runtime_ready_for_drain')).toBe(false);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('REFUSE arm: handle stuck draining (SIGKILL-timeout safety net) → refused draining', async () => {
    // `deliver()` holds the per-(conv,agent) lifecycle lock, and every
    // normal stop path holds it until the child exits — so a deliver
    // racing a hard stop simply serializes behind it and respawns. The
    // ONE way a live handle sits in `draining` with the lock free is the
    // SIGKILL-timeout safety net: the child ignores both signals, so
    // `hardStopHandle` resolves stop() (stopped:false) and releases the
    // lock while `phase` is still `draining`. A stub whose `kill()`
    // never emits `exit` reproduces that window deterministically.
    class NoExitStub extends EventEmitter {
      readonly pid = 32_345;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      readonly stdin = {
        write: (_line: string, cb?: (err?: Error | null) => void): boolean => {
          cb?.();
          return true;
        },
        end: () => {},
        destroyed: false,
        once: () => {},
      };
      kill(_sig?: NodeJS.Signals | number): boolean {
        return true; // never emits 'exit' → forces the safety-net path
      }
    }
    const stub = new NoExitStub();
    const spawnFn = (
      _b: string,
      _a: ReadonlyArray<string>,
      _o: SpawnOptions,
    ): ChildProcess => stub as unknown as ChildProcess;
    const { supervisor } = makeSupervisor({
      spawnFn,
      sigtermToSigkillMs: 10,
      sigkillTimeoutMs: 20,
    });
    await supervisor.start(baseStartParams);
    // Let the optimistic setImmediate flip the handle to `ready`.
    await wait(5);
    const stopRes = await supervisor.stop({
      conversation_id: 'c1',
      agent_id: 'a1',
      mode: 'hard',
    });
    // Safety net resolved without a real exit — handle stays draining.
    expect(stopRes).toEqual({ mode: 'hard', stopped: false, exit_code: null });
    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [5],
      kind: 'message',
      text: 'during drain',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(res).toEqual({ disposition: 'refused', reason: 'draining' });
  });

  it('REFUSE arm: live oneShot handle → refused startup_pending SYNC, never admitted→driver_refused (#task:1417 Stage 2b, Cindy review #2)', async () => {
    // A live oneShot (cursor) can never take a stdin delivery — it drains
    // its inbox only at spawn time. Before the fix, a ready oneShot fell
    // through to the WRITE arm (its `encodeStdinMessage` returns null and it
    // has no `readyToEncode`, so `driverReadyToEncode` defaults true),
    // returning `admitted` then emitting an async `driver_refused` — a code
    // reserved for a genuine driver programming error. The fix makes the
    // daemon refuse SYNC on `handle.driver.oneShot`, so the backend rolls
    // the rows back to pending and the oneShot drains on its next
    // exit→respawn.
    const oneShotDriver: Driver = {
      kind: 'cursor',
      binary: FIXTURE,
      kickoffMode: 'self_inits',
      releaseProfile: 'one-shot',
      oneShot: true,
      supportsNativeStandingPrompt: false,
      initLivenessSilenceMs: 30_000,
      initPreProtocolCapMs: 5 * 60_000,
      initPostProtocolMs: 60_000,
      buildArgs: () => [FIXTURE, '--echo-stdin'],
      applyEnv: env => ({ ...env }),
      encodeStdinMessage: () => null,
      encodeInterruptControl: () => null,
      parseLine: () => [],
      classifyInitProgress: () => null,
    };
    const { supervisor, events } = makeSupervisorWithDriver(oneShotDriver);
    // Bare start (no batch) → the handle comes up live and reaches ready.
    await supervisor.start(baseStartParams);
    await waitFor(() =>
      events.some(
        e => e.event === 'runtime_output' && e.chunk.includes('READY'),
      ),
    );

    const res = await supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [77],
      kind: 'message',
      text: 'to a live oneShot',
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });

    expect(res).toEqual({ disposition: 'refused', reason: 'startup_pending' });
    // SYNC refuse — no admit, no delivery ack, and crucially no async
    // driver_refused failure emitted for this delivery.
    await wait(20);
    expect(
      events.some(
        e => e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(77),
      ),
    ).toBe(false);
    expect(
      events.some(
        e =>
          e.event === 'runtime_delivery_failed' &&
          e.delivery_ids.includes(77) &&
          e.reason === 'driver_refused',
      ),
    ).toBe(false);

    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

// ── #task:1417 Stage 3 — daemon-side mid-turn deferred queue ──────────
//
// The mid-turn queue lives in the daemon now. These tests drive a fully
// controlled stub child so the deliver/defer/flush sequence is
// deterministic: we choose exactly what `parseLine` returns for each
// stdout line, and await each `deliver()` before emitting the next line.
//
// Gates (Cindy):
//   1. `deferred` covers only a READY handle that can't take the write now
//      (mid-turn `gated`, or a prior write in flight) — not startup/oneShot.
//   2. `deferred` is a custody transfer, NOT an ack: no consumed/failed at
//      defer time.
//   3. a `direct` flush is FIFO one-at-a-time and NEVER combines.
//   4. a `gated` flush drains the WHOLE queue and combines into ONE write /
//      ONE consumed.
//   5. owner-scoped cleanup discards only the dropped connection's entries.
describe('Supervisor Stage 3 — daemon mid-turn deferred queue', () => {
  /** A stub child whose stdin.write settles on setImmediate, so a
   *  write-in-flight window is observable, and whose stdout we drive by
   *  hand. `kill` resolves the exit promptly for cleanup. Written lines
   *  are captured; `parkWrites` holds a write's completion callback until
   *  `resolveParkedWrite` so a test can interleave parses inside the
   *  write await window (#task:1563 P1-2 falsifier). */
  class DriveStub extends EventEmitter {
    readonly pid = 55_555;
    readonly stdout = new EventEmitter();
    readonly stderr = new EventEmitter();
    readonly written: string[] = [];
    parkWrites = false;
    pendingWriteCb: ((err?: Error | null) => void) | null = null;
    readonly stdin = {
      write: (line: string, cb?: (err?: Error | null) => void): boolean => {
        this.written.push(line);
        if (this.parkWrites) {
          this.pendingWriteCb = cb ?? null;
          return true;
        }
        setImmediate(() => cb?.());
        return true;
      },
      end: () => {},
      destroyed: false,
      once: () => {},
    };
    resolveParkedWrite(): void {
      const cb = this.pendingWriteCb;
      this.pendingWriteCb = null;
      cb?.();
    }
    kill(_sig?: NodeJS.Signals | number): boolean {
      setImmediate(() => this.emit('exit', 0, null));
      return true;
    }
  }

  function makeDriven(
    mode: 'gated' | 'direct',
    profile?: Driver['releaseProfile'],
    logger?: DaemonLogger,
    opts: { reservationStallWarnMs?: number; parkFirstWrite?: boolean } = {},
  ) {
    // Fresh stub per spawn: a respawn on the SAME emitter would leave the
    // dead handle's stdout listener attached and double-consume nextParse.
    let stub = new DriveStub();
    if (opts.parkFirstWrite) stub.parkWrites = true;
    const base = makeProgrammableDriver(
      [],
      mode === 'gated' ? 'requires_first_message' : 'self_inits',
    ).driver;
    let nextParse: ParsedEvent[] = [];
    const driver: Driver = {
      ...base,
      releaseProfile:
        profile ??
        // Default legacy mapping: the old boundary-gated queue behavior
        // (defer mid-turn, drain-all at turn_end) lives on
        // next-turn-batch in the final tree.
        (mode === 'gated' ? 'next-turn-batch' : 'native-steer'),
      parseLine: () => {
        const out = nextParse;
        nextParse = [];
        return out;
      },
    };
    const spy = makeEmitSpy();
    let firstSpawn = true;
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: logger ?? silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_kind, fallback) => fallback,
      spawnFn: () => {
        if (!firstSpawn) stub = new DriveStub();
        firstSpawn = false;
        return stub as unknown as ChildProcess;
      },
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
      ...(opts.reservationStallWarnMs !== undefined
        ? { reservationStallWarnMs: opts.reservationStallWarnMs }
        : {}),
    });
    /** Emit one stdout line whose parse yields `events`. */
    const drive = (events: ParsedEvent[]) => {
      nextParse = events;
      stub.stdout.emit('data', 'line\n');
    };
    const deliver = (ids: number[], owner = 'owner-A') =>
      supervisor.deliver(
        {
          conversation_id: 'c1',
          agent_id: 'a1',
          delivery_ids: ids,
          kind: 'message',
          text: `msg-${ids.join('_')}`,
          spawn_options: baseStartParams.options,
        },
        { owner },
      );
    const consumedFor = (id: number) =>
      spy.events.filter(
        e =>
          e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(id),
      );
    return {
      get stub() {
        return stub;
      },
      supervisor,
      events: spy.events,
      drive,
      deliver,
      consumedFor,
      driver,
    };
  }

  it('gated: mid-turn deliveries DEFER (no ack), then flush combined into ONE consumed', async () => {
    const h = makeDriven('gated');
    // Spawn-with-batch [1]; a requires_first_message driver parks the write
    // until session_init, which then drives the handle to ready.
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // Enter a turn: a tool_call closes the safe boundary.
    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );

    // Two mid-turn deliveries must DEFER (gate 1) and NOT ack (gate 2).
    const d2 = await h.deliver([2]);
    const d3 = await h.deliver([3]);
    expect(d2.disposition).toBe('deferred');
    expect(d3.disposition).toBe('deferred');
    await wait(30);
    expect(h.consumedFor(2)).toHaveLength(0);
    expect(h.consumedFor(3)).toHaveLength(0);
    expect(
      h.events.some(e => e.event === 'runtime_delivery_failed'),
    ).toBe(false);

    // turn_end reopens the boundary → gated flush drains the WHOLE queue and
    // combines into ONE consumed covering both ids (gate 4).
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 2);
    const combined = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' &&
        (e.delivery_ids.includes(2) || e.delivery_ids.includes(3)),
    );
    expect(combined).toHaveLength(1);
    expect(combined[0]!.event === 'runtime_delivery_consumed' &&
      [...combined[0]!.delivery_ids].sort()).toEqual([2, 3]);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('P-A falsifier (#task:1558): N mid-turn inputs to a next-turn-batch runtime form exactly ONE follow-up batch, even with the transport-safe boundary open', async () => {
    const h = makeDriven('gated', 'next-turn-batch');
    // Spawn-with-batch [1]; write #1 arms the reservation AT THE WRITE
    // (§3.4 step 2) — before any runtime activity frame exists.
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // The P-A trap: NO tool_call is in flight, so the legacy transport-
    // safe predicate is open the whole time. Under the old unified gate
    // these three would be written immediately, queuing three future
    // turns inside the runtime (#1556). They must DEFER instead.
    for (const id of [2, 3, 4]) {
      const d = await h.deliver([id]);
      expect(d.disposition).toBe('deferred');
    }
    // Mid-turn activity (thinking = provider/model working, still no
    // tool) must not trigger a flush either.
    h.drive([{ kind: 'thinking', text: 'working' }]);
    await wait(30);
    expect(h.consumedFor(2)).toHaveLength(0);
    expect(h.consumedFor(3)).toHaveLength(0);
    expect(h.consumedFor(4)).toHaveLength(0);

    // Terminal turn_end releases: the whole queue drains as ONE
    // combined write / ONE consumed covering [2,3,4].
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 2);
    const combined = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' &&
        (e.delivery_ids.includes(2) ||
          e.delivery_ids.includes(3) ||
          e.delivery_ids.includes(4)),
    );
    expect(combined).toHaveLength(1);
    expect(
      combined[0]!.event === 'runtime_delivery_consumed' &&
        [...combined[0]!.delivery_ids].sort(),
    ).toEqual([2, 3, 4]);

    // The flush write re-armed the reservation: a delivery right after
    // it still defers until the NEXT turn_end.
    const d5 = await h.deliver([5]);
    expect(d5.disposition).toBe('deferred');
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 5);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('reservation stall falsifier (#task:1563 §3.4/§8, Cindy P1-1): ONE deferred entry with NO further inflow gets exactly one timeout-driven warn — zero writes; late turn_end flushes and the re-arm resets the latch', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger = {
      info: () => {},
      warn: (f: unknown) => {
        if (f && typeof f === 'object') logs.push(f as Record<string, unknown>);
      },
      error: () => {},
    } as unknown as DaemonLogger;
    const h = makeDriven('gated', 'next-turn-batch', logger, {
      reservationStallWarnMs: 80,
    });
    const stallLogs = () =>
      logs.filter(l => l['action'] === 'next_turn_reservation_stalled');

    // Spawn-with-batch [1]; the write arms the reservation.
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // ONE delivery defers; below the threshold the queue is silent.
    const d2 = await h.deliver([2]);
    expect(d2.disposition).toBe('deferred');
    expect(stallLogs()).toHaveLength(0);

    // Cindy P1-1: NO further inflow. The timeout alone must surface the
    // stall — the queued entry is waiting even though nothing new
    // arrives to re-trigger a check.
    await waitFor(() => stallLogs().length === 1);
    // Exactly one warn (one-shot latch), and STILL zero writes: the
    // diagnostic never forces a release (fail closed).
    await wait(200);
    expect(stallLogs()).toHaveLength(1);
    expect(h.consumedFor(2)).toHaveLength(0);
    expect(stallLogs()[0]!['deferred_queue_depth']).toBe(1);

    // A delivery arriving during the already-warned stall defers quietly.
    const d3 = await h.deliver([3]);
    expect(d3.disposition).toBe('deferred');
    expect(stallLogs()).toHaveLength(1);

    // Recovery: the terminal arrives late → normal combined flush of the
    // whole queue, ONE consumed covering [2,3].
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 2);
    const combined = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(2),
    );
    expect(combined).toHaveLength(1);
    expect(
      combined[0]!.event === 'runtime_delivery_consumed' &&
        [...combined[0]!.delivery_ids].sort(),
    ).toEqual([2, 3]);

    // The flush write re-armed the reservation AND reset the latch: a
    // new deferred entry under the new reservation stalls → second warn.
    const d5 = await h.deliver([5]);
    expect(d5.disposition).toBe('deferred');
    await waitFor(() => stallLogs().length === 2);
    expect(h.consumedFor(5)).toHaveLength(0);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('startup double-write falsifier (#task:1563 Cindy P1-2): session_init parsed inside the startup write await window must not re-enter the consume — stdin written ONCE, consumed ONCE', async () => {
    // The race: `dispatchParsedLine` runs synchronously from the stdout
    // data listener, OUTSIDE the lifecycle lock. A session_init landing
    // while `consumeStartupDelivery` is awaiting `writeStdinPayload`
    // used to re-enter the consume via `tryConsumeStartupDelivery`
    // (gate non-null, awaitingInit not yet set) → the SAME batch written
    // to stdin twice + double consumed. `startupConsumeInFlight` guards
    // exactly that seam.
    const h = makeDriven('gated', 'next-turn-batch', undefined, {
      parkFirstWrite: true,
    });
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');

    // The startup write is parked mid-flight.
    await waitFor(() => h.stub.pendingWriteCb !== null);
    expect(h.stub.written).toHaveLength(1);

    // session_init lands INSIDE the write await window.
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await wait(30);
    // No re-entry: the same batch must NOT have been written again.
    expect(h.stub.written).toHaveLength(1);

    // Release the parked write; the in-flight consume settles on its own
    // (initObserved is already true) — exactly one consumed.
    h.stub.parkWrites = false;
    h.stub.resolveParkedWrite();
    await waitForDeliveryConsumed(h.events, 1);
    await wait(30);
    expect(h.consumedFor(1)).toHaveLength(1);
    expect(h.stub.written).toHaveLength(1);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('crash/restart convergence (#task:1563 §8): reservation + deferred queue die with the runtime — per-entry child_exit settle, never consumed; respawn-with-batch admits and re-arms the reservation', async () => {
    const h = makeDriven('gated', 'next-turn-batch');
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // Reservation held → mid-turn deliveries defer into daemon custody.
    const d2 = await h.deliver([2]);
    const d3 = await h.deliver([3]);
    expect(d2.disposition).toBe('deferred');
    expect(d3.disposition).toBe('deferred');

    // Crash with the reservation still held. The in-memory reservation
    // and queue die with the handle; each deferred entry settles as
    // `child_exit` (custody back to backend → rows roll to pending),
    // and NO consumed is ever emitted for them.
    h.stub.emit('exit', 1, null);
    await waitFor(() =>
      h.events.some(
        e =>
          e.event === 'runtime_delivery_failed' &&
          e.delivery_ids.includes(3) &&
          e.reason === 'child_exit',
      ),
    );
    expect(
      h.events.some(
        e =>
          e.event === 'runtime_delivery_failed' &&
          e.delivery_ids.includes(2) &&
          e.reason === 'child_exit',
      ),
    ).toBe(true);
    expect(h.consumedFor(2)).toHaveLength(0);
    expect(h.consumedFor(3)).toHaveLength(0);

    // Backend re-drive after rollback: respawn-with-batch admits [2,3]
    // as the startup batch (one consumed covering both).
    const respawn = await h.deliver([2, 3]);
    expect(respawn.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's2' }]);
    await waitForDeliveryConsumed(h.events, 2);
    const combined = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(2),
    );
    expect(combined).toHaveLength(1);
    expect(
      combined[0]!.event === 'runtime_delivery_consumed' &&
        [...combined[0]!.delivery_ids].sort(),
    ).toEqual([2, 3]);

    // The startup write re-armed the reservation on the NEW handle: the
    // next delivery defers until its turn_end — restart converges to the
    // exact same contract, no special casing.
    const d4 = await h.deliver([4]);
    expect(d4.disposition).toBe('deferred');
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 4);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('prompt-boundary falsifier (#task:1565): deliveries during an active prompt DEFER with observed locked; the prompt response reopens the boundary → ONE combined prompt, batch-boundary admission', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger = {
      info: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      warn: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      error: () => {},
    } as unknown as DaemonLogger;
    const h = makeDriven('direct', 'prompt-boundary', logger);
    // Mirror AcpClient's single-in-flight prompt gate: encode closes the
    // boundary (activePromptRequestId set), the prompt RESPONSE — parsed
    // as turn_end — reopens it. This is a correctness invariant probed on
    // opencode 1.18.1: a second live prompt gets queued runtime-side and
    // BOTH responses are held to the end of the whole run, so per-prompt
    // boundaries only exist in the one-at-a-time regime.
    let promptActive = false;
    const baseEncode = h.driver.encodeStdinMessage.bind(h.driver);
    h.driver.encodeStdinMessage = (text, sess, opts) => {
      promptActive = true;
      return baseEncode(text, sess, opts);
    };
    const baseParse = h.driver.parseLine.bind(h.driver);
    h.driver.parseLine = line => {
      const events = baseParse(line);
      if (events.some(e => e.kind === 'turn_end')) promptActive = false;
      return events;
    };
    h.driver.readyToEncode = () => !promptActive;

    const deliverSeq = (id: number, seq: number) =>
      h.supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [id], kind: 'message',
        text: `m${id}`, delivered_up_to_seq: seq,
        spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });
    const advancedTo = (seq: number) =>
      logs.some(
        l =>
          l['action'] === 'freshness_observed_seq_advanced' &&
          l['observed_seq'] === seq,
      );

    // Spawn-with-batch [1] (seq 10): the write IS the prompt → boundary
    // closes, observed=10 becomes the new action snapshot.
    const spawn0 = await deliverSeq(1, 10);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);
    expect(promptActive).toBe(true);

    // Mid-prompt deliveries DEFER (boundary closed) and the snapshot
    // stays locked: no advancement to 11/12, no consumed.
    const d2 = await deliverSeq(2, 11);
    const d3 = await deliverSeq(3, 12);
    expect(d2.disposition).toBe('deferred');
    expect(d3.disposition).toBe('deferred');
    await wait(30);
    expect(h.consumedFor(2)).toHaveLength(0);
    expect(h.consumedFor(3)).toHaveLength(0);
    expect(advancedTo(11)).toBe(false);
    expect(advancedTo(12)).toBe(false);

    // The prompt RESPONSE (parsed turn_end) reopens the boundary: the
    // whole queue flushes as ONE combined prompt / ONE consumed, and the
    // batch admits at the boundary — constructive batch-boundary
    // evidence advances observed to 12 for the NEXT generation snapshot.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 2);
    const combined = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(2),
    );
    expect(combined).toHaveLength(1);
    // FIFO is part of the acceptance contract (no reorder): assert the
    // consumed id ORDER verbatim — no .sort() masking — and that the
    // combined payload writes m2 before m3 on the wire.
    expect(
      combined[0]!.event === 'runtime_delivery_consumed' &&
        [...combined[0]!.delivery_ids],
    ).toEqual([2, 3]);
    const combinedWrite = h.stub.written.find(
      w => w.includes('m2') && w.includes('m3'),
    );
    expect(combinedWrite).toBeTruthy();
    expect(combinedWrite!.indexOf('m2')).toBeLessThan(combinedWrite!.indexOf('m3'));
    await waitFor(() => advancedTo(12));

    // The flush write opened the NEXT prompt: boundary closed again, a
    // new delivery defers until that prompt's response.
    expect(promptActive).toBe(true);
    const d4 = await deliverSeq(4, 13);
    expect(d4.disposition).toBe('deferred');
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 4);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it("B' (#task:1558): tool-boundary-steer writes immediately mid-turn (compaction is the only hold) and started(uuid) promotes observed", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const logger = {
      info: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      warn: (f: unknown) => { if (f && typeof f === 'object') logs.push(f as Record<string, unknown>); },
      error: () => {},
    } as unknown as DaemonLogger;
    const h = makeDriven('gated', 'tool-boundary-steer', logger);
    const minted: Array<string | undefined> = [];
    const baseEncode = h.driver.encodeStdinMessage.bind(h.driver);
    h.driver.encodeStdinMessage = (text, sess, opts) => {
      minted.push(opts?.payloadUuid);
      return baseEncode(text, sess, opts);
    };

    // Spawn with seq so the turn becomes active (admission with seq).
    const spawn0 = await h.supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [1],
      kind: 'message',
      text: 'first',
      delivered_up_to_seq: 10,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // Mid-turn with an OUTSTANDING tool call — the legacy predicate is
    // closed. tool-boundary-steer must still write immediately.
    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );
    const d2 = await h.supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [2],
      kind: 'message',
      text: 'steer me in',
      delivered_up_to_seq: 11,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(d2.disposition).toBe('admitted');
    await waitForDeliveryConsumed(h.events, 2);
    const uuid2 = minted[minted.length - 1];
    expect(uuid2).toBeTruthy();
    // Mid-turn write: observed must NOT have advanced to 11 yet.
    expect(
      logs.some(
        l =>
          l['action'] === 'freshness_observed_seq_advanced' &&
          l['observed_seq'] === 11,
      ),
    ).toBe(false);

    // Runtime echoes started(uuid): the payload became precedent —
    // observed promotes to the covered seq immediately.
    h.drive([{ kind: 'input_lifecycle', commandUuid: uuid2!, state: 'started' }]);
    await waitFor(() =>
      logs.some(
        l =>
          l['action'] === 'freshness_observed_seq_advanced' &&
          l['source'] === 'input_lifecycle_started' &&
          l['observed_seq'] === 11,
      ),
    );

    // Compaction is the one migration-period hold: deliveries defer
    // while compacting and flush at compaction_finished.
    h.drive([{ kind: 'compaction_started' }]);
    await waitFor(() =>
      h.events.some(
        e =>
          e.event === 'runtime_parsed_event' &&
          e.parsed.kind === 'compaction_started',
      ),
    );
    const d3 = await h.supervisor.deliver({
      conversation_id: 'c1',
      agent_id: 'a1',
      delivery_ids: [3],
      kind: 'message',
      text: 'wait for compaction',
      delivered_up_to_seq: 12,
      spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });
    expect(d3.disposition).toBe('deferred');
    h.drive([{ kind: 'compaction_finished' }]);
    await waitForDeliveryConsumed(h.events, 3);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('P1-1 falsifier (#1558 final gate): a turn_end crossing the write await window must not be overwritten back into reserved', async () => {
    // Fast-runtime interleaving: the flush write's callback is parked;
    // the turn generated by that very write completes (turn_end parsed)
    // BEFORE the write callback resolves. The late completion must NOT
    // re-arm the reservation — otherwise the queue is held forever.
    class ParkedStub extends EventEmitter {
      readonly pid = 57_001;
      readonly stdout = new EventEmitter();
      readonly stderr = new EventEmitter();
      parkWrites = false;
      pendingWriteCb: ((err?: Error | null) => void) | null = null;
      readonly stdin = {
        write: (_l: string, cb?: (err?: Error | null) => void): boolean => {
          if (this.parkWrites) { this.pendingWriteCb = cb ?? null; }
          else setImmediate(() => cb?.());
          return true;
        },
        end: () => {}, destroyed: false, once: () => {},
      };
      resolveParkedWrite(): void { const cb = this.pendingWriteCb; this.pendingWriteCb = null; cb?.(); }
      kill(): boolean { setImmediate(() => this.emit('exit', 0, null)); return true; }
    }
    const stub = new ParkedStub();
    const base = makeProgrammableDriver([], 'self_inits').driver;
    let nextParse: ParsedEvent[] = [];
    const driver: Driver = {
      ...base,
      releaseProfile: 'next-turn-batch',
      parseLine: () => { const out = nextParse; nextParse = []; return out; },
    };
    const spy = makeEmitSpy();
    const supervisor = new Supervisor({
      emit: spy.emit,
      logger: silentLogger(),
      driverFor: () => driver,
      resolveBinary: async (_k, fb) => fb,
      spawnFn: () => stub as unknown as ChildProcess,
      runtimeStartResolveDeps: testRuntimeStartResolveDeps(),
      controlPlaneServerUrl: () => 'http://127.0.0.1:8765',
      sigtermToSigkillMs: 50,
      sigkillTimeoutMs: 200,
    });
    const drive = (events: ParsedEvent[]) => { nextParse = events; stub.stdout.emit('data', 'line\n'); };
    const deliver = (ids: number[]) => supervisor.deliver({
      conversation_id: 'c1', agent_id: 'a1', delivery_ids: ids, kind: 'message',
      text: `m-${ids.join('_')}`, spawn_options: baseStartParams.options,
    }, { owner: 'test-owner' });

    // Spawn-with-batch [1]: park its write, complete its turn (turn_end)
    // while the write callback is parked, THEN resolve the write.
    stub.parkWrites = true;
    const spawn0 = await deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    await waitFor(() => stub.pendingWriteCb !== null, 1_000);
    drive([{ kind: 'turn_end' }]);
    await waitFor(() =>
      spy.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'turn_end',
      ),
    );
    stub.parkWrites = false;
    stub.resolveParkedWrite();
    await waitForDeliveryConsumed(spy.events, 1);

    // The reservation must NOT be armed by the late write completion:
    // a fresh delivery on the (idle, terminal-crossed) runtime must be
    // written immediately, not held forever.
    const d2 = await deliver([2]);
    expect(d2.disposition).toBe('admitted');
    await waitForDeliveryConsumed(spy.events, 2);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('P1-2 falsifier (#1558 final gate): a drain-all flush takes a bounded prefix and leaves the ordered remainder for the next boundary', async () => {
    const h = makeDriven('gated', 'next-turn-batch');
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // Queue more entries than DEFERRED_BATCH_MAX_ENTRIES (20) mid-turn.
    const ids = Array.from({ length: 23 }, (_, i) => 100 + i);
    for (const id of ids) {
      const d = await h.deliver([id]);
      expect(d.disposition).toBe('deferred');
    }

    // First turn_end: exactly the first 20 drain as ONE combined
    // consumed; 3 remain queued in order.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 100);
    const firstBatch = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(100),
    );
    expect(firstBatch).toHaveLength(1);
    expect(
      firstBatch[0]!.event === 'runtime_delivery_consumed' &&
        [...firstBatch[0]!.delivery_ids].sort((a, b) => a - b),
    ).toEqual(ids.slice(0, 20));
    expect(h.consumedFor(120)).toHaveLength(0);

    // Next turn_end: the ordered remainder [120,121,122] drains.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 120);
    const secondBatch = h.events.filter(
      e =>
        e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(120),
    );
    expect(
      secondBatch[0]!.event === 'runtime_delivery_consumed' &&
        [...secondBatch[0]!.delivery_ids].sort((a, b) => a - b),
    ).toEqual([120, 121, 122]);
    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('P1-3 falsifier (#1558 final gate): an unknown releaseProfile fails closed on live input — deliver rejects, zero consumed', async () => {
    const h = makeDriven('direct', 'native-steer');
    // Runtime comes up healthy on a valid profile (spawn/kickoff is not
    // a live-release decision), THEN the profile goes bogus — as a
    // mis-wired future driver would be at live-delivery time.
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    await waitForDeliveryConsumed(h.events, 1);
    (h.driver as { releaseProfile: string }).releaseProfile = 'bogus-profile';

    // Live delivery must fail closed: the deliver command rejects
    // (custody stays with the backend, rows un-acked) and nothing is
    // written to the runtime.
    await expect(h.deliver([2])).rejects.toThrow(/unknown releaseProfile/);
    await wait(50);
    expect(h.consumedFor(2)).toHaveLength(0);

    (h.driver as { releaseProfile: string }).releaseProfile = 'native-steer';
    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' })
      .catch(() => undefined);
  });

  it('P1-2 byte-axis falsifier (#1558): the bytes cap splits the prefix and a single oversized entry still drains alone', async () => {
    const h = makeDriven('gated', 'next-turn-batch');
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    const deliverText = (id: number, text: string) =>
      h.supervisor.deliver({
        conversation_id: 'c1', agent_id: 'a1', delivery_ids: [id], kind: 'message',
        text, spawn_options: baseStartParams.options,
      }, { owner: 'test-owner' });

    // Five 60KiB entries: with the 512B per-entry wrapping budget the
    // 256KiB cap admits exactly four; the fifth waits.
    const big = 'x'.repeat(60 * 1024);
    for (const id of [201, 202, 203, 204, 205]) {
      const d = await deliverText(id, big);
      expect(d.disposition).toBe('deferred');
    }
    // A single entry larger than the whole cap must still drain alone
    // (never wedges the queue).
    const oversized = 'y'.repeat(300 * 1024);
    const d6 = await deliverText(206, oversized);
    expect(d6.disposition).toBe('deferred');

    // turn_end #1 → [201..204] as ONE consumed (bytes cap, not count cap).
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 201);
    const batch1 = h.events.filter(
      e => e.event === 'runtime_delivery_consumed' && e.delivery_ids.includes(201),
    );
    expect(
      batch1[0]!.event === 'runtime_delivery_consumed' &&
        [...batch1[0]!.delivery_ids].sort((a, b) => a - b),
    ).toEqual([201, 202, 203, 204]);
    expect(h.consumedFor(205)).toHaveLength(0);

    // turn_end #2 → [205] alone? No: 205 (60KiB) + 206 (300KiB) — 205
    // fits, adding 206 would blow the cap → [205] drains, 206 waits.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 205);
    expect(h.consumedFor(206)).toHaveLength(0);

    // turn_end #3 → the single oversized 206 drains ALONE (at-least-one).
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 206);
    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('direct: a write-in-flight deferral flushes FIFO one-at-a-time, never combined', async () => {
    const h = makeDriven('direct');
    // Spawn-with-batch [1]; self_inits admits + consumes immediately → ready.
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    await waitForDeliveryConsumed(h.events, 1);

    // [2] ADMITs (ready, boundary open); its write is in flight (stub write
    // settles on setImmediate). [3] lands in that window → DEFER
    // (write-in-flight), NOT combined with [2].
    const d2 = await h.deliver([2]);
    const d3 = await h.deliver([3]);
    expect(d2.disposition).toBe('admitted');
    expect(d3.disposition).toBe('deferred');

    // Both settle as SEPARATE consumed events (FIFO), never a combined [2,3].
    await waitForDeliveryConsumed(h.events, 2);
    await waitForDeliveryConsumed(h.events, 3);
    const c2 = h.consumedFor(2);
    const c3 = h.consumedFor(3);
    expect(c2).toHaveLength(1);
    expect(c3).toHaveLength(1);
    // No single consumed carries both — direct never combines.
    expect(
      h.events.some(
        e =>
          e.event === 'runtime_delivery_consumed' &&
          e.delivery_ids.includes(2) &&
          e.delivery_ids.includes(3),
      ),
    ).toBe(false);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('owner-scoped cleanup discards only the dropped connection’s deferred entries', async () => {
    const h = makeDriven('gated');
    const spawn0 = await h.deliver([1], 'owner-A');
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    // Mid-turn: two owners each defer a delivery.
    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );
    expect((await h.deliver([10], 'owner-A')).disposition).toBe('deferred');
    expect((await h.deliver([20], 'owner-B')).disposition).toBe('deferred');

    // owner-A drops: discard ONLY A's entry, emit nothing.
    h.supervisor.cleanupDeferredForOwner('owner-A');
    await wait(20);
    expect(
      h.events.some(e => e.event === 'runtime_delivery_consumed'
        ? e.delivery_ids.includes(10) : false),
    ).toBe(false);
    expect(
      h.events.some(e => e.event === 'runtime_delivery_failed'),
    ).toBe(false);

    // turn_end: only owner-B's surviving [20] flushes; A's [10] is gone.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 20);
    expect(h.consumedFor(10)).toHaveLength(0);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('child exit fails queued deferred entries as child_exit (no orphan, no ack)', async () => {
    const h = makeDriven('gated');
    const spawn0 = await h.deliver([1]);
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );
    expect((await h.deliver([9])).disposition).toBe('deferred');

    // Child dies mid-turn → the queued [9] is failed as child_exit (backend
    // rolls it back to pending), never acked.
    h.stub.emit('exit', 1, null);
    await waitFor(() =>
      h.events.some(
        e =>
          e.event === 'runtime_delivery_failed' &&
          e.delivery_ids.includes(9) &&
          e.reason === 'child_exit',
      ),
    );
    expect(h.consumedFor(9)).toHaveLength(0);
  });

  it('reconnect/reclaim race: a same-id-set re-submit under a NEW owner rebinds the queued entry, so the OLD owner’s cleanup no longer drops it (Cindy P1)', async () => {
    // The orphan Cindy P1 flags: owner A defers [42] mid-turn; the backend
    // sees A drop, rolls the DB row back to pending, and re-drives it under
    // owner B; B's runtime_deliver [42] can reach the daemon BEFORE A's
    // cleanup. Owner-blind dedup would keep the entry under A, then A's
    // cleanup would discard custody the DB now attributes to B — orphan.
    // Owner-aware enqueue rebinds the entry to B, so A's cleanup misses it
    // and it flushes normally.
    const h = makeDriven('gated');
    const spawn0 = await h.deliver([1], 'owner-A');
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );

    // A defers [42]; then B re-submits the SAME id-set before A's cleanup.
    expect((await h.deliver([42], 'owner-A')).disposition).toBe('deferred');
    expect((await h.deliver([42], 'owner-B')).disposition).toBe('deferred');

    // A's connection drops and its cleanup fires — must NOT drop [42] (now
    // owned by B).
    h.supervisor.cleanupDeferredForOwner('owner-A');

    // turn_end flushes the surviving entry → [42] is consumed exactly once.
    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 42);
    expect(h.consumedFor(42)).toHaveLength(1);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('same-owner re-submit of a queued id-set is idempotent (no double-queue, one consumed)', async () => {
    const h = makeDriven('gated');
    const spawn0 = await h.deliver([1], 'owner-A');
    expect(spawn0.disposition).toBe('spawning');
    h.drive([{ kind: 'session_init', sessionId: 's1' }]);
    await waitForDeliveryConsumed(h.events, 1);

    h.drive([{ kind: 'tool_call', name: 'Bash', input: {} }]);
    await waitFor(() =>
      h.events.some(
        e => e.event === 'runtime_parsed_event' && e.parsed.kind === 'tool_call',
      ),
    );

    // Same owner defers [7] twice — the second is deduped, not double-queued.
    expect((await h.deliver([7], 'owner-A')).disposition).toBe('deferred');
    expect((await h.deliver([7], 'owner-A')).disposition).toBe('deferred');

    h.drive([{ kind: 'turn_end' }]);
    await waitForDeliveryConsumed(h.events, 7);
    // Exactly one consumed carrying [7] — dedup held.
    expect(h.consumedFor(7)).toHaveLength(1);

    await h.supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});

describe('Supervisor #task:1486 — reasoning-effort is forwarded, not product-gated', () => {
  // Regression lock for Cindy's P1: the daemon is NOT a product-legality
  // authority. It does bounded structural wire validation and forwards the
  // effort token; product validity lives in the backend write boundary, and
  // Codex itself rejects an engine-unsupported effort. Re-introducing a static
  // product allowlist here would defeat the open-token contract (an older
  // daemon would `invalid_params` a future token a newer backend legitimately
  // sends), so any product-model check on the spawn path must fail this test.
  function codexStart(model: string, effort: string) {
    const options = testStartOptions({
      conversationId: 'c1',
      agentId: 'a1',
      agentName: 'tester',
      runtime: 'codex',
      model,
    });
    options.driver.reasoning_effort = effort;
    return { conversation_id: 'c1', agent_id: 'a1', options };
  }

  it('baseline High spawns for any model (no host probe)', async () => {
    const { supervisor } = makeSupervisor();
    const res = await supervisor.start(codexStart('my-proxy-model', 'high'));
    assertStarted(res);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('Ultra on gpt-5.6-sol spawns (product table allows it upstream)', async () => {
    const { supervisor } = makeSupervisor();
    const res = await supervisor.start(codexStart('gpt-5.6-sol', 'ultra'));
    assertStarted(res);
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });

  it('forwards a product-invalid effort through runtime_start to CodexDriver argv verbatim (open-token contract)', async () => {
    // Cindy P1 acceptance: a token the closed product enum does not know
    // (`giga`) must flow runtime_start → DriverSpawnContext → CodexDriver
    // .buildArgs → argv unchanged, with NO daemon-side product gate. Re-adding
    // a closed allowlist in the supervisor would either reject the start
    // (assertStarted fails) or drop the token from the ctx (assertion below
    // fails). protocol.test only proves Zod parses the token; this proves the
    // execution plane forwards it. Product API still rejects `giga` upstream —
    // that boundary lives in the backend, not here.
    let captured: DriverSpawnContext | undefined;
    const { supervisor } = makeSupervisor({
      onSpawnCtx: ctx => {
        captured = ctx;
      },
    });
    const res = await supervisor.start(codexStart('gpt-5.6-sol', 'giga'));
    assertStarted(res);
    expect(captured?.reasoningEffort).toBe('giga');
    // The real CodexDriver renders the forwarded token verbatim into argv.
    const argv = new CodexDriver().buildArgs(captured!);
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="giga"');
    await supervisor.stop({ conversation_id: 'c1', agent_id: 'a1', mode: 'hard' });
  });
});
