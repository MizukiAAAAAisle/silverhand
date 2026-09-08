import { describe, expect, it } from "vitest";
import {
  COLUMN_PAGE_SIZE,
  columnVisibleCount,
  FIRST_COLUMN_WINDOW,
  growColumnWindow,
} from "./columnWindow";

describe("columnVisibleCount", () => {
  it("starts every column at one page", () => {
    for (const status of ["todo", "in_progress", "in_review", "done", "closed"] as const) {
      expect(columnVisibleCount(FIRST_COLUMN_WINDOW, status)).toBe(COLUMN_PAGE_SIZE);
    }
  });
});

describe("growColumnWindow", () => {
  it("adds one page to the named column only", () => {
    const grown = growColumnWindow(FIRST_COLUMN_WINDOW, "todo");
    expect(columnVisibleCount(grown, "todo")).toBe(COLUMN_PAGE_SIZE * 2);
    expect(columnVisibleCount(grown, "in_progress")).toBe(COLUMN_PAGE_SIZE);
  });

  it("accumulates across calls", () => {
    const grown = growColumnWindow(growColumnWindow(FIRST_COLUMN_WINDOW, "done"), "done");
    expect(columnVisibleCount(grown, "done")).toBe(COLUMN_PAGE_SIZE * 3);
  });
});
