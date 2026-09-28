import { describe, expect, it } from "vitest";
import { makePinchZoomLease } from "./pinch-zoom-lease";

describe("makePinchZoomLease", () => {
  it("enables on the first acquire and disables on the last release", () => {
    const calls: boolean[] = [];
    const lease = makePinchZoomLease((v) => calls.push(v));

    const releaseA = lease.acquire();
    const releaseB = lease.acquire();
    expect(calls).toEqual([true]); // only the first acquire flips it on

    releaseA();
    expect(calls).toEqual([true]); // a peer still holds it — not closed early

    releaseB();
    expect(calls).toEqual([true, false]); // last release turns it off
  });

  it("re-enables after a full release cycle", () => {
    const calls: boolean[] = [];
    const lease = makePinchZoomLease((v) => calls.push(v));

    lease.acquire()();
    lease.acquire();
    expect(calls).toEqual([true, false, true]);
  });

  it("ignores a double release", () => {
    const calls: boolean[] = [];
    const lease = makePinchZoomLease((v) => calls.push(v));

    const release = lease.acquire();
    release();
    release();
    expect(calls).toEqual([true, false]);
  });
});
