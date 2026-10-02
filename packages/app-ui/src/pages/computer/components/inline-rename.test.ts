import { describe, expect, it } from "vitest";
import { decideRenameCommit } from "./inline-rename";

/**
 * #task:808 slice 4 — pure no-op decision for `InlineRename`.
 *
 * Pins the exact bug Cindy caught in `bpBngcaDmQrQ9M_Q`: a host whose
 * `display_label === null` seeds the edit input with `host.name`
 * (via `fallbackForEdit`); if the user double-clicks then immediately
 * blurs, the old `next === value` check fired a PATCH that persisted
 * `host.name` as the label — breaking the nullable-fallback contract.
 *
 * Encoded here as two arms so any future tweak of the no-op rule
 * fails a test rather than silently re-introducing the regression.
 */
describe("decideRenameCommit", () => {
  describe("no-op (the bug-fix surface)", () => {
    it("blur-without-change on a null-label host does NOT commit", () => {
      // Repro of the original P1: value=null, input was seeded with the
      // host name, user blurs without typing → must stay a no-op.
      const decision = decideRenameCommit("my-computer-1234", "my-computer-1234", null);
      expect(decision).toEqual({ commit: false });
    });

    it("blur-without-change on a labeled host does NOT commit", () => {
      const decision = decideRenameCommit("Studio", "Studio", "Studio");
      expect(decision).toEqual({ commit: false });
    });

    it("ignores surrounding whitespace when matching the initial seed", () => {
      const decision = decideRenameCommit("  Studio  ", "Studio", "Studio");
      expect(decision).toEqual({ commit: false });
    });

    it("clearing a fallback-seeded null label is a no-op (not a redundant PATCH)", () => {
      // value=null + seed=host.name + user empties the field → next=null
      // matches the live value, so no PATCH fires. (Also short-circuits
      // the "next === value" arm independent of the initial-seed arm.)
      const decision = decideRenameCommit("", "my-computer-1234", null);
      expect(decision).toEqual({ commit: false });
    });
  });

  describe("commit", () => {
    it("typing a fresh label fires a PATCH with the trimmed string", () => {
      const decision = decideRenameCommit("  My Studio  ", "my-computer-1234", null);
      expect(decision).toEqual({ commit: true, next: "My Studio" });
    });

    it("clearing an existing label fires a PATCH with `null` (clear-flow)", () => {
      // The repo-side empty→null normalization is mirrored here so the
      // user can clear a label by blanking the field.
      const decision = decideRenameCommit("   ", "Studio", "Studio");
      expect(decision).toEqual({ commit: true, next: null });
    });

    it("changing a labeled host to a different label fires a PATCH", () => {
      const decision = decideRenameCommit("Studio Two", "Studio", "Studio");
      expect(decision).toEqual({ commit: true, next: "Studio Two" });
    });
  });
});
