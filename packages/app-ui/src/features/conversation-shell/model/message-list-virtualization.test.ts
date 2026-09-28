import { describe, expect, it } from "vitest";
import {
  classifyTopShift,
  getFollowOutputBehavior,
  getInitialTopMostItemIndex,
  INITIAL_BOTTOM_ANCHOR_STATE,
  reduceBottomAnchor,
  resolveTopShiftAction,
  shouldRemountForJump,
  shouldRemountForWindowReplacement,
  type BottomAnchorState,
} from "./message-list-virtualization";

// Build the itemKey sequence for a contiguous seq range [from, to].
const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

describe("message list virtualization helpers", () => {
  describe("getInitialTopMostItemIndex", () => {
    it("centers the jump target when it is present", () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: 42,
          hasJumpTarget: true,
          itemCount: 100,
        }),
      ).toEqual({ index: 42, align: "center" });
    });

    it("omits initial index while a jump target is pending but absent", () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: true,
          itemCount: 100,
        }),
      ).toBeUndefined();
    });

    it("opens ordinary channel mounts at the local bottom", () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: false,
          itemCount: 100,
        }),
      ).toBe(99);
    });

    it("keeps the ordinary empty-list fallback non-negative", () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: false,
          itemCount: 0,
        }),
      ).toBe(0);
    });

    it("back-to-bottom wins over a still-resolving jump target", () => {
      // A back-to-bottom click inside a tail window that is still centered on
      // a jump target (the parent has not yet cleared the jump prop). The
      // bottom anchor must take the mount, not the stale jump center —
      // otherwise the command is a no-op.
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: 42,
          hasJumpTarget: true,
          itemCount: 100,
          preferBottom: true,
        }),
      ).toBe(99);
    });

    it("back-to-bottom lands at the local bottom with no jump active", () => {
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: -1,
          hasJumpTarget: false,
          itemCount: 100,
          preferBottom: true,
        }),
      ).toBe(99);
    });
  });

  describe("shouldRemountForWindowReplacement", () => {
    it("remounts ordinary latest/window replacements", () => {
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: false,
          jumpTargetIndex: -1,
        }),
      ).toBe(true);
    });

    it("remounts jump windows only after the target is present", () => {
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: 12,
        }),
      ).toBe(true);
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
        }),
      ).toBe(false);
    });

    it("remounts a latest reset that still carries a cancelling jump when a bottom anchor is armed", () => {
      // The reported bug: non-tail + active jump → back-to-bottom resets to
      // latest. The fresh latest window can arrive before the cancelled jump
      // prop clears, so it still reads hasJumpTarget=true with the (early)
      // target absent. Without the armed anchor the replacement declines to
      // remount and the window stays parked on the stale around-window
      // position. The armed bottom anchor is one command with the reset, so it
      // forces the remount regardless of the lingering jump.
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
          preferBottom: true,
        }),
      ).toBe(true);
      // Same shape, anchor NOT armed → the original parked behaviour.
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
          preferBottom: false,
        }),
      ).toBe(false);
    });

    it("a spent bottom anchor does not force later unrelated replacements to the tail", () => {
      // After a back-to-bottom lands, the one-shot lifecycle resets the intent
      // (`anchorMode → 'default'`), so `preferBottom` is false on any LATER,
      // unrelated window replacement. If the user has since scrolled up and
      // re-armed a jump toward off-window history, that replacement must follow
      // the ordinary rules — NOT force a remount to the tail. This is the
      // falsifier for the sticky-anchor leak: with the anchor spent, a jump
      // whose target is still absent parks (waits for the around-window)
      // exactly as an ordinary pending jump does.
      expect(
        shouldRemountForWindowReplacement({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
          preferBottom: false,
        }),
      ).toBe(false);
      // ...and once that jump's target is present, the mount still centers on
      // it — the spent bottom command does not hijack the landing.
      expect(
        getInitialTopMostItemIndex({
          jumpTargetIndex: 37,
          hasJumpTarget: true,
          itemCount: 100,
          preferBottom: false,
        }),
      ).toEqual({ index: 37, align: "center" });
    });
  });

  describe("shouldRemountForJump", () => {
    it("remounts only when an active jump target is present in the window", () => {
      expect(
        shouldRemountForJump({
          hasJumpTarget: true,
          jumpTargetIndex: 9,
        }),
      ).toBe(true);
      expect(
        shouldRemountForJump({
          hasJumpTarget: true,
          jumpTargetIndex: -1,
        }),
      ).toBe(false);
      expect(
        shouldRemountForJump({
          hasJumpTarget: false,
          jumpTargetIndex: 9,
        }),
      ).toBe(false);
    });
  });

  describe("getFollowOutputBehavior", () => {
    it("follows only when the user is at the real conversation tail", () => {
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: true,
          atBottom: true,
        }),
      ).toBe("auto");
    });

    it("does not follow during jumps, non-tail windows, or manual history reads", () => {
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: true,
          isAtTail: true,
          atBottom: true,
        }),
      ).toBe(false);
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: false,
          atBottom: true,
        }),
      ).toBe(false);
      expect(
        getFollowOutputBehavior({
          hasJumpTarget: false,
          isAtTail: true,
          atBottom: false,
        }),
      ).toBe(false);
    });
  });

  describe("reduceBottomAnchor — back-to-bottom one-shot lifecycle", () => {
    // Replays the ACTUAL React/cache lifecycle at transition level: the reset
    // branch goes arm → (stale window still shown) →
    // transient empty (resetQueries cleared the cache) → latest rows mount.
    // The intent must survive the stale window AND the empty, then be spent by
    // the real latest mount — never earlier.
    it("arms bottom on a reset request", () => {
      const s = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-reset",
      });
      expect(s.intent).toBe("bottom");
      expect(s.pending).toEqual({ kind: "reset", sawEmpty: false });
    });

    it("does NOT consume on the pre-reset stale window (rows-shown before the empty)", () => {
      let s = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-reset",
      });
      // The stale around-window is still non-empty at click time.
      s = reduceBottomAnchor(s, { type: "rows-shown" });
      expect(s.intent).toBe("bottom");
      expect(s.pending).toEqual({ kind: "reset", sawEmpty: false });
    });

    it("consumes only after the reset empty, on the real latest mount", () => {
      let s: BottomAnchorState = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-reset",
      });
      // resetQueries clears the cache → transient empty. Still armed.
      s = reduceBottomAnchor(s, { type: "rows-hidden" });
      expect(s.intent).toBe("bottom");
      expect(s.pending).toEqual({ kind: "reset", sawEmpty: true });
      // Latest rows mount → the mount reads the armed intent, then this spends.
      s = reduceBottomAnchor(s, { type: "rows-shown" });
      expect(s).toBe(INITIAL_BOTTOM_ANCHOR_STATE);
    });

    it("stays default through LATER unrelated churn after a reset landed", () => {
      let s: BottomAnchorState = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-reset",
      });
      s = reduceBottomAnchor(s, { type: "rows-hidden" });
      s = reduceBottomAnchor(s, { type: "rows-shown" }); // consumed
      // User scrolls up; an unrelated refetch empties + refills. Must NOT
      // re-arm the bottom intent (the sticky-anchor leak).
      s = reduceBottomAnchor(s, { type: "rows-hidden" });
      expect(s.intent).toBe("default");
      s = reduceBottomAnchor(s, { type: "rows-shown" });
      expect(s.intent).toBe("default");
      expect(s.pending).toBeNull();
    });

    it("spends a tail request on its remount commit, not on rows churn", () => {
      let s: BottomAnchorState = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-tail",
      });
      expect(s.intent).toBe("bottom");
      // Rows churn does not spend a tail request (tail window never empties).
      s = reduceBottomAnchor(s, { type: "rows-shown" });
      expect(s.intent).toBe("bottom");
      // The bottomAnchorVersion remount committing spends it.
      s = reduceBottomAnchor(s, { type: "tail-shown" });
      expect(s).toBe(INITIAL_BOTTOM_ANCHOR_STATE);
    });

    it("keeps the tail and reset consume signals from crossing", () => {
      // tail-shown must not consume a reset request…
      const reset = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-reset",
      });
      expect(reduceBottomAnchor(reset, { type: "tail-shown" })).toBe(reset);
      // …and the reset rows-shown consume path must not fire for a tail request.
      const tail = reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, {
        type: "arm-tail",
      });
      expect(reduceBottomAnchor(tail, { type: "rows-hidden" })).toBe(tail);
    });

    it("a fresh jump / channel switch cancels an in-flight request", () => {
      const s = reduceBottomAnchor(
        reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, { type: "arm-reset" }),
        { type: "cancel" },
      );
      expect(s).toBe(INITIAL_BOTTOM_ANCHOR_STATE);
    });

    it("is a no-op (same reference) for lifecycle events with no live request", () => {
      // These fire on every rows change / channel mount; a no-op must return
      // the SAME reference so useReducer bails without a re-render.
      expect(reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, { type: "rows-shown" })).toBe(
        INITIAL_BOTTOM_ANCHOR_STATE,
      );
      expect(reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, { type: "rows-hidden" })).toBe(
        INITIAL_BOTTOM_ANCHOR_STATE,
      );
      expect(reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, { type: "tail-shown" })).toBe(
        INITIAL_BOTTOM_ANCHOR_STATE,
      );
      expect(reduceBottomAnchor(INITIAL_BOTTOM_ANCHOR_STATE, { type: "cancel" })).toBe(
        INITIAL_BOTTOM_ANCHOR_STATE,
      );
    });
  });

  describe("classifyTopShift", () => {
    it("reports no shift when the top key is unchanged", () => {
      expect(classifyTopShift(range(1, 100), range(1, 100))).toEqual({
        kind: "none",
      });
    });

    it("detects a prepend by the old top moving down", () => {
      // Older rows loaded above: old top (4) now sits at index 3.
      expect(classifyTopShift(range(4, 103), range(1, 103))).toEqual({
        kind: "prepend",
        count: 3,
      });
    });

    it("detects a head-trim: live-appended latest page refetched to fixed size (#1505)", () => {
      // 100 rows → live-appended to 103 → invalidate re-fetches the latest 100,
      // dropping the first 3 head rows. The new top (4) was at index 3 in the
      // old window; the remaining window is contiguous.
      expect(classifyTopShift(range(1, 103), range(4, 103))).toEqual({
        kind: "head-trim",
        count: 3,
      });
    });

    it("treats a disjoint window (latest ↔ around jump) as a replacement", () => {
      expect(classifyTopShift(range(1, 100), range(500, 600))).toEqual({
        kind: "replace",
      });
    });

    it("treats a first-ever window (no previous keys) as a no-op", () => {
      // First data arrival / post-channel-switch: nothing to reconcile, and a
      // spurious replace here would remount on every channel's first load.
      expect(classifyTopShift([], range(1, 100))).toEqual({ kind: "none" });
    });
  });

  describe("resolveTopShiftAction", () => {
    const noPositioning = {
      userPositioning: false,
      hasJumpTarget: false,
      jumpTargetIndex: -1,
      preferBottom: false,
    };

    it("shifts firstItemIndex down on a prepend without remounting", () => {
      expect(resolveTopShiftAction({ kind: "prepend", count: 3 }, noPositioning)).toEqual({
        firstItemIndex: "delta",
        delta: -3,
        remount: false,
      });
    });

    it("preserves the reader anchor on a non-user head-trim: shift UP, no remount (#1505)", () => {
      // The core #1505 guarantee: a head-trim while the reader is scrolled up
      // (no positioning command) must NOT bump windowResetVersion (remount) —
      // that is what yanked the reader to the default bottom.
      expect(resolveTopShiftAction({ kind: "head-trim", count: 3 }, noPositioning)).toEqual({
        firstItemIndex: "delta",
        delta: 3,
        remount: false,
      });
    });

    it("lets a jump own a head-trim: falls through to replacement + remount", () => {
      // A user positioning command in flight keeps the existing remount
      // semantics (no #1504 regression).
      expect(
        resolveTopShiftAction(
          { kind: "head-trim", count: 3 },
          {
            userPositioning: true,
            hasJumpTarget: true,
            jumpTargetIndex: 42,
            preferBottom: false,
          },
        ),
      ).toEqual({ firstItemIndex: "reset", remount: true });
    });

    it("resets and remounts on a disjoint replacement (no jump target)", () => {
      expect(resolveTopShiftAction({ kind: "replace" }, noPositioning)).toEqual({
        firstItemIndex: "reset",
        remount: true,
      });
    });

    it("resets without remounting while a jump target is still absent", () => {
      // Matches shouldRemountForWindowReplacement: a pending-but-absent jump
      // must not remount to the current window's local end.
      expect(
        resolveTopShiftAction(
          { kind: "replace" },
          {
            userPositioning: true,
            hasJumpTarget: true,
            jumpTargetIndex: -1,
            preferBottom: false,
          },
        ),
      ).toEqual({ firstItemIndex: "reset", remount: false });
    });
  });
});
