// The foreign-workspace reconcile SCHEDULER (#task:1689, review round 2).
//
// Everything asserted here is scheduling and failure classification — the two
// things that were wrong in round 1 — and none of it needs React:
//   1. COALESCING (blocker 1): notices that arrive while a probe runs must all be
//      answered. The falsifier is the last-write-wins slot: c2 arriving during
//      c1's probe and c3 right after it left only c3 queued, and c2 — possibly the
//      actual removal — was never re-read.
//   2. FAILURE CLASSIFICATION (blocker 4): 403/404 from the authoritative lists is
//      "the viewer lost the WORKSPACE", the one failure that must act, because the
//      workspace scope is truncated and no later notice arrives. Every other
//      failure (5xx, timeout, unreachable backend) must leave the caches alone: a
//      failed read is not evidence of a removal.
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  createForeignWorkspaceReconciler,
  mergeReconcileScope,
} from "./foreign-workspace-reconcile";
import type { ChannelMembershipLoss, ChannelMembershipRow } from "./viewer-channel-removal";

const WS = "ws-b";

const member = (id: string): ChannelMembershipRow => ({
  id,
  is_member: true,
  visibility: "private",
});

/** A fetcher whose every call can be resolved by hand, so a notice can be proven
 *  to arrive WHILE a probe is in flight rather than merely near it. */
function gatedFetcher(tablesFor: (call: number) => readonly ChannelMembershipRow[]) {
  const pending: Array<() => void> = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetchTables: () => {
      const call = ++calls;
      return new Promise<{
        active: readonly ChannelMembershipRow[];
        archived: readonly ChannelMembershipRow[];
      }>((resolve) => {
        pending.push(() => resolve({ active: tablesFor(call), archived: [] }));
      });
    },
    /** Release the oldest in-flight read and let its continuation run. */
    async release() {
      const next = pending.shift();
      expect(next, "expected a read to be in flight").toBeDefined();
      next?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    get inFlight() {
      return pending.length;
    },
  };
}

describe("mergeReconcileScope", () => {
  const set = (...ids: string[]) => new Set(ids);

  it("the first notice is taken as-is", () => {
    expect(mergeReconcileScope(undefined, set("c1"))).toEqual(set("c1"));
    expect(mergeReconcileScope(undefined, null)).toBeNull();
  });

  it("two narrow notices UNION — neither channel may be dropped", () => {
    expect(mergeReconcileScope(set("c2"), set("c3"))).toEqual(set("c2", "c3"));
  });

  it("`null` (unknown extent) absorbs everything, in both directions", () => {
    // `snapshot_required` is already the widest question, so narrowing it would
    // lose the events the gap swallowed.
    expect(mergeReconcileScope(null, set("c3"))).toBeNull();
    expect(mergeReconcileScope(set("c2"), null)).toBeNull();
  });
});

describe("foreign-workspace reconciler (#task:1689 blocker 1)", () => {
  function harness(input: {
    held: string[];
    tablesFor: (call: number) => readonly ChannelMembershipRow[];
  }) {
    const fetcher = gatedFetcher(input.tablesFor);
    const losses: Array<{ workspaceId: string; loss: ChannelMembershipLoss }> = [];
    const unreadable: Array<{ workspaceId: string; held: readonly string[] }> = [];
    const reconciler = createForeignWorkspaceReconciler({
      fetchTables: fetcher.fetchTables,
      heldChannelIds: () => new Set(input.held),
      onLoss: (workspaceId, loss) => losses.push({ workspaceId, loss }),
      onWorkspaceUnreadable: (workspaceId, held) => unreadable.push({ workspaceId, held }),
    });
    return { fetcher, losses, unreadable, reconciler };
  }

  it("a notice arriving DURING a probe is answered, and so is the one after it", async () => {
    // The first read still sees c2 and c3; by the coalesced second read all three
    // are gone. So c2 can only be reported if its notice survived the merge —
    // which is exactly what a last-write-wins slot loses.
    const survivors: Record<number, string[]> = { 1: ["c2", "c3"], 2: [] };
    const h = harness({
      held: ["c1", "c2", "c3"],
      tablesFor: (call) => (survivors[call] ?? []).map(member),
    });

    h.reconciler.request(WS, new Set(["c1"])); // starts a probe immediately
    expect(h.fetcher.calls).toBe(1);
    // Both arrive while probe 1 is frozen.
    h.reconciler.request(WS, new Set(["c2"]));
    h.reconciler.request(WS, new Set(["c3"]));
    expect(h.fetcher.calls).toBe(1); // never two probes at once for one workspace

    await h.fetcher.release(); // probe 1 completes → the coalesced follow-up starts
    expect(h.fetcher.calls).toBe(2); // ONE follow-up, asking about c2 AND c3
    await h.fetcher.release();
    await h.reconciler.settled();

    // FALSIFIER: with a last-write-wins slot, c2 is absent here.
    expect(h.losses.map((l) => l.loss.channelId).sort()).toEqual(["c1", "c2", "c3"]);
    expect(h.losses.every((l) => l.workspaceId === WS)).toBe(true);
  });

  it("a narrow notice for a channel the client holds nothing for costs no request", async () => {
    const h = harness({ held: ["c1"], tablesFor: () => [] });
    h.reconciler.request(WS, new Set(["c9"]));
    await h.reconciler.settled();
    expect(h.fetcher.calls).toBe(0);
    expect(h.losses).toEqual([]);
  });

  it("a `null` scope asks about every held channel (the gap-recovery arm)", async () => {
    const h = harness({ held: ["c1", "c2"], tablesFor: () => [member("c2")] });
    h.reconciler.request(WS, null);
    await h.fetcher.release();
    await h.reconciler.settled();
    expect(h.losses.map((l) => l.loss)).toEqual([{ channelId: "c1", mode: "visibility-loss" }]);
  });

  it("dispose stops the queued follow-up and ignores a late completion", async () => {
    const h = harness({ held: ["c1", "c2"], tablesFor: () => [] });
    h.reconciler.request(WS, new Set(["c1"]));
    h.reconciler.request(WS, new Set(["c2"]));
    h.reconciler.dispose();
    await h.fetcher.release();
    expect(h.fetcher.calls).toBe(1); // the queued notice never starts
    expect(h.losses).toEqual([]); // and the unmounted probe touches nothing
  });
});

describe("failure classification (#task:1689 blocker 4)", () => {
  function rejecting(error: unknown, held: string[]) {
    const losses: ChannelMembershipLoss[] = [];
    const unreadable: Array<{ workspaceId: string; held: readonly string[] }> = [];
    const reconciler = createForeignWorkspaceReconciler({
      fetchTables: () => Promise.reject(error),
      heldChannelIds: () => new Set(held),
      onLoss: (_ws, loss) => losses.push(loss),
      onWorkspaceUnreadable: (workspaceId, h) => unreadable.push({ workspaceId, held: h }),
    });
    return { losses, unreadable, reconciler };
  }

  for (const status of [403, 404]) {
    it(`${status} means the WORKSPACE is gone: every held channel is handed over at once`, async () => {
      // Both list routes gate on `canViewWorkspace`, so losing the workspace
      // surfaces as a refused read on both — never as "absent from both tables".
      const h = rejecting(new ApiError(status, "no", ""), ["c1", "c2"]);
      h.reconciler.request(WS, new Set(["c1"]));
      await h.reconciler.settled();
      expect(h.unreadable).toEqual([{ workspaceId: WS, held: ["c1", "c2"] }]);
      // Not resolved per channel: a narrow notice must not shrink a whole-workspace
      // fact down to the one channel it happened to name.
      expect(h.losses).toEqual([]);
    });
  }

  for (const [label, error] of [
    ["5xx", new ApiError(500, "boom", "")],
    ["backend unreachable", new ApiError(0, "unreachable", "", "backend_unreachable")],
    ["a non-API throw", new TypeError("fetch failed")],
  ] as const) {
    it(`${label} converges NOTHING — a failed read is not evidence of a removal`, async () => {
      const h = rejecting(error, ["c1", "c2"]);
      h.reconciler.request(WS, null);
      await h.reconciler.settled();
      expect(h.unreadable).toEqual([]);
      expect(h.losses).toEqual([]);
    });
  }

  it("after a failure the NEXT notice still probes (no latched-off state)", async () => {
    let call = 0;
    const losses: ChannelMembershipLoss[] = [];
    const reconciler = createForeignWorkspaceReconciler({
      fetchTables: () =>
        ++call === 1
          ? Promise.reject(new ApiError(500, "boom", ""))
          : Promise.resolve({ active: [], archived: [] }),
      heldChannelIds: () => new Set(["c1"]),
      onLoss: (_ws, loss) => losses.push(loss),
      onWorkspaceUnreadable: () => {},
    });
    reconciler.request(WS, null);
    await reconciler.settled();
    expect(losses).toEqual([]);
    reconciler.request(WS, null);
    await reconciler.settled();
    expect(losses).toEqual([{ channelId: "c1", mode: "visibility-loss" }]);
  });
});
