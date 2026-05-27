/**
 * D3.b Commit 3 — unit tests for `gracefullyDetachOutbound`.
 *
 * The helper is a best-effort shutdown-time hint that combines an
 * IPC `host_outbound_detach` call with a backend-registry
 * verification poll, both bounded by a single 1.5s budget. These
 * tests pin the eight reachable shapes of the outcome:
 *
 *  1. RPC `detached` + registry already cleared (sync fast path).
 *  2. RPC `noop` + registry cleared via poll (proves noop still
 *     polls — daemon may have had no client but a stale row still
 *     exists in the backend registry).
 *  3. RPC `detached` + registry NEVER clears within budget →
 *     `registryCleared:false, budgetExhausted:true`.
 *  4. RPC throws (HostClientError) → `rpc.ok:false`, helper still
 *     polls when budget remains, still resolves cleanly.
 *  5. RPC hangs forever → synthetic timeout, no poll attempted
 *     because budget is exhausted.
 *  6. Degradation path: `hostId === null` → `registryCleared:'skipped'`.
 *  7. Degradation path: `getAttachment === undefined` → same.
 *  8. Idempotent under unexpected RPC throw of a non-Error value
 *     (defensive against poorly-typed throws).
 *
 * Test seam strategy: a fake clock (`now()` + `setTimeout`) drives
 * the budget deterministically, a hand-rolled `HostClient`-shaped
 * stub returns/throws/hangs the IPC, and a `getAttachment` callable
 * returns a scripted sequence of snapshots. No real timers, no real
 * RPC, no flakiness.
 *
 * Strict invariant baked into the suite: the helper MUST resolve;
 * a rejected promise would crash the shutdown sequence Cindy
 * explicitly carved out as "best-effort, never blocks SIGTERM".
 */
import { describe, expect, it } from 'vitest';
import type { HostClient } from '@silverhand/host';
import {
  gracefullyDetachOutbound,
  type GracefulDetachOutcome,
} from '../outbound-detach.js';

// ── Fake clock (mirrors the spawn-supervisor-backoff pattern) ──────

interface FakeTimer {
  id: number;
  deadline: number;
  fn: () => void;
  cleared: boolean;
}

class FakeClock {
  private current = 0;
  private nextId = 1;
  private timers: FakeTimer[] = [];

  now = (): number => this.current;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const t: FakeTimer = {
      id: this.nextId++,
      deadline: this.current + ms,
      fn,
      cleared: false,
    };
    this.timers.push(t);
    return t;
  };

  clearTimeout = (h: unknown): void => {
    const t = h as FakeTimer;
    if (t) t.cleared = true;
  };

  /** Walk forward `ms`, firing any timers that mature. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (let safety = 0; safety < 1000; safety++) {
      const due = this.timers
        .filter(t => !t.cleared && t.deadline <= target)
        .sort((a, b) => a.deadline - b.deadline || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0]!;
      this.current = next.deadline;
      this.timers = this.timers.filter(t => t !== next);
      next.fn();
    }
    this.current = target;
  }
}

// ── Minimal `HostClient`-shaped stub ───────────────────────────────

function mkClientResolving(action: 'detached' | 'noop'): Pick<HostClient, 'hostOutboundDetach'> {
  return {
    hostOutboundDetach: () =>
      Promise.resolve({ detached: true as const, action }),
  };
}

function mkClientRejecting(err: unknown): Pick<HostClient, 'hostOutboundDetach'> {
  return {
    hostOutboundDetach: () => Promise.reject(err),
  };
}

function mkClientHanging(): Pick<HostClient, 'hostOutboundDetach'> {
  return {
    hostOutboundDetach: () => new Promise(() => {}),
  };
}

// ── Scripted `getAttachment` ───────────────────────────────────────
//
// Returns successive snapshots from a queue; once exhausted keeps
// returning the last one. Lets a test express "stale → cleared after
// N polls" naturally. The helper only checks `=== null` so we use
// opaque sentinel objects for "still attached" snapshots.

const STALE = { _: 'stale-attachment-sentinel' } as const;

function mkGetAttachment(
  snapshots: ReadonlyArray<unknown>,
): (hostId: string) => unknown {
  let i = 0;
  return (_hostId: string) => {
    const idx = Math.min(i, snapshots.length - 1);
    i += 1;
    return snapshots[idx] ?? null;
  };
}

// Drain pending microtasks so awaited promise chains (RPC settle,
// Promise.race tail) can progress before the test advances the fake
// clock. 10 ticks is overkill for the helper's chain depth but keeps
// the pattern robust against future re-shape.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

// ── Test harness ───────────────────────────────────────────────────

interface RunArgs {
  client: Pick<HostClient, 'hostOutboundDetach'>;
  hostId: string | null;
  snapshots?: ReadonlyArray<unknown>;
  /** When set to true, omit the `getAttachment` accessor entirely
   *  to exercise the degradation path. */
  noAccessor?: boolean;
  budgetMs?: number;
  pollIntervalMs?: number;
}

function startHelper(args: RunArgs): {
  promise: Promise<GracefulDetachOutcome>;
  clock: FakeClock;
} {
  const clock = new FakeClock();
  const promise = gracefullyDetachOutbound({
    client: args.client,
    hostId: args.hostId,
    getAttachment: args.noAccessor
      ? undefined
      : mkGetAttachment(args.snapshots ?? [null]),
    budgetMs: args.budgetMs ?? 1500,
    pollIntervalMs: args.pollIntervalMs ?? 100,
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
  });
  return { promise, clock };
}

/** A `HostClientError`-shaped throw without depending on the real
 *  class import (avoids cross-package wiring just for a typed
 *  error). The helper inspects `.code` defensively. */
class FakeHostClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('gracefullyDetachOutbound — happy paths', () => {
  it('RPC=detached + registry already cleared (sync fast path) → registryCleared:true, no budget burn', async () => {
    // The daemon almost always closes the WS before its IPC ack
    // returns, so the registry is often already null by the time the
    // poll loop's synchronous initial probe runs. We assert that the
    // fast path resolves WITHOUT advancing the clock by even one
    // pollInterval.
    const { promise } = startHelper({
      client: mkClientResolving('detached'),
      hostId: 'host-x',
      snapshots: [null],
    });
    const out = await promise;
    expect(out.rpc).toEqual({ ok: true, action: 'detached' });
    expect(out.registryCleared).toBe(true);
    expect(out.budgetExhausted).toBe(false);
    // Sync probe + microtask-only RPC → elapsed should be ~0.
    expect(out.elapsedMs).toBe(0);
  });

  it('RPC=noop + registry cleared after one poll → noop path also polls (proves stale-row cleanup)', async () => {
    // The `noop` arm means the daemon had no active client to stop,
    // but the BACKEND registry can still hold a stale attachment row
    // from a prior connection. The helper MUST still poll in that
    // case — that's the whole reason the verification step exists.
    const { promise, clock } = startHelper({
      client: mkClientResolving('noop'),
      hostId: 'host-x',
      snapshots: [
        STALE,   // sync initial probe
        null,    // first scheduled poll → cleared
      ],
      pollIntervalMs: 100,
    });
    // Let the RPC settle + helper schedule its first poll at t=0+100.
    await flushMicrotasks();
    // Walk to t=100 — the scheduled poll fires, sees null, resolves.
    clock.advance(100);
    await flushMicrotasks();
    const out = await promise;
    expect(out.rpc).toEqual({ ok: true, action: 'noop' });
    expect(out.registryCleared).toBe(true);
    expect(out.budgetExhausted).toBe(false);
    expect(out.elapsedMs).toBe(100);
  });
});

describe('gracefullyDetachOutbound — registry never clears within budget', () => {
  it('RPC=detached but registry stays attached → registryCleared:false, budgetExhausted:true', async () => {
    // Models the "daemon answered our IPC but the backend
    // controller has gone unresponsive" pathology. Helper must
    // give up at the budget without throwing.
    const { promise, clock } = startHelper({
      client: mkClientResolving('detached'),
      hostId: 'host-x',
      // Infinite supply of "still attached" snapshots — the
      // mkGetAttachment helper keeps returning the last element
      // once the queue is exhausted, so one STALE entry is enough.
      snapshots: [STALE],
      budgetMs: 1500,
      pollIntervalMs: 100,
    });
    // Let the RPC settle so the helper enters the poll phase and
    // schedules its first poll at t=0+100ms.
    await flushMicrotasks();
    // Step the clock 100ms at a time so each scheduled poll fires
    // in turn and the helper can re-arm. Microtask flushes between
    // ticks let the helper's `tick()` callback observe stale and
    // schedule the next poll. After 1500ms total, the next tick
    // observes `remaining() === 0` and resolves.
    for (let elapsed = 100; elapsed <= 1500; elapsed += 100) {
      clock.advance(100);
      await flushMicrotasks();
    }
    const out = await promise;
    expect(out.rpc).toEqual({ ok: true, action: 'detached' });
    expect(out.registryCleared).toBe(false);
    expect(out.budgetExhausted).toBe(true);
    // Helper should never exceed the budget.
    expect(out.elapsedMs).toBeLessThanOrEqual(1500);
  });
});

describe('gracefullyDetachOutbound — RPC failure paths', () => {
  it('RPC throws HostClientError-shaped object → rpc.ok:false carries code, poll still runs', async () => {
    // A real IPC failure (socket closed, daemon dead) must not
    // prevent the verification step — the backend may already have
    // dropped the attachment via WS close detection, and observing
    // that is still useful diagnostic data.
    const err = new FakeHostClientError('closed', 'client is closed');
    const { promise } = startHelper({
      client: mkClientRejecting(err),
      hostId: 'host-x',
      snapshots: [null],
    });
    const out = await promise;
    expect(out.rpc).toEqual({
      ok: false,
      error: 'client is closed',
      code: 'closed',
    });
    expect(out.registryCleared).toBe(true);
    expect(out.budgetExhausted).toBe(false);
  });

  it('RPC hangs forever → synthetic timeout, no poll attempted (budget already gone)', async () => {
    // Pathological RPC that never settles. The race-against-budget
    // step takes the full 1500ms; by the time it returns the poll
    // step has zero budget. With a stale registry snapshot the
    // helper falls into the budget-exhausted branch after the
    // (single) sync probe — no scheduled poll fires because the
    // remaining-budget gate rejects re-arming.
    let pollCalls = 0;
    const clock = new FakeClock();
    const promise = gracefullyDetachOutbound({
      client: mkClientHanging(),
      hostId: 'host-x',
      getAttachment: (_h: string) => {
        pollCalls += 1;
        // Stale snapshot — proves the helper isn't accidentally
        // claiming "cleared" because the registry happened to be
        // empty for an unrelated reason. The strict invariant we
        // want to pin: with the budget gone, the helper reports
        // budgetExhausted=true and never re-arms a poll timer.
        return STALE;
      },
      budgetMs: 1500,
      pollIntervalMs: 100,
      now: clock.now,
      setTimeoutImpl: clock.setTimeout,
      clearTimeoutImpl: clock.clearTimeout,
    });
    // Let raceRpc register the RPC + timer.
    await flushMicrotasks();
    // Walk past the full budget — the synthetic-timeout timer fires.
    clock.advance(1_500);
    await flushMicrotasks();
    const out = await promise;
    expect(out.rpc.ok).toBe(false);
    if (!out.rpc.ok) {
      expect(out.rpc.code).toBe('synthetic_timeout');
    }
    expect(out.registryCleared).toBe(false);
    expect(out.budgetExhausted).toBe(true);
    // Exactly one registry read: the synchronous initial probe.
    // No scheduled poll ever fires because remaining()===0 triggers
    // the budget-exhausted bail-out on the very next branch.
    expect(pollCalls).toBe(1);
  });

  it('RPC throws a non-Error value → helper still resolves cleanly', async () => {
    // Defensive case: production code might throw a string or
    // plain object. The helper must not blow up trying to read
    // `.message`.
    const { promise } = startHelper({
      client: mkClientRejecting('something went wrong'),
      hostId: 'host-x',
      snapshots: [null],
    });
    const out = await promise;
    expect(out.rpc).toEqual({
      ok: false,
      error: 'something went wrong',
    });
    expect(out.registryCleared).toBe(true);
  });
});

describe('gracefullyDetachOutbound — degradation paths', () => {
  it('hostId=null → registryCleared:"skipped", helper resolves on IPC settle', async () => {
    // Pre-login quit, or claim never made. Nothing to verify; the
    // IPC hint alone still helps the daemon (it'll noop). Helper
    // returns the skipped marker so the caller's structured log
    // shows the degradation explicitly.
    const { promise } = startHelper({
      client: mkClientResolving('noop'),
      hostId: null,
    });
    const out = await promise;
    expect(out.rpc).toEqual({ ok: true, action: 'noop' });
    expect(out.registryCleared).toBe('skipped');
    expect(out.budgetExhausted).toBe(false);
  });

  it('getAttachment=undefined → registryCleared:"skipped" even with claimed hostId', async () => {
    // Embedded backend already torn down, or registry method not
    // wired in this build. Same skipped marker, distinct cause
    // (the caller knows from `hostId` which side dropped).
    const { promise } = startHelper({
      client: mkClientResolving('detached'),
      hostId: 'host-x',
      noAccessor: true,
    });
    const out = await promise;
    expect(out.rpc).toEqual({ ok: true, action: 'detached' });
    expect(out.registryCleared).toBe('skipped');
    expect(out.budgetExhausted).toBe(false);
  });
});
