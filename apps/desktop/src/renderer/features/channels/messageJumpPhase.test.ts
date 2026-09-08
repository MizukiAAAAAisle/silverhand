import { describe, expect, it } from "vitest";
import { jumpWindowLockedForPhase, threadLocateAllowed } from "./messageJumpPhase";
import { threadClusterShowsLoader } from "@/features/conversation-shell/model/thread-mark-read";

// These blocks hang on the SINGLE window-lock / locate predicates that every
// consumer imports (#task:1317, Cindy blocking): the jump controller's
// `isPrimePendingFor` feeds the real cluster/channel query lock through
// `jumpWindowLockedForPhase`, and ThreadPanel gates its cluster query + locate
// on the very same two functions — so covering them here covers the actual
// runtime logic, not a look-alike copy that could drift.

describe("jumpWindowLockedForPhase — window-lock projection + clobber boundary (#task:1317)", () => {
  it("LOCKS while priming (fetch in flight)", () => {
    expect(jumpWindowLockedForPhase("priming")).toBe(true);
  });

  it("STAYS LOCKED at committed — the clobber boundary", () => {
    // The blocking Cindy/Alice caught: committed must NOT release the query.
    // If it did, the re-enabled query could fire a latest fetch that clobbers
    // the around-window primeAround wrote, and locate would poll the clobbered
    // window. committed = "render released, window still locked".
    expect(jumpWindowLockedForPhase("committed")).toBe(true);
  });

  it("RELEASES at settled (no authoritative window → fallback latest may fill)", () => {
    expect(jumpWindowLockedForPhase("settled")).toBe(false);
  });

  it("RELEASES with no active jump (null)", () => {
    expect(jumpWindowLockedForPhase(null)).toBe(false);
  });
});

describe("threadLocateAllowed — phase-gated, bounded-exit locate (#task:1317)", () => {
  it("WHILE PRIMING: does NOT locate — window undefined / possibly stale", () => {
    // The original mis-anchor bug: polling a still-fetching or previous-open
    // stale window. Must wait; the effect re-runs when the phase advances.
    expect(threadLocateAllowed("priming")).toBe(false);
  });

  it("COMMITTED: locates against the authoritative (still-locked) around-window", () => {
    expect(threadLocateAllowed("committed")).toBe(true);
  });

  it("SETTLED: best-effort locate against whatever is loaded (bounded give-up)", () => {
    expect(threadLocateAllowed("settled")).toBe(true);
  });

  it("no active jump (null) → does not locate", () => {
    expect(threadLocateAllowed(null)).toBe(false);
  });
});

describe("#task:1317 no-deadlock invariant (loader/locate both exit at committed)", () => {
  it("committed → loader falls AND locate allowed → the deadlock loop is broken", () => {
    // The P0 was: loader + locate both gated on a wall-clock epoch that could
    // stay false forever, and clearing the jump required locate to run. Here
    // committed unconditionally (a) drops the loader and (b) permits locate,
    // with the window still lock-protected — so the jump always reaches
    // onJumped → clearJump. No wall-clock, no unterminated loop.
    expect(threadClusterShowsLoader({ isLoading: false, jumpPhase: "committed" })).toBe(false);
    expect(threadLocateAllowed("committed")).toBe(true);
    expect(jumpWindowLockedForPhase("committed")).toBe(true);
  });

  it("LOCK BOUNDARY: committed renders BUT is still window-locked (clobber race closed by the lock, not the loader)", () => {
    // The invariant most likely to be mis-refactored away: at committed the
    // loader falls (render released) AND the window is still locked. Prove BOTH
    // together so no future change trades the lock for "the loader will fall".
    expect(threadClusterShowsLoader({ isLoading: false, jumpPhase: "committed" })).toBe(false);
    expect(jumpWindowLockedForPhase("committed")).toBe(true);
  });
});
