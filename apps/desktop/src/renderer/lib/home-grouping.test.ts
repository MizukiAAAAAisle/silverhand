import { describe, expect, it } from "vitest";
import type { ChannelAttentionMode } from "@silverhand/shared";
import { channelRowBadge } from "./attention-mode";
import {
  branchHoldsSelectedRow,
  collapsedGroupRevealBranches,
  collapsedRevealRows,
  excludeStarredChannels,
  isStarredAt,
  isWorkspaceAwake,
  partitionRailWorkspaces,
} from "./home-grouping";

describe("isStarredAt", () => {
  it("treats a timestamp as starred, null/undefined as not", () => {
    expect(isStarredAt(123)).toBe(true);
    expect(isStarredAt(0)).toBe(true); // a real (epoch) timestamp is still starred
    expect(isStarredAt(null)).toBe(false);
    expect(isStarredAt(undefined)).toBe(false);
  });
});

describe("partitionRailWorkspaces (#task:1888 — ownership split only; containers have no star, #task:1900)", () => {
  const ws = (id: string, over: { agentOwned?: boolean; archived?: boolean } = {}) => ({
    id,
    owner_agent_id: over.agentOwned ? `agent-of-${id}` : null,
    archived: over.archived,
  });

  it("splits workspaces by ownership and keeps input order within a group", () => {
    const { agentSpaces, regular } = partitionRailWorkspaces([
      ws("r1"),
      ws("d1", { agentOwned: true }),
      ws("r2"),
      ws("d2", { agentOwned: true }),
    ]);
    expect(regular.map((w) => w.id)).toEqual(["r1", "r2"]);
    expect(agentSpaces.map((w) => w.id)).toEqual(["d1", "d2"]);
  });

  it("DROPS archived workspaces entirely (#task:1889 — no ARCHIVED group in the tree)", () => {
    const { regular, agentSpaces } = partitionRailWorkspaces([
      ws("a1", { archived: true }),
      ws("a2", { archived: true }),
      ws("ad", { agentOwned: true, archived: true }),
      ws("r1"),
    ]);
    expect(regular.map((w) => w.id)).toEqual(["r1"]);
    expect(agentSpaces).toEqual([]);
  });

  // The scope set for STARRED's freshness subscription (#task:1889). The bug this
  // pins is a WIRING bug, not a decision bug: `useFavorites` used to derive its
  // watched workspaces from the favorites rows it was currently showing, so a
  // parent whose last favorite got hidden dropped out of the set and the restore
  // event had nobody listening. Returning the scope from THIS call — the one place
  // that sees the raw input — is what makes "derived from the projection" not
  // expressible; these cells pin that it is strictly WIDER than the home groups.
  it("returns every raw workspace as the watch scope, including ones the tree drops", () => {
    const { agentSpaces, regular, allVisibleIds } = partitionRailWorkspaces([
      ws("r1"),
      ws("a1", { archived: true }),
      ws("d1", { agentOwned: true }),
    ]);
    // `a1` is archived: not in the tree, still watched — a restore is exactly the
    // event that brings its hidden star back.
    expect(allVisibleIds).toEqual(["r1", "a1", "d1"]);
    expect([...regular, ...agentSpaces].map((w) => w.id)).not.toContain("a1");
  });

  it("watches a workspace that contributes NO row at all (zero favorites, zero children)", () => {
    // An empty workspace holds no favorite, so a result-derived scope set excluded
    // it. It must still be watched: that is where a star waits to be restored.
    const { allVisibleIds } = partitionRailWorkspaces([ws("empty")]);
    expect(allVisibleIds).toEqual(["empty"]);
  });
});

describe("excludeStarredChannels (#task:1888 — starred conversations moved to global STARRED)", () => {
  const node = (id: string, starred_at: number | null = null) => ({ id, starred_at });

  it("drops starred channels from the home list, keeping input order", () => {
    const out = excludeStarredChannels([node("c1"), node("c2", 10), node("c3"), node("c4", 20)]);
    expect(out.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("leaves the source list intact (RAW full set still feeds name resolution / Activity)", () => {
    const input = [node("c1", 1), node("c2"), node("c3", 2)];
    expect(excludeStarredChannels(input).map((c) => c.id)).toEqual(["c2"]);
    expect(input).toHaveLength(3);
  });
});

describe("branchHoldsSelectedRow (#task:1901 — which collapsed container keeps the open row)", () => {
  it("holds it for the parent branch of an unstarred selection", () => {
    expect(
      branchHoldsSelectedRow("w1", {
        channelId: "c1",
        workspaceId: "w1",
        starred: "unstarred",
      }),
    ).toBe(true);
  });

  it("does NOT hold it once the selection is starred — STARRED renders that row", () => {
    // The falsifiable case: matching on `workspaceId` alone returns true here and
    // mounts the branch's channels / sort / modes / unread for a row that
    // `excludeStarredChannels` has already moved out of this list.
    expect(
      branchHoldsSelectedRow("w1", {
        channelId: "c1",
        workspaceId: "w1",
        starred: "starred",
      }),
    ).toBe(false);
  });

  it("does NOT hold it while membership is still unknown (cold favorites cache)", () => {
    // The second falsifiable case: treating "the favorites list has not answered"
    // as "not starred" makes this true, and a cold start then mounts the parent
    // branch for a starred selection before unmounting it a round trip later —
    // requests that cannot be taken back. Waiting costs one deferred paint.
    expect(
      branchHoldsSelectedRow("w1", {
        channelId: "c1",
        workspaceId: "w1",
        starred: "unknown",
      }),
    ).toBe(false);
  });

  it("does not hold another workspace’s selection, or none at all", () => {
    expect(
      branchHoldsSelectedRow("w2", {
        channelId: "c1",
        workspaceId: "w1",
        starred: "unstarred",
      }),
    ).toBe(false);
    expect(
      branchHoldsSelectedRow("w1", {
        channelId: null,
        workspaceId: "w1",
        starred: "unstarred",
      }),
    ).toBe(false);
  });
});

describe("isWorkspaceAwake (#task:1939 — the single wake-gate predicate)", () => {
  it("is awake only for a positive badge; a missing badge is NOT awake", () => {
    // The `?? 0` is the point: loading (undefined) and an explicit null must read as
    // asleep, not throw or coerce to awake. A bare `unread > 0` would break here.
    expect(isWorkspaceAwake({ unread: 2 })).toBe(true);
    expect(isWorkspaceAwake({ unread: 0 })).toBe(false);
    expect(isWorkspaceAwake({ unread: null })).toBe(false);
    expect(isWorkspaceAwake({ unread: undefined })).toBe(false);
    expect(isWorkspaceAwake({})).toBe(false);
  });
});

describe("collapsedRevealRows (#task:1939 — collapsed branch poke-out)", () => {
  // A fixture with just enough to drive the two seams: `excludeStarredChannels`
  // reads `starred_at`, and the real `channelRowBadge` reads the tier inputs — so
  // "loud" here is the SAME verdict the row paints, not a test-local flag.
  interface Fx {
    id: string;
    starred_at: number | null;
    mode: ChannelAttentionMode | undefined;
    unread: number;
    directed: number;
  }
  const fx = (id: string, over: Partial<Fx> = {}): Fx => ({
    id,
    starred_at: null,
    mode: "all",
    unread: 0,
    directed: 0,
    ...over,
  });
  const isLoud = (c: Fx) =>
    channelRowBadge({
      effectiveMode: c.mode,
      positionalUnread: c.unread,
      directedUnread: c.directed,
    })?.tier === "loud";
  // The exact production wiring: exclude starred FIRST, then union {selected} ∪
  // {loud}, with `loud` decided by the real badge predicate. `pokeUnread` is the
  // branch's WAKE GATE — a SEPARATE input from "the branch is collapsed".
  const revealed = (items: Fx[], opts: { selectedId: string | null; pokeUnread: boolean }) =>
    collapsedRevealRows(excludeStarredChannels(items), {
      pokeUnread: opts.pokeUnread,
      isSelected: (c) => c.id === opts.selectedId,
      isLoud,
    }).map((c) => c.id);

  it("wake gate on reveals {selected} ∪ {loud}; a quiet row stays hidden", () => {
    const items = [
      fx("sel", { mode: "all", unread: 0 }), // selected, no unread → kept anyway
      fx("loud", { mode: "all", unread: 3 }), // positional loud → poked out
      fx("quiet", { mode: "mentions", unread: 2 }), // ambient residue → quiet, hidden
    ];
    expect(revealed(items, { selectedId: "sel", pokeUnread: true })).toEqual(["sel", "loud"]);
  });

  it("a directed claim under mute is loud and pokes out (tracks the real verdict, not just positional)", () => {
    const items = [fx("mention", { mode: "mute", unread: 0, directed: 1 })];
    expect(revealed(items, { selectedId: null, pokeUnread: true })).toEqual(["mention"]);
  });

  it("a starred loud row is excluded BEFORE reveal — it lives in STARRED (#task:1888)", () => {
    const items = [
      fx("sel", { unread: 0 }),
      fx("star", { starred_at: 10, mode: "all", unread: 5 }), // loud but starred
    ];
    // The accepted empty-reveal case: `star` counts toward the wake badge yet
    // never surfaces here, so a workspace whose only loud row is starred pokes
    // out nothing. An EMPTY reveal is the contract the collapsed-group caption keys
    // off (#task:1939): the branch mounts on its lit wake gate, but with no revealed
    // row `WorkspaceChannels` renders nothing — so no orphan workspace caption.
    expect(revealed(items, { selectedId: "sel", pokeUnread: true })).toEqual(["sel"]);
    expect(
      revealed([fx("star", { starred_at: 10, mode: "all", unread: 5 })], {
        selectedId: null,
        pokeUnread: true,
      }),
    ).toEqual([]);
  });

  it("a lit wake gate with only loading/failed rows reveals nothing (no orphan caption, #task:1939)", () => {
    // Loading / failure: attention has not resolved, so `effectiveMode` is undefined
    // and `channelRowBadge` returns null — the row is not `loud`. The workspace wake
    // badge (an aggregate on a different cache) can still be lit, mounting this branch
    // in the collapsed group; the reveal set must be empty regardless, so a caption
    // co-fated with it never appears with no channels under it (fabricates nothing).
    const items = [fx("pending", { mode: undefined, unread: 3 })];
    expect(revealed(items, { selectedId: null, pokeUnread: true })).toEqual([]);
  });

  it("section collapse (wake gate off) does NOT poke — only the selected row survives", () => {
    const items = [fx("sel", { unread: 0 }), fx("loud", { mode: "all", unread: 4 })];
    expect(revealed(items, { selectedId: "sel", pokeUnread: false })).toEqual(["sel"]);
  });

  it("section collapse with nothing selected reveals an empty set", () => {
    const items = [fx("loud", { mode: "all", unread: 4 })];
    expect(revealed(items, { selectedId: null, pokeUnread: false })).toEqual([]);
  });

  it("a branch mounted to keep the selection while the wake gate is DARK does not poke a stale loud sibling (#task:1939, @Cindy MUST FIX)", () => {
    // The regression this pins: a branch can mount collapsed purely because it
    // holds the open row (`branchHoldsSelectedRow`), with the workspace badge
    // UNLIT. Wiring the poke to `!expanded` instead of the wake gate would then
    // reveal a `loud` sibling left in the row-level cache — a different cache from
    // the badge, so the two can disagree for a frame. The ONLY difference between
    // reveal and no-reveal here is `pokeUnread`, so it must be the wake gate.
    const items = [
      fx("sel", { unread: 0 }),
      fx("sibling", { mode: "all", unread: 2 }), // loud in cache, but badge dark
    ];
    expect(revealed(items, { selectedId: "sel", pokeUnread: false })).toEqual(["sel"]);
    // Same rows, gate lit → the sibling pokes out. Nothing but the gate changed.
    expect(revealed(items, { selectedId: "sel", pokeUnread: true })).toEqual(["sel", "sibling"]);
  });
});

describe("collapsedGroupRevealBranches (#task:1939 — which branches a collapsed GROUP reveals)", () => {
  interface W {
    id: string;
    holds: boolean;
    unread: number;
  }
  const branches = (items: W[]) =>
    collapsedGroupRevealBranches(items, {
      holdsSelection: (w) => w.holds,
      isAwake: (w) => w.unread > 0,
    }).map((w) => w.id);

  it("reveals awake branches and the selected branch, excluding quiet unselected ones", () => {
    const items = [
      { id: "quiet", holds: false, unread: 0 }, // neither → NOT mounted (constraint ②)
      { id: "sel", holds: true, unread: 0 }, // selected, even with a dark badge
      { id: "awake", holds: false, unread: 2 }, // lit wake gate → revealed
    ];
    expect(branches(items)).toEqual(["sel", "awake"]);
  });

  it("puts the selected branch FIRST, keeping the rest in input (sort) order", () => {
    const items = [
      { id: "a", holds: false, unread: 1 },
      { id: "b", holds: false, unread: 3 },
      { id: "sel", holds: true, unread: 0 },
    ];
    expect(branches(items)).toEqual(["sel", "a", "b"]);
  });

  it("with no selection here (e.g. a starred selection), reveals only the awake branches", () => {
    // A starred selection makes `holdsSelection` false everywhere — its row is
    // STARRED's — so nothing is force-mounted; only genuinely awake branches show.
    const items = [
      { id: "quiet", holds: false, unread: 0 },
      { id: "awake", holds: false, unread: 5 },
    ];
    expect(branches(items)).toEqual(["awake"]);
  });

  it("reveals nothing when the group is fully quiet and holds no selection", () => {
    const items = [
      { id: "a", holds: false, unread: 0 },
      { id: "b", holds: false, unread: 0 },
    ];
    expect(branches(items)).toEqual([]);
  });
});
