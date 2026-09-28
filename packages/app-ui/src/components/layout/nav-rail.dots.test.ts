// Nav-rail attention-dot derivation (#task:1408). The dot is a no-count "this
// section has new content" signal for Chat + Activity, derived purely from the
// existing viewer read-models. These lock the two contracts (any-unread /
// non-empty) and the "no archived re-filter in the renderer" invariant Alice
// flagged (archived is excluded at the rollup source, #1403-A).
import { describe, expect, it } from "vitest";
import { deriveNavRailDots } from "./nav-rail";

describe("deriveNavRailDots (#task:1408)", () => {
  it("cold queries (both undefined) → both dots off (no false positive)", () => {
    expect(deriveNavRailDots({ workspaceUnread: undefined, activityItemCount: undefined })).toEqual(
      { chat: false, activity: false },
    );
  });

  it("chat = ANY workspace has unread > 0", () => {
    expect(deriveNavRailDots({ workspaceUnread: { a: 0, b: 3 }, activityItemCount: 0 }).chat).toBe(
      true,
    );
  });

  it("chat off when every workspace count is 0 (empty or all-zero map)", () => {
    expect(deriveNavRailDots({ workspaceUnread: {}, activityItemCount: 0 }).chat).toBe(false);
    expect(deriveNavRailDots({ workspaceUnread: { a: 0, b: 0 }, activityItemCount: 0 }).chat).toBe(
      false,
    );
  });

  it("chat reads by_workspace verbatim — no archived re-filter (values ARE the rule)", () => {
    // The summary is already archived-excluded at source (#1403-A); a single
    // positive entry lights the dot regardless of key. If a renderer ever
    // re-filtered here, a legitimately-unread workspace could be dropped.
    expect(deriveNavRailDots({ workspaceUnread: { onlyOne: 1 }, activityItemCount: 0 }).chat).toBe(
      true,
    );
  });

  it("activity = list non-empty (observe drops handled items)", () => {
    expect(deriveNavRailDots({ workspaceUnread: {}, activityItemCount: 0 }).activity).toBe(false);
    expect(deriveNavRailDots({ workspaceUnread: {}, activityItemCount: 2 }).activity).toBe(true);
  });

  it("the two axes are independent", () => {
    expect(deriveNavRailDots({ workspaceUnread: { a: 5 }, activityItemCount: 0 })).toEqual({
      chat: true,
      activity: false,
    });
    expect(deriveNavRailDots({ workspaceUnread: {}, activityItemCount: 4 })).toEqual({
      chat: false,
      activity: true,
    });
  });
});
