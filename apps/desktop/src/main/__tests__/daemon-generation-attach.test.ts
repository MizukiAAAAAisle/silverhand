/**
 * Unit tests for `waitForDaemonGeneration` (Cindy `#task:627` P1-A fix).
 *
 * The helper exists because `HostClient.connect()` does NOT prove the
 * transport is currently talking to the daemon generation we just
 * heard about from `onDaemonGenerationChanged`. These tests pin the
 * four interesting outcomes:
 *
 *   1. Already on expected generation → immediate ok.
 *   2. Wrong generation, then reconnect with expected → ok via
 *      `onReconnect`.
 *   3. Wrong generation, never reconnects with expected → timeout.
 *   4. Transient reconnect onto a third (still-wrong) generation
 *      keeps waiting until the expected one arrives or timer fires.
 *
 * We use a stand-in HostClient that only exposes the three surfaces
 * the helper uses: `connect()`, `negotiated`, `onReconnect`. This
 * keeps the test focused on the gate logic and avoids dragging the
 * real client's socket/reconnect machinery into a pure-logic test.
 */
import { describe, expect, it } from 'vitest';
import {
  waitForDaemonGeneration,
  type WaitForDaemonGenerationOptions,
} from '../daemon-generation-attach.js';

interface FakeNegotiated {
  instanceId: string;
}

class FakeHostClient {
  negotiated: FakeNegotiated | null = null;
  connectImpl: () => Promise<void> = () => Promise.resolve();
  private readonly handlers = new Set<() => void>();

  onReconnect(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async connect(): Promise<void> {
    return this.connectImpl();
  }

  /** Simulate the client's own reconnect loop landing a new hello. */
  fireReconnect(nextInstanceId: string | null): void {
    this.negotiated = nextInstanceId === null ? null : { instanceId: nextInstanceId };
    for (const h of Array.from(this.handlers)) h();
  }

  get handlerCount(): number {
    return this.handlers.size;
  }
}

/** A trivially-controllable timer the helper can call into. */
function makeFakeTimer(): {
  setTimer: NonNullable<WaitForDaemonGenerationOptions['setTimer']>;
  fire(): void;
  isCleared(): boolean;
  isArmed(): boolean;
} {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    setTimer: (callback, _ms) => {
      cb = callback;
      cleared = false;
      return {
        clear: () => {
          cleared = true;
        },
      };
    },
    fire: () => {
      if (cb && !cleared) cb();
    },
    isCleared: () => cleared,
    isArmed: () => cb !== null && !cleared,
  };
}

// Cast helper so the test's stub satisfies the real signature; the
// helper only touches three members of HostClient.
function asHostClient(stub: FakeHostClient): Parameters<typeof waitForDaemonGeneration>[0] {
  return stub as unknown as Parameters<typeof waitForDaemonGeneration>[0];
}

/**
 * Drain enough microtask cycles for the helper's `await
 * client.connect()` to settle and its subsequent sync code (the
 * negotiated check + `new Promise()` executor that subscribes to
 * onReconnect) to run. A single `await Promise.resolve()` is not
 * enough in V8 — the async fn unwraps through several Promise
 * machinery hops before re-entering the helper body.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

describe('waitForDaemonGeneration', () => {
  it('returns immediately when client.negotiated already matches', async () => {
    const stub = new FakeHostClient();
    stub.negotiated = { instanceId: 'gen-1' };
    const timer = makeFakeTimer();

    const result = await waitForDaemonGeneration(asHostClient(stub), 'gen-1', {
      setTimer: timer.setTimer,
    });

    expect(result).toEqual({ ok: true });
    // No reconnect handler should remain subscribed in the fast path.
    expect(stub.handlerCount).toBe(0);
    expect(timer.isArmed()).toBe(false);
  });

  it('resolves ok when reconnect lands on the expected generation', async () => {
    const stub = new FakeHostClient();
    stub.negotiated = { instanceId: 'gen-old' };
    const timer = makeFakeTimer();

    const pending = waitForDaemonGeneration(asHostClient(stub), 'gen-new', {
      setTimer: timer.setTimer,
    });

    // Microtask: connect() resolves, helper subscribes to reconnect.
    await flushMicrotasks();
    expect(stub.handlerCount).toBe(1);

    stub.fireReconnect('gen-new');
    const result = await pending;

    expect(result).toEqual({ ok: true });
    // Helper must unsubscribe + clear timer on success.
    expect(stub.handlerCount).toBe(0);
    expect(timer.isCleared()).toBe(true);
  });

  it('returns timeout when expected generation never arrives', async () => {
    const stub = new FakeHostClient();
    stub.negotiated = { instanceId: 'gen-other' };
    const timer = makeFakeTimer();

    const pending = waitForDaemonGeneration(asHostClient(stub), 'gen-target', {
      setTimer: timer.setTimer,
    });

    await flushMicrotasks();

    // Trigger the fake timer to fire — simulates wall-clock deadline.
    timer.fire();
    const result = await pending;

    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(stub.handlerCount).toBe(0);
  });

  it('keeps waiting through reconnects that land on the wrong generation', async () => {
    const stub = new FakeHostClient();
    stub.negotiated = null;
    const timer = makeFakeTimer();

    const pending = waitForDaemonGeneration(asHostClient(stub), 'gen-target', {
      setTimer: timer.setTimer,
    });

    await flushMicrotasks();
    expect(stub.handlerCount).toBe(1);

    // Two unrelated reconnects — neither matches; helper must NOT
    // resolve, must keep its handler subscribed, must not clear timer.
    stub.fireReconnect('gen-old');
    stub.fireReconnect('gen-stranger');
    expect(stub.handlerCount).toBe(1);
    expect(timer.isCleared()).toBe(false);

    // The expected one finally arrives.
    stub.fireReconnect('gen-target');
    const result = await pending;

    expect(result).toEqual({ ok: true });
    expect(stub.handlerCount).toBe(0);
    expect(timer.isCleared()).toBe(true);
  });

  it('surfaces connect failures without subscribing to reconnect', async () => {
    const stub = new FakeHostClient();
    const boom = new Error('socket refused');
    stub.connectImpl = () => Promise.reject(boom);
    const timer = makeFakeTimer();

    const result = await waitForDaemonGeneration(asHostClient(stub), 'gen-any', {
      setTimer: timer.setTimer,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('connect_failed');
      expect(result.error).toBe(boom);
    }
    expect(stub.handlerCount).toBe(0);
    expect(timer.isArmed()).toBe(false);
  });
});
