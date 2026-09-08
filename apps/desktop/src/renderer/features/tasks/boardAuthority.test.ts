import { describe, expect, it } from "vitest";
import {
  UNKNOWN_COUNT,
  activeTaskCount,
  boardAuthority,
  boardColumnTotal,
  boardCountLabel,
  mapBoardAuthority,
  personMenuState,
  totalTaskCount,
  type BoardCounts,
  type BoardFacets,
} from "./boardAuthority";

const COUNTS: BoardCounts = {
  todo: 3,
  in_progress: 2,
  in_review: 1,
  done: 7,
  closed: 4,
};

describe("boardAuthority", () => {
  it("is known from DATA, so a failed background refetch keeps the last answer", () => {
    // React Query's stale-data semantics, for free: `data` survives an error, and
    // this projection reads `data` first. A warm board therefore keeps showing the
    // numbers it was told rather than dropping back to unknown.
    expect(boardAuthority({ data: COUNTS, isError: true })).toEqual({
      known: true,
      value: COUNTS,
    });
  });

  it("separates a cold load from a cold failure", () => {
    expect(boardAuthority({ data: undefined, isError: false })).toEqual({
      known: false,
      failed: false,
    });
    expect(boardAuthority({ data: undefined, isError: true })).toEqual({
      known: false,
      failed: true,
    });
  });

  it("keeps unknown unknown when a field of it is selected", () => {
    const unknown = boardAuthority<BoardFacets>({
      data: undefined,
      isError: true,
    });
    expect(mapBoardAuthority(unknown, (f) => f.assignees)).toEqual({
      known: false,
      failed: true,
    });
  });
});

describe("counts nobody has answered for", () => {
  it("yields no number at all — never a zero", () => {
    const loading = boardAuthority<BoardCounts>({
      data: undefined,
      isError: false,
    });
    const failed = boardAuthority<BoardCounts>({
      data: undefined,
      isError: true,
    });
    for (const unknown of [loading, failed]) {
      expect(activeTaskCount(unknown)).toBe(null);
      expect(totalTaskCount(unknown)).toBe(null);
      expect(boardColumnTotal(unknown, "todo")).toBe(null);
      // What a header prints instead: a dash holding the shape, never a digit.
      expect(boardCountLabel(boardColumnTotal(unknown, "todo"))).toBe(UNKNOWN_COUNT);
      expect(boardCountLabel(boardColumnTotal(unknown, "todo"))).not.toBe("0");
    }
  });

  it("still yields the number when the answer is a real zero", () => {
    const empty: BoardCounts = {
      todo: 0,
      in_progress: 0,
      in_review: 0,
      done: 0,
      closed: 0,
    };
    // Alice: the face always carries all five statuses, so `0` is an ANSWER. The
    // unknown bit lives in the query state alone — inferring it from the value
    // would strand a legitimately empty workspace in a permanent loading state.
    const known = boardAuthority({ data: empty, isError: false });
    expect(totalTaskCount(known)).toBe(0);
    expect(boardCountLabel(boardColumnTotal(known, "todo"))).toBe("0");
  });

  it("sums and slices a known answer", () => {
    const known = boardAuthority({ data: COUNTS, isError: false });
    expect(totalTaskCount(known)).toBe(17);
    // "Active" excludes both terminal statuses.
    expect(activeTaskCount(known)).toBe(6);
    expect(boardColumnTotal(known, "closed")).toBe(4);
  });
});

describe("a column header and its own body are independent reads", () => {
  // Cindy MUST FIX: the header's number comes from the counts face and the rows
  // come from that column's page query. Either can be the one that failed, and
  // neither may answer for the other — a body holding rows with a `0` above it is
  // exactly the false report the old zeroed fallback produced.
  it("a loaded body under unknown counts shows rows and NO number", () => {
    const counts = boardAuthority<BoardCounts>({
      data: undefined,
      isError: true,
    });
    const bodyRows = 12; // this column's own query succeeded
    expect(bodyRows).toBeGreaterThan(0);
    expect(boardColumnTotal(counts, "todo")).toBe(null);
    expect(boardCountLabel(boardColumnTotal(counts, "todo"))).toBe(UNKNOWN_COUNT);
  });

  it("a failed body under known counts still shows the number", () => {
    const counts = boardAuthority({ data: COUNTS, isError: false });
    // The body read failed; the header is not derived from it.
    expect(boardColumnTotal(counts, "todo")).toBe(3);
    expect(boardCountLabel(boardColumnTotal(counts, "todo"))).toBe("3");
  });
});

describe("a person menu never presents a non-answer as an empty population", () => {
  const person = { person: { type: "agent" as const, id: "a-1" }, name: "Cindy" };

  it('reports the cold failure as failed, not as "nobody to filter by"', () => {
    // Cindy MUST FIX: one facets failure must not read as a workspace with no
    // people in it. `empty` is a CLAIM and is reachable only from a success.
    expect(personMenuState({ known: false, failed: true })).toBe("failed");
    expect(personMenuState({ known: false, failed: false })).toBe("loading");
    expect(personMenuState({ known: false, failed: true })).not.toBe("empty");
  });

  it("claims empty only from a successful read", () => {
    expect(personMenuState({ known: true, value: [] })).toBe("empty");
    expect(personMenuState({ known: true, value: [person] })).toBe("ready");
  });
});
