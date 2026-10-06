import { describe, expect, it } from "vitest";
import { withNativeCircles } from "./native-circles";

const SEARCH_RING =
  "M19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11C3 15.4183 6.58172 19 11 19C15.4183 19 19 15.4183 19 11Z";

describe("withNativeCircles", () => {
  it("rewrites a four-arc circle path as a circle", () => {
    expect(withNativeCircles([["path", { d: SEARCH_RING, stroke: "currentColor" }]])).toEqual([
      ["circle", { stroke: "currentColor", cx: 11, cy: 11, r: 8 }],
    ]);
  });

  it("splits circle subpaths out of a compound path and keeps the rest", () => {
    const dot =
      "M12.25 12C12.25 12.1381 12.1381 12.25 12 12.25C11.8619 12.25 11.75 12.1381 11.75 12C11.75 11.8619 11.8619 11.75 12 11.75C12.1381 11.75 12.25 11.8619 12.25 12Z";

    expect(withNativeCircles([["path", { d: `M8 12H8.1${dot}` }]])).toEqual([
      ["path", { d: "M8 12H8.1" }],
      ["circle", { cx: 12, cy: 12, r: 0.25 }],
    ]);
  });

  it("leaves non-circular curves and other elements untouched", () => {
    const squircle = "M3 12C3 4 4 3 12 3C20 3 21 4 21 12C21 20 20 21 12 21C4 21 3 20 3 12Z";
    const node = [
      ["path", { d: squircle }],
      ["path", { d: "M17 17L21 21" }],
      ["rect", { x: 1, y: 1, width: 4, height: 4 }],
    ] as const;

    expect(withNativeCircles(node)).toEqual(node);
  });
});
