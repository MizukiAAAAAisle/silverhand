import { describe, expect, it } from "vitest";
import { pickDefaultChannel, pickFallbackAfterArchive } from "./archive-fallback";

const list = (...ids: string[]): Array<{ id: string }> => ids.map((id) => ({ id }));

describe("pickFallbackAfterArchive", () => {
  it("prefers the NEXT active top-level channel (sidebar order)", () => {
    // Archiving 'b' (middle) → land on 'c', the one below it.
    expect(pickFallbackAfterArchive(list("a", "b", "c"), "b")).toBe("c");
  });

  it("falls back to the PREVIOUS channel when the archived one is last", () => {
    expect(pickFallbackAfterArchive(list("a", "b", "c"), "c")).toBe("b");
  });

  it("picks the next channel when archiving the first", () => {
    expect(pickFallbackAfterArchive(list("a", "b", "c"), "a")).toBe("b");
  });

  it("returns null when the archived channel was the only one", () => {
    // No neighbors remain → caller clears to the workspace empty state.
    expect(pickFallbackAfterArchive(list("a"), "a")).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickFallbackAfterArchive([], "a")).toBeNull();
  });

  it("falls back to the first remaining channel when the archived id is absent", () => {
    // Defensive: list already refetched / id not top-level — still give a
    // sensible primary instead of clearing.
    expect(pickFallbackAfterArchive(list("a", "b"), "zzz")).toBe("a");
  });

  it("returns null when the archived id is absent AND no others exist", () => {
    expect(pickFallbackAfterArchive(list("a"), "a")).toBeNull();
    expect(pickFallbackAfterArchive([], "zzz")).toBeNull();
  });
});

describe("pickDefaultChannel — excludes a recently-archived primary", () => {
  it("picks the first active top-level when nothing is excluded", () => {
    expect(pickDefaultChannel(list("a", "b"), null)).toBe("a");
  });

  it("does NOT re-select the just-archived channel even if the stale list still contains it", () => {
    expect(pickDefaultChannel(list("a"), "a")).toBeNull();
  });

  it("skips the excluded id and picks the next remaining active channel", () => {
    expect(pickDefaultChannel(list("a", "b"), "a")).toBe("b");
  });

  it("returns null for an empty list", () => {
    expect(pickDefaultChannel([], "a")).toBeNull();
  });
});
