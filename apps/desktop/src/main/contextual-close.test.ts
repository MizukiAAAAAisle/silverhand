import { describe, expect, it } from 'vitest';
import {
  ContextualCloseCoordinator,
  type CloseTarget,
  type Scheduler,
} from './contextual-close.js';

/** A fake window: records the reqIds it was asked to send and exposes a
 *  controllable webContents id + destroyed flag. */
class FakeTarget implements CloseTarget {
  sentReqIds: string[] = [];
  destroyed = false;
  /** Simulate Electron's `webContents.send` throwing when the transport is
   *  gone (webContents destroyed/crashed after the liveness check). */
  throwOnSend = false;

  constructor(readonly webContentsId: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  sendRequest(reqId: string): void {
    if (this.throwOnSend) {
      throw new Error('webContents destroyed');
    }
    this.sentReqIds.push(reqId);
  }
}

/** A manual scheduler: timers never fire on their own — the test fires them by
 *  hand so timeout behavior is deterministic. */
class ManualScheduler implements Scheduler {
  #next = 0;
  readonly #timers = new Map<number, () => void>();

  set(fn: () => void, _ms: number): unknown {
    const id = ++this.#next;
    this.#timers.set(id, fn);
    return id;
  }

  clear(token: unknown): void {
    this.#timers.delete(token as number);
  }

  /** Fire every timer still registered (i.e. not cleared). */
  fireAll(): void {
    for (const [id, fn] of [...this.#timers]) {
      this.#timers.delete(id);
      fn();
    }
  }

  get liveCount(): number {
    return this.#timers.size;
  }
}

function make(): {
  coord: ContextualCloseCoordinator;
  sched: ManualScheduler;
  /** How many times the app was sent to background. */
  bg: () => number;
} {
  const sched = new ManualScheduler();
  let backgroundCount = 0;
  const coord = new ContextualCloseCoordinator(sched, 250, () => {
    backgroundCount += 1;
  });
  return { coord, sched, bg: () => backgroundCount };
}

describe('ContextualCloseCoordinator', () => {
  it('begin sends a request to the triggering window and registers it pending', () => {
    const { coord } = make();
    const win = new FakeTarget(7);

    coord.begin(win);

    expect(win.sentReqIds).toHaveLength(1);
    expect(coord.pendingCount).toBe(1);
  });

  it('sends the app to background only on background-app from the correct sender', () => {
    const { coord, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    coord.resolve(7, win.sentReqIds[0]!, 'background-app');

    expect(bg()).toBe(1);
    expect(coord.pendingCount).toBe(0);
  });

  it.each(['blocked', 'closed-panel', 'unknown-junk', ''])(
    'does NOT background on non-background outcome %p',
    (outcome) => {
      const { coord, bg } = make();
      const win = new FakeTarget(7);

      coord.begin(win);
      coord.resolve(7, win.sentReqIds[0]!, outcome);

      expect(bg()).toBe(0);
      // The reqId is still consumed (no replay possible), but nothing happens.
      expect(coord.pendingCount).toBe(0);
    },
  );

  it('ignores a reply from the wrong webContents (spoofed / stale sender)', () => {
    const { coord, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    coord.resolve(999, win.sentReqIds[0]!, 'background-app');

    expect(bg()).toBe(0);
    // Wrong sender must NOT consume the request — the real sender can still win.
    expect(coord.pendingCount).toBe(1);
    coord.resolve(7, win.sentReqIds[0]!, 'background-app');
    expect(bg()).toBe(1);
  });

  it('ignores an unknown reqId (late / never-issued)', () => {
    const { coord, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    coord.resolve(7, 'close-does-not-exist', 'background-app');

    expect(bg()).toBe(0);
    expect(coord.pendingCount).toBe(1);
  });

  it('ignores a replayed reply (reqId consumed after first resolve)', () => {
    const { coord, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    const reqId = win.sentReqIds[0]!;
    coord.resolve(7, reqId, 'background-app');
    coord.resolve(7, reqId, 'background-app'); // replay

    expect(bg()).toBe(1); // not 2
  });

  it('fails closed on timeout — a later reply is a no-op', () => {
    const { coord, sched, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    sched.fireAll(); // renderer never answered

    expect(coord.pendingCount).toBe(0);
    coord.resolve(7, win.sentReqIds[0]!, 'background-app'); // too late
    expect(bg()).toBe(0);
  });

  it('cancels the timer once resolved so it cannot fire afterward', () => {
    const { coord, sched, bg } = make();
    const win = new FakeTarget(7);

    coord.begin(win);
    coord.resolve(7, win.sentReqIds[0]!, 'background-app');

    expect(sched.liveCount).toBe(0); // timer cleared
    sched.fireAll(); // no-op — nothing registered
    expect(bg()).toBe(1); // still just the one background
  });

  it('binds each press to its own captured window (focus switch)', () => {
    const { coord, bg } = make();
    const winA = new FakeTarget(1);
    const winB = new FakeTarget(2);

    coord.begin(winA); // ⌘W while A focused
    coord.begin(winB); // focus moved to B, ⌘W again

    // Each reply is authenticated against the window that originated its reqId.
    coord.resolve(1, winA.sentReqIds[0]!, 'background-app');
    expect(bg()).toBe(1);
    coord.resolve(2, winB.sentReqIds[0]!, 'background-app');
    expect(bg()).toBe(2);
  });

  it('does not cross the streams: A sender id cannot answer B reqId', () => {
    const { coord, bg } = make();
    const winA = new FakeTarget(1);
    const winB = new FakeTarget(2);

    coord.begin(winA);
    coord.begin(winB);

    // A's webContents replying to B's reqId → wrong sender, ignored.
    coord.resolve(1, winB.sentReqIds[0]!, 'background-app');
    expect(bg()).toBe(0);
  });

  it('no-ops begin on an already-destroyed window (no send, nothing pending)', () => {
    const { coord } = make();
    const win = new FakeTarget(7);
    win.destroyed = true;

    coord.begin(win);

    expect(win.sentReqIds).toHaveLength(0);
    expect(coord.pendingCount).toBe(0);
  });

  it('fails closed when send throws (transport race) — no throw, no pending, no timer', () => {
    const { coord, sched, bg } = make();
    const win = new FakeTarget(7);
    win.throwOnSend = true; // webContents died between liveness check and send

    // The exception must NOT escape begin() (it would surface out of the menu
    // click handler otherwise).
    expect(() => coord.begin(win)).not.toThrow();

    expect(bg()).toBe(0);
    expect(coord.pendingCount).toBe(0); // rolled back immediately, not left to timeout
    expect(sched.liveCount).toBe(0); // timer cleared, won't fire later
  });

  it('a reqId whose send threw cannot be resolved afterward', () => {
    const { coord, bg } = make();
    const win = new FakeTarget(7);
    win.throwOnSend = true;

    coord.begin(win);
    // The reqId the renderer would have received is `close-1`; even a
    // well-formed reply is a no-op because nothing is pending.
    coord.resolve(7, 'close-1', 'background-app');

    expect(bg()).toBe(0);
  });
});
