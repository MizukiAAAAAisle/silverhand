import { describe, expect, it } from "vitest";
import { conversationSelectionTier } from "./rail-selection";

describe("conversationSelectionTier (#task:1888 — same verdict in STARRED and under the parent)", () => {
  it("primary only for the open conversation", () => {
    expect(conversationSelectionTier("c1", "c1")).toBe("primary");
    expect(conversationSelectionTier("c2", "c1")).toBe("none");
  });

  it("no open conversation → none", () => {
    expect(conversationSelectionTier("c1", null)).toBe("none");
  });

  it("keys on the conversation alone — a selected parent does not light its children", () => {
    // The arg is the open CONVERSATION, never a workspace id: passing the parent's
    // id must not make a child primary.
    expect(conversationSelectionTier("c1", "w1")).toBe("none");
  });
});
