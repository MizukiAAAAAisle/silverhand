import { describe, expect, it } from "vitest";
import { sortGroupByMode, type SortableEntry } from "./list-sort";

/** #task:1146 within-group sort. Star/group membership is partitioned by
 *  the caller, so these tests only cover ordering within a single group by
 *  the viewer's chosen mode, plus the determinism guarantees. */

function entry(over: Partial<SortableEntry> & { id: string }): SortableEntry {
  return {
    rank: null,
    lastAccessedAt: null,
    createdAt: 0,
    ...over,
  };
}

const ids = (items: SortableEntry[]): string[] => items.map((i) => i.id);

describe("sortGroupByMode — manual mode", () => {
  it("orders ranked items by rank ascending", () => {
    const items = [
      entry({ id: "c", rank: 3 }),
      entry({ id: "a", rank: 1 }),
      entry({ id: "b", rank: 2 }),
    ];
    expect(ids(sortGroupByMode(items, "manual"))).toEqual(["a", "b", "c"]);
  });

  it("places never-ranked items after ranked ones, by createdAt ascending", () => {
    const items = [
      entry({ id: "new-late", rank: null, createdAt: 200 }),
      entry({ id: "ranked", rank: 5, createdAt: 999 }),
      entry({ id: "new-early", rank: null, createdAt: 100 }),
    ];
    // ranked first (regardless of createdAt), then unranked oldest-first.
    expect(ids(sortGroupByMode(items, "manual"))).toEqual(["ranked", "new-early", "new-late"]);
  });

  it("falls back to createdAt then id when ranks collide", () => {
    const items = [
      entry({ id: "b", rank: 1, createdAt: 50 }),
      entry({ id: "a", rank: 1, createdAt: 50 }),
    ];
    expect(ids(sortGroupByMode(items, "manual"))).toEqual(["a", "b"]);
  });
});

describe("sortGroupByMode — recent mode", () => {
  it("orders accessed items most-recent-first", () => {
    const items = [
      entry({ id: "old", lastAccessedAt: 100 }),
      entry({ id: "newest", lastAccessedAt: 300 }),
      entry({ id: "mid", lastAccessedAt: 200 }),
    ];
    expect(ids(sortGroupByMode(items, "recent"))).toEqual(["newest", "mid", "old"]);
  });

  it("places never-accessed items after accessed ones, by createdAt ascending", () => {
    const items = [
      entry({ id: "never-late", lastAccessedAt: null, createdAt: 200 }),
      entry({ id: "accessed", lastAccessedAt: 10, createdAt: 999 }),
      entry({ id: "never-early", lastAccessedAt: null, createdAt: 100 }),
    ];
    expect(ids(sortGroupByMode(items, "recent"))).toEqual([
      "accessed",
      "never-early",
      "never-late",
    ]);
  });

  it("with no access history at all, keeps the default oldest-first order", () => {
    const items = [
      entry({ id: "c", createdAt: 3 }),
      entry({ id: "a", createdAt: 1 }),
      entry({ id: "b", createdAt: 2 }),
    ];
    expect(ids(sortGroupByMode(items, "recent"))).toEqual(["a", "b", "c"]);
  });

  it("falls back to createdAt then id when access times collide", () => {
    const items = [
      entry({ id: "b", lastAccessedAt: 5, createdAt: 7 }),
      entry({ id: "a", lastAccessedAt: 5, createdAt: 7 }),
    ];
    expect(ids(sortGroupByMode(items, "recent"))).toEqual(["a", "b"]);
  });
});

describe("sortGroupByMode — guarantees", () => {
  it("is deterministic regardless of input order", () => {
    const a = entry({ id: "a", rank: 2, createdAt: 1 });
    const b = entry({ id: "b", rank: 1, createdAt: 2 });
    const c = entry({ id: "c", rank: null, createdAt: 3 });
    expect(ids(sortGroupByMode([a, b, c], "manual"))).toEqual(
      ids(sortGroupByMode([c, b, a], "manual")),
    );
  });

  it("does not mutate the input array", () => {
    const items = [entry({ id: "b", rank: 2 }), entry({ id: "a", rank: 1 })];
    const before = ids(items);
    sortGroupByMode(items, "manual");
    expect(ids(items)).toEqual(before);
  });

  it("handles empty and single-item groups", () => {
    expect(sortGroupByMode([], "manual")).toEqual([]);
    const one = [entry({ id: "solo" })];
    expect(ids(sortGroupByMode(one, "recent"))).toEqual(["solo"]);
  });
});
