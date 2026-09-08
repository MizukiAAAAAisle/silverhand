import { describe, expect, it } from "vitest";
import { foldHostAvailability, foldHostAvailabilityQueries } from "./hooks";

describe("foldHostAvailability", () => {
  it("reports a checking host as undefined (not selectable) and unsettled", () => {
    const { availabilityById, allSettled } = foldHostAvailability([
      { id: "a", checking: true, availability: undefined },
    ]);
    expect(availabilityById.get("a")).toBeUndefined();
    expect(allSettled).toBe(false);
  });

  it("never trusts a stale available while a refetch is in flight", () => {
    // `checking` wins even when a stale `available` sits in cache — the picker
    // must show "Checking…" until the fresh probe lands.
    const { availabilityById, allSettled } = foldHostAvailability([
      { id: "a", checking: true, availability: "available" },
    ]);
    expect(availabilityById.get("a")).toBeUndefined();
    expect(allSettled).toBe(false);
  });

  it("stays unsettled while any host is still checking (P1 guard)", () => {
    // The exact race Cindy caught: one probe settled available, the other
    // still checking. `allSettled` must be false so the caller does NOT
    // auto-select the sole currently-available host.
    const { availabilityById, allSettled } = foldHostAvailability([
      { id: "a", checking: false, availability: "available" },
      { id: "b", checking: true, availability: undefined },
    ]);
    expect(availabilityById.get("a")).toBe("available");
    expect(availabilityById.get("b")).toBeUndefined();
    expect(allSettled).toBe(false);
  });

  it("settles with both online → caller sees two available (no default)", () => {
    const { availabilityById, allSettled } = foldHostAvailability([
      { id: "a", checking: false, availability: "available" },
      { id: "b", checking: false, availability: "available" },
    ]);
    expect([...availabilityById.values()]).toEqual(["available", "available"]);
    expect(allSettled).toBe(true);
  });

  it("surfaces a settled offline availability verbatim", () => {
    const { availabilityById, allSettled } = foldHostAvailability([
      { id: "a", checking: false, availability: "disconnected" },
    ]);
    expect(availabilityById.get("a")).toBe("disconnected");
    expect(allSettled).toBe(true);
  });

  it("an empty candidate set is trivially settled", () => {
    const { availabilityById, allSettled } = foldHostAvailability([]);
    expect(availabilityById.size).toBe(0);
    expect(allSettled).toBe(true);
  });
});

describe("foldHostAvailabilityQueries — freshness ≠ fact (#task:1376)", () => {
  it("initial pending (no settled data) → checking, unsettled", () => {
    const { availabilityById, allSettled } = foldHostAvailabilityQueries([
      { id: "a", isPending: true, availability: undefined },
    ]);
    expect(availabilityById.get("a")).toBeUndefined();
    expect(allSettled).toBe(false);
  });

  it("background refetch of settled data KEEPS the last availability", () => {
    // The jitter fix: a 5s hostStatusKey poll makes this query `isFetching` but
    // NOT `isPending` (data already settled). Availability must NOT blank —
    // otherwise the selected host flickers to "unavailable" and the centered
    // create dialog re-centers. `isPending: false` is the refetch-with-data case.
    const { availabilityById, allSettled } = foldHostAvailabilityQueries([
      { id: "a", isPending: false, availability: "available" },
    ]);
    expect(availabilityById.get("a")).toBe("available");
    expect(allSettled).toBe(true);
  });

  it("a real offline still propagates (settled non-available flips)", () => {
    const { availabilityById, allSettled } = foldHostAvailabilityQueries([
      { id: "a", isPending: false, availability: "disconnected" },
    ]);
    expect(availabilityById.get("a")).toBe("disconnected");
    expect(allSettled).toBe(true);
  });

  it("errored settled probe (no data) → unavailable + settled, not stuck checking", () => {
    // status='error' → isPending false, no availability. Must settle (allSettled
    // true) so the dialog doesn't hang on "Checking…" forever, and read as
    // unavailable (undefined) rather than a phantom available.
    const { availabilityById, allSettled } = foldHostAvailabilityQueries([
      { id: "a", isPending: false, availability: undefined },
    ]);
    expect(availabilityById.get("a")).toBeUndefined();
    expect(allSettled).toBe(true);
  });

  it("staggered probes: one settled available, one still pending → no default", () => {
    // P1 preserved at the query layer: allSettled stays false while any host is
    // pending its FIRST probe, so a transient single-available never auto-selects.
    const { availabilityById, allSettled } = foldHostAvailabilityQueries([
      { id: "a", isPending: false, availability: "available" },
      { id: "b", isPending: true, availability: undefined },
    ]);
    expect(availabilityById.get("a")).toBe("available");
    expect(availabilityById.get("b")).toBeUndefined();
    expect(allSettled).toBe(false);
  });
});
