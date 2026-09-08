import { describe, expect, it } from "vitest";
import type { MessageDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import {
  createSelectionState,
  selectionClear,
  selectionEnter,
  selectionExit,
  selectionIsSelected,
  selectionSorted,
  selectionToggle,
} from "./useMessageSelection";

// Pure-state tests for the selection reducer. The React hook is a thin
// adapter around these — covering them here exhaustively is the
// cheapest way to gate the export pipeline against off-by-one ordering
// or membership bugs without spinning up jsdom.
//
// Sort assertion is critical: any export consumer (image view + markdown
// transcript) MUST walk `selectionSorted` so the rendered output is in
// `MessageDto.seq` ascending order regardless of the user's toggle
// sequence (Cindy review #3).

function msg(id: string, seq: number, content = `body-${id}`): MessageDto {
  return {
    id,
    conversation_id: "c1",
    from_kind: "user",
    from_agent_id: null,
    from_user_id: "u1",
    author: {
      status: "active",
      kind: "user",
      id: "u1",
      name: "User",
      display_name: "User",
      avatar_url: null,
      runtime: null,
    },
    content,
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq),
    created_at: 1_700_000_000_000 + seq * 1000,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

describe("selection state — pure reducer", () => {
  it("starts idle with empty selection", () => {
    const s = createSelectionState();
    expect(s.mode).toBe("idle");
    expect(s.selected.size).toBe(0);
  });

  it("enter() flips to selecting and seeds with the message", () => {
    const s = selectionEnter(createSelectionState(), msg("a", 1));
    expect(s.mode).toBe("selecting");
    expect(s.selected.size).toBe(1);
    expect(s.selected.has("a")).toBe(true);
  });

  it("enter() is idempotent — preserves existing selection", () => {
    let s = selectionEnter(createSelectionState(), msg("a", 1));
    s = selectionToggle(s, msg("b", 2));
    s = selectionEnter(s, msg("c", 3));
    expect(s.mode).toBe("selecting");
    expect(s.selected.size).toBe(3);
    expect([...s.selected.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  it("toggle() is a no-op in idle mode (mode-flip is enter-only)", () => {
    // Cindy review P2: a stray toggle in idle would otherwise write
    // into `selected` while leaving `mode` at idle, and the next
    // enter() would inherit those ghost selections because enter
    // copies the existing selected map. The reducer enforces the
    // invariant `mode === 'idle' ⇒ selected.size === 0`.
    const s0 = createSelectionState();
    const sAfterToggle = selectionToggle(s0, msg("b", 2));
    expect(sAfterToggle.mode).toBe("idle");
    expect(sAfterToggle.selected.size).toBe(0);
    // Now enter with a different message — must NOT carry the
    // attempted-but-rejected toggle of `b`.
    const sAfterEnter = selectionEnter(sAfterToggle, msg("a", 1));
    expect(sAfterEnter.mode).toBe("selecting");
    expect([...sAfterEnter.selected.keys()]).toEqual(["a"]);
    expect(sAfterEnter.selected.has("b")).toBe(false);
  });

  it("toggle() adds and removes membership", () => {
    let s = selectionEnter(createSelectionState(), msg("a", 1));
    s = selectionToggle(s, msg("b", 2));
    expect(s.selected.size).toBe(2);
    s = selectionToggle(s, msg("a", 1));
    expect(s.selected.size).toBe(1);
    expect(s.selected.has("a")).toBe(false);
    expect(s.selected.has("b")).toBe(true);
  });

  it("toggle() refreshes the snapshot when toggled back on", () => {
    // This protects the freeze-snapshot contract: when a user un-toggles
    // and re-toggles the same message id, we want the latest content,
    // not a stale clone.
    let s = selectionEnter(createSelectionState(), msg("a", 1, "old"));
    s = selectionToggle(s, msg("a", 1)); // remove
    s = selectionToggle(s, msg("a", 1, "new")); // re-add with new content
    expect(s.selected.get("a")?.content).toBe("new");
  });

  it("clear() drops selections but keeps mode", () => {
    let s = selectionEnter(createSelectionState(), msg("a", 1));
    s = selectionToggle(s, msg("b", 2));
    s = selectionClear(s);
    expect(s.mode).toBe("selecting");
    expect(s.selected.size).toBe(0);
  });

  it("exit() drops both selection and mode", () => {
    let s = selectionEnter(createSelectionState(), msg("a", 1));
    s = selectionToggle(s, msg("b", 2));
    s = selectionExit();
    expect(s.mode).toBe("idle");
    expect(s.selected.size).toBe(0);
  });

  it("selectionSorted() returns ascending by seq regardless of toggle order", () => {
    // User toggles in 5,1,3,2,4 order — sorted output must be 1..5.
    let s = createSelectionState();
    s = selectionEnter(s, msg("e", 5));
    s = selectionToggle(s, msg("a", 1));
    s = selectionToggle(s, msg("c", 3));
    s = selectionToggle(s, msg("b", 2));
    s = selectionToggle(s, msg("d", 4));
    const sorted = selectionSorted(s);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(sorted.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("selectionSorted() handles a single message", () => {
    const s = selectionEnter(createSelectionState(), msg("only", 42));
    expect(selectionSorted(s).map((m) => m.id)).toEqual(["only"]);
  });

  it("selectionIsSelected() is true only for current members", () => {
    let s = selectionEnter(createSelectionState(), msg("a", 1));
    s = selectionToggle(s, msg("b", 2));
    expect(selectionIsSelected(s, "a")).toBe(true);
    expect(selectionIsSelected(s, "b")).toBe(true);
    expect(selectionIsSelected(s, "c")).toBe(false);
    s = selectionToggle(s, msg("a", 1));
    expect(selectionIsSelected(s, "a")).toBe(false);
  });

  it("all reducer functions return new state objects (no mutation)", () => {
    const s0 = createSelectionState();
    const s1 = selectionEnter(s0, msg("a", 1));
    const s2 = selectionToggle(s1, msg("b", 2));
    const s3 = selectionClear(s2);
    const s4 = selectionExit();
    expect(s0).not.toBe(s1);
    expect(s1).not.toBe(s2);
    expect(s2).not.toBe(s3);
    expect(s3).not.toBe(s4);
    // s0 + s1 untouched
    expect(s0.selected.size).toBe(0);
    expect(s1.selected.size).toBe(1);
    expect(s2.selected.size).toBe(2);
  });
});
