import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdleReaperService } from '../../src/services/idle-reaper-service.js';
import type {
  AgentRuntimeHost,
  ReapIdleRuntimesOptions,
  ReapIdleRuntimesResult,
} from '../../src/runtime/agent-runtime-host.js';

const EMPTY_REAP_RESULT: ReapIdleRuntimesResult = {
  considered: 0,
  eligible: 0,
  reaped: 0,
  skipped: 0,
  failed: 0,
};

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

function makeRuntimeHost(
  reap: (opts: ReapIdleRuntimesOptions) => Promise<ReapIdleRuntimesResult>,
): AgentRuntimeHost {
  return {
    start: async () => {},
    stop: async () => {},
    deliverPending: async () => true,
    clearSession: async () => ({
      prevCliSessionId: null,
      wasRunning: false,
      focusConversationId: null,
    }),
    stopAll: async () => {},
    reapIdleRuntimes: reap,
    setConversationLogDebug: async () => {},
    closeActivityLog: async () => {},
    deliverMessage: async () => {},
    reconcileOnBoot: () => {},
    getAgentRunStates: () => [],
    resolveRun: () => {},
    resolveConversationRuns: () => {},
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('IdleReaperService', () => {
  it('passes global TTL and current time through the runtime facade', async () => {
    const reap = vi.fn(async () => EMPTY_REAP_RESULT);
    const service = new IdleReaperService({
      runtimeHost: makeRuntimeHost(reap),
      logger: SILENT_LOGGER,
      now: () => 1234,
      ttlMs: 30,
      disableAutoTick: true,
    });

    await service.tick();

    expect(reap).toHaveBeenCalledWith({ ttlMs: 30, now: 1234 });
  });

  it('does not run overlapping sweeps', async () => {
    let release!: () => void;
    const first = new Promise<ReapIdleRuntimesResult>(resolve => {
      release = () => resolve(EMPTY_REAP_RESULT);
    });
    const reap = vi.fn(() => first);
    const service = new IdleReaperService({
      runtimeHost: makeRuntimeHost(reap),
      logger: SILENT_LOGGER,
      disableAutoTick: true,
    });

    const pending = service.tick();
    await service.tick();
    release();
    await pending;

    expect(reap).toHaveBeenCalledTimes(1);
  });

  it('stop cancels the sweep timer', async () => {
    vi.useFakeTimers();
    const reap = vi.fn(async () => EMPTY_REAP_RESULT);
    const service = new IdleReaperService({
      runtimeHost: makeRuntimeHost(reap),
      logger: SILENT_LOGGER,
      sweepIntervalMs: 60,
    });

    service.start();
    service.stop();
    await vi.advanceTimersByTimeAsync(120);

    expect(reap).not.toHaveBeenCalled();
  });
});
