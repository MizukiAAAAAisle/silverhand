import { describe, expect, it } from "vitest";
import { headingForEdge } from "./sidebar-peek";

const edge = { x: 100, top: 0, bottom: 400 };

describe("headingForEdge", () => {
  it("accepts a diagonal step toward the sidebar", () => {
    expect(headingForEdge({ x: 20, y: 300 }, { x: 26, y: 296 }, edge)).toBe(true);
  });

  it("rejects a vertical step along the rail", () => {
    expect(headingForEdge({ x: 20, y: 300 }, { x: 20, y: 290 }, edge)).toBe(false);
  });

  it("rejects a step away from the sidebar", () => {
    expect(headingForEdge({ x: 20, y: 300 }, { x: 14, y: 296 }, edge)).toBe(false);
  });

  it("rejects a step that passes outside the edge's span", () => {
    expect(headingForEdge({ x: 20, y: 10 }, { x: 22, y: -10 }, edge)).toBe(false);
  });
});
