import { describe, expect, it } from 'vitest';
import { IntentDispatcher } from '../src/daemon/dispatcher.js';
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

describe('IntentDispatcher', () => {
  it('handles ping with the daemon pid + version', async () => {
    const d = new IntentDispatcher({ logger: silentLogger(), startedAt: 1_700_000_000_000 });
    const r = await d.dispatch('req-1', 'ping', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({
      pong: true,
      daemon_pid: process.pid,
      started_at: 1_700_000_000_000,
    });
  });

  it('handles echo round-trip', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-2', 'echo', { message: 'hi' });
    expect('result' in r).toBe(true);
    if ('result' in r) expect(r.result).toEqual({ echoed: 'hi' });
  });

  it('rejects unknown intents', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-3', 'not_a_real_intent', {});
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error.code).toBe('unknown_intent');
      expect(r.error.message).toContain('not_a_real_intent');
    }
  });

  it('rejects malformed params', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    const r = await d.dispatch('req-4', 'echo', { wrong_field: 1 });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('invalid_params');
  });

  it('refuses intents once marked as shutting_down', async () => {
    const d = new IntentDispatcher({ logger: silentLogger() });
    d.markShuttingDown();
    const r = await d.dispatch('req-5', 'ping', {});
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.code).toBe('shutting_down');
  });

  it('increments intent_count on success and includes it in status', async () => {
    let now = 1_000;
    const d = new IntentDispatcher({
      logger: silentLogger(),
      startedAt: 0,
      now: () => now,
    });
    await d.dispatch('req-a', 'ping', {});
    await d.dispatch('req-b', 'echo', { message: 'x' });
    now = 5_000;
    const r = await d.dispatch('req-c', 'status', {});
    expect('result' in r).toBe(true);
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({
      uptime_ms: 5_000,
      intent_count: 3,
      runtimes: [],
    });
  });

  it('does NOT increment intent_count on validation failure', async () => {
    let now = 1_000;
    const d = new IntentDispatcher({ logger: silentLogger(), startedAt: 0, now: () => now });
    await d.dispatch('req-x', 'unknown', {});
    await d.dispatch('req-y', 'echo', { wrong: 1 });
    // intent_count should still be 0; reading via status increments it.
    const r = await d.dispatch('req-z', 'status', {});
    if (!('result' in r)) return;
    expect(r.result).toMatchObject({ intent_count: 1 });
  });
});
