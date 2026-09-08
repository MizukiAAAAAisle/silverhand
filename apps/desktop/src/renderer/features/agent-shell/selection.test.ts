import { describe, expect, it } from "vitest";
import { resolveDefaultAgent } from "./selection";

describe("members selection", () => {
  it("preserves human deep links and valid agent routes", () => {
    expect(resolveDefaultAgent(["a", "b"], null, "human", "b")).toBeNull();
    expect(resolveDefaultAgent(["a", "b"], "a", null, "b")).toBeNull();
  });

  it("restores a remembered valid agent and falls back when removed", () => {
    expect(resolveDefaultAgent(["a", "b"], null, null, "b")).toBe("b");
    expect(resolveDefaultAgent(["a"], "removed", null, "removed")).toBe("a");
    expect(resolveDefaultAgent([], null, null, "b")).toBeNull();
  });
});
