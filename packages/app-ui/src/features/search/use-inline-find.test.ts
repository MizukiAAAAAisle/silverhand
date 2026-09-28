import { describe, expect, it } from "vitest";
import {
  INLINE_FIND_LIMIT,
  activeMatch,
  buildInlineFindParams,
  cycleIndex,
  inlineFindKeyAction,
  inlineFindQueryEnabled,
  toChronologicalMatchIds,
} from "./use-inline-find";

type Results = Parameters<typeof toChronologicalMatchIds>[0];
const msg = (id: string) => ({ type: "message" as const, message: { id } });

// Pure helpers behind the in-conversation header find (#task:1335). The query
// shape IS the backend contract (#task:1334 guardrails), and the cyclic index
// is what makes prev/next wrap like a browser find — both worth pinning.

describe("inlineFindQueryEnabled (membership-gated query source)", () => {
  it("a member with an open bar and a term fires the query", () => {
    expect(inlineFindQueryEnabled(true, true, "hi")).toBe(true);
  });

  it("a non-member (available=false) NEVER fires, even with an open bar + term", () => {
    // In-conversation search is a member surface: the gate must cover the query
    // source, not just the visible toggle. This also covers a mid-search
    // membership downgrade — `available` flips false and the query stops.
    expect(inlineFindQueryEnabled(true, false, "hi")).toBe(false);
  });

  it("does not fire when the bar is closed or the term is empty/whitespace", () => {
    expect(inlineFindQueryEnabled(false, true, "hi")).toBe(false);
    expect(inlineFindQueryEnabled(true, true, "")).toBe(false);
    expect(inlineFindQueryEnabled(true, true, "   ")).toBe(false);
  });

  it("gates query source + highlight + active match together when unavailable", () => {
    // The controller derives THREE things from this one predicate on a
    // membership downgrade (available → false), all in the SAME render:
    //   (1) the /api/search query source (`enabled`),
    //   (2) the highlightQuery term fed to the message bodies,
    //   (3) matchIds → [], which makes the active row clear via `activeMatch`.
    // A downgrade must clear all three the same frame, not leave a stale marked
    // term until the force-close effect fires after paint. Lock that the gate is
    // the single source: false → query off AND the highlight term derivation is
    // empty AND the (now-empty) match set yields a cleared active row.
    const open = true;
    const q = "stale-term";
    const available = false;
    const queryFires = inlineFindQueryEnabled(open, available, q);
    const highlight = inlineFindQueryEnabled(open, available, q) ? q.trim() : "";
    // matchIds are gated by the same predicate upstream, so an unavailable
    // viewer's active match resolves against an empty set.
    const active = activeMatch(open, 0, []);
    expect(queryFires).toBe(false);
    expect(highlight).toBe("");
    expect(active).toEqual({ activeMessageId: null, activePosition: 0 });
  });
});

describe("buildInlineFindParams", () => {
  it("builds the mainline shape: trimmed q, recency_desc, capped limit, no root", () => {
    const qs = buildInlineFindParams({
      q: "  hello  ",
      conversationId: "c-1",
      stream: "mainline",
    });
    const p = new URLSearchParams(qs);
    expect(p.get("q")).toBe("hello");
    expect(p.get("conversation_id")).toBe("c-1");
    expect(p.get("stream")).toBe("mainline");
    expect(p.get("order")).toBe("recency_desc");
    expect(p.get("limit")).toBe(String(INLINE_FIND_LIMIT));
    expect(p.has("thread_root_id")).toBe(false);
  });

  it("includes thread_root_id only for the thread stream", () => {
    const qs = buildInlineFindParams({
      q: "x",
      conversationId: "c-1",
      stream: "thread",
      threadRootId: "m-root",
    });
    const p = new URLSearchParams(qs);
    expect(p.get("stream")).toBe("thread");
    expect(p.get("thread_root_id")).toBe("m-root");
  });

  it("omits thread_root_id for the thread stream when none is supplied", () => {
    // Defensive: the controller only builds thread params with a root, but the
    // param builder must not emit an empty root that would trip the 400 guard.
    const qs = buildInlineFindParams({
      q: "x",
      conversationId: "c-1",
      stream: "thread",
    });
    expect(new URLSearchParams(qs).has("thread_root_id")).toBe(false);
  });
});

describe("cycleIndex", () => {
  it("returns -1 for an empty set regardless of delta", () => {
    expect(cycleIndex(-1, 1, 0)).toBe(-1);
    expect(cycleIndex(0, -1, 0)).toBe(-1);
  });

  it("first ↓ from no-active (-1) lands on index 0", () => {
    expect(cycleIndex(-1, 1, 3)).toBe(0);
  });

  it("first ↑ from no-active (-1) lands on the last index", () => {
    expect(cycleIndex(-1, -1, 3)).toBe(2);
  });

  it("wraps forward off the end back to the first", () => {
    expect(cycleIndex(2, 1, 3)).toBe(0);
  });

  it("wraps backward off the front to the last", () => {
    expect(cycleIndex(0, -1, 3)).toBe(2);
  });

  it("steps within range without wrapping", () => {
    expect(cycleIndex(0, 1, 3)).toBe(1);
    expect(cycleIndex(2, -1, 3)).toBe(1);
  });
});

describe("toChronologicalMatchIds", () => {
  it("reverses recency_desc results into chronological (oldest → newest) order", () => {
    // Backend returns newest-first (recency_desc); we present oldest-first so
    // the counter reads "1/N" (oldest) .. "N/N" (newest) and the find lands on
    // the newest = last index (#task:1335).
    const results = [msg("newest"), msg("mid"), msg("oldest")] as Results;
    expect(toChronologicalMatchIds(results)).toEqual(["oldest", "mid", "newest"]);
  });

  it("drops non-message results defensively", () => {
    const results = [
      msg("m1"),
      { type: "workspace", workspace: { id: "w1" } },
      msg("m2"),
    ] as unknown as Results;
    // Filtered to messages, then reversed.
    expect(toChronologicalMatchIds(results)).toEqual(["m2", "m1"]);
  });

  it("returns an empty array for no results", () => {
    expect(toChronologicalMatchIds([] as Results)).toEqual([]);
  });
});

describe("activeMatch", () => {
  const ids = ["a", "b", "c"];

  it("clears the active affordance when the bar is closed", () => {
    // Blocking gate-1: closing the find must wipe the framed row + counter, not
    // just the <mark>s. So a valid index yields the cleared shape when !open.
    expect(activeMatch(false, 1, ids)).toEqual({
      activeMessageId: null,
      activePosition: 0,
    });
  });

  it("returns the id + 1-based position for an in-range index while open", () => {
    expect(activeMatch(true, 0, ids)).toEqual({
      activeMessageId: "a",
      activePosition: 1,
    });
    expect(activeMatch(true, 2, ids)).toEqual({
      activeMessageId: "c",
      activePosition: 3,
    });
  });

  it("clears when there is no active index (-1) or it is out of range", () => {
    expect(activeMatch(true, -1, ids)).toEqual({
      activeMessageId: null,
      activePosition: 0,
    });
    expect(activeMatch(true, 5, ids)).toEqual({
      activeMessageId: null,
      activePosition: 0,
    });
    expect(activeMatch(true, 0, [])).toEqual({
      activeMessageId: null,
      activePosition: 0,
    });
  });
});

describe("inlineFindKeyAction", () => {
  const key = (k: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}) => ({
    key: k,
    shiftKey: opts.shiftKey ?? false,
    isComposing: opts.isComposing ?? false,
  });

  it("maps Enter → next and Shift+Enter → prev", () => {
    expect(inlineFindKeyAction(key("Enter"))).toBe("next");
    expect(inlineFindKeyAction(key("Enter", { shiftKey: true }))).toBe("prev");
  });

  it("maps ArrowDown → next and ArrowUp → prev (shiki #task:1335)", () => {
    expect(inlineFindKeyAction(key("ArrowDown"))).toBe("next");
    expect(inlineFindKeyAction(key("ArrowUp"))).toBe("prev");
  });

  it("maps Escape → close", () => {
    expect(inlineFindKeyAction(key("Escape"))).toBe("close");
  });

  it("leaves cursor / editing keys to the input (returns null)", () => {
    // Left/Right/Home/End keep normal text-cursor movement; text keys too.
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End", "a", " "]) {
      expect(inlineFindKeyAction(key(k))).toBeNull();
    }
  });

  it("never steals a keystroke mid-IME-composition (CJK commit)", () => {
    // Enter/Arrow while composing belong to the input method, not the find.
    expect(inlineFindKeyAction(key("Enter", { isComposing: true }))).toBeNull();
    expect(inlineFindKeyAction(key("ArrowDown", { isComposing: true }))).toBeNull();
    expect(inlineFindKeyAction(key("ArrowUp", { isComposing: true }))).toBeNull();
  });
});
