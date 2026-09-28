import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { decodeMessageSeq } from "@silverhand/shared";
import type {
  ListChannelThreadsResponse,
  ThreadSummary,
  ThreadSummaryInvariant,
} from "@silverhand/shared";
import {
  channelThreadsKey,
  compareThreadSummary,
  mergeThreadsListEntry,
} from "./use-channel-threads";

/** A full ThreadSummary row (what the client holds). */
function row(
  rootId: string,
  lastReplyAt: number,
  rootSeq: number,
  over: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    root_message_id: rootId,
    root_author: {
      status: "active",
      kind: "user",
      id: "u1",
      name: "User",
      display_name: "User",
      avatar_url: null,
      runtime: null,
    },
    root_preview: `root ${rootId}`,
    root_created_at: 0,
    root_seq: decodeMessageSeq(rootSeq),
    reply_count: 1,
    last_reply_at: lastReplyAt,
    last_reply_message_id: `lr-${rootId}-${lastReplyAt}`,
    repliers: [
      {
        status: "active",
        kind: "user",
        id: "u1",
        name: "User",
        display_name: "User",
        avatar_url: null,
        runtime: null,
      },
    ],
    replier_total: 1,
    viewer_following: false,
    ...over,
  };
}

/** The viewer-invariant subset a `threads_list_entry` patch carries (no
 *  `viewer_following`). */
function entry(
  rootId: string,
  lastReplyAt: number,
  rootSeq: number,
  over: Partial<ThreadSummaryInvariant> = {},
): ThreadSummaryInvariant {
  const { viewer_following: _drop, ...invariant } = row(rootId, lastReplyAt, rootSeq);
  return { ...invariant, ...over };
}

function page(
  threads: ThreadSummary[],
  nextCursor: string | null = null,
): ListChannelThreadsResponse {
  return { threads, next_cursor: nextCursor };
}

/** Seed the All cache as a single-page InfiniteData (the on-mount shape). */
function seedList(qc: QueryClient, channelId: string, threads: ThreadSummary[]): void {
  qc.setQueryData<InfiniteData<ListChannelThreadsResponse, string | null>>(
    channelThreadsKey(channelId),
    { pages: [page(threads)], pageParams: [null] },
  );
}

/** Seed a MULTI-page InfiniteData — each inner array is one loaded keyset page,
 *  every page but the last carrying a non-null cursor (mirrors what
 *  `useInfiniteQuery` accumulates as `fetchNextPage` walks `next_cursor`). */
function seedPages(qc: QueryClient, channelId: string, pages: ThreadSummary[][]): void {
  qc.setQueryData<InfiniteData<ListChannelThreadsResponse, string | null>>(
    channelThreadsKey(channelId),
    {
      pages: pages.map((t, i) => page(t, i < pages.length - 1 ? `cur-${i}` : null)),
      pageParams: pages.map((_, i) => (i === 0 ? null : `cur-${i - 1}`)),
    },
  );
}

function listRoots(qc: QueryClient, channelId: string): string[] {
  return (
    qc
      .getQueryData<InfiniteData<ListChannelThreadsResponse, string | null>>(
        channelThreadsKey(channelId),
      )
      ?.pages.flatMap((p) => p.threads.map((t) => t.root_message_id)) ?? []
  );
}

function findRow(qc: QueryClient, channelId: string, rootId: string): ThreadSummary | undefined {
  return qc
    .getQueryData<InfiniteData<ListChannelThreadsResponse, string | null>>(
      channelThreadsKey(channelId),
    )
    ?.pages.flatMap((p) => p.threads)
    .find((t) => t.root_message_id === rootId);
}

// The SINGLE keyset comparator MUST reproduce the server's total order EXACTLY
// (`message-repo.ts` ORDER BY lr.created_at DESC, root.seq DESC) — Cindy gate ②.
describe("compareThreadSummary — documented keyset (last_reply_at DESC, root_seq DESC)", () => {
  it("orders by last_reply_at DESC primarily", () => {
    const sorted = [row("a", 100, 1), row("b", 300, 2), row("c", 200, 3)].sort(
      compareThreadSummary,
    );
    expect(sorted.map((t) => t.root_message_id)).toEqual(["b", "c", "a"]);
  });

  it("breaks a same-millisecond last_reply_at tie by root_seq DESC (== server)", () => {
    // Three roots forced to the SAME last_reply_at — only root_seq resolves them.
    const sorted = [row("a", 500, 10), row("b", 500, 30), row("c", 500, 20)].sort(
      compareThreadSummary,
    );
    expect(sorted.map((t) => t.root_message_id)).toEqual(["b", "c", "a"]);
  });
});

// SOURCE FENCE (#task:1279) — a golden fixture in the EXACT order the server
// returns (`message-repo.ts` listChannelThreads `ORDER BY lr.created_at DESC,
// root.seq DESC`). It locks `compareThreadSummary` to that authoritative order:
// any client-side drift fails here, and the fixture is the canonical example a
// server-side ORDER BY change must be reconciled against (change both together).
describe("SOURCE FENCE — compareThreadSummary reproduces the server total order", () => {
  // Canonical server-ordered page: last_reply_at DESC primary, root_seq DESC to
  // break same-ms ties. Mixes a 3-way tie (500) with distinct buckets (300/100).
  const SERVER_ORDER: ThreadSummary[] = [
    row("a", 500, 30), // last_reply_at 500, highest seq in the tie
    row("b", 500, 20), // 500 tie → seq DESC
    row("c", 500, 10), // 500 tie → seq DESC
    row("d", 300, 99), // next bucket (seq irrelevant across buckets)
    row("e", 100, 5), // oldest activity
  ];
  const GOLDEN = SERVER_ORDER.map((t) => t.root_message_id);

  it("recovers the server order from an arbitrary permutation", () => {
    // A fixed non-trivial permutation (not the identity) → sort must restore it.
    const shuffled = [
      SERVER_ORDER[3], // d
      SERVER_ORDER[1], // b
      SERVER_ORDER[4], // e
      SERVER_ORDER[0], // a
      SERVER_ORDER[2], // c
    ] as ThreadSummary[];
    expect(shuffled.sort(compareThreadSummary).map((t) => t.root_message_id)).toEqual(GOLDEN);
  });

  it("is a total order — reverse input also recovers the golden order", () => {
    const reversed = [...SERVER_ORDER].reverse();
    expect(reversed.sort(compareThreadSummary).map((t) => t.root_message_id)).toEqual(GOLDEN);
  });
});

describe("mergeThreadsListEntry — in-place merge + resort, no insert (#task:1278)", () => {
  it("cold-absent when no page data is loaded", () => {
    const qc = new QueryClient();
    expect(mergeThreadsListEntry(qc, "c1", entry("a", 100, 1))).toBe("cold-absent");
  });

  it("off-page when the loaded page does not hold the root (no insert)", () => {
    const qc = new QueryClient();
    seedList(qc, "c1", [row("a", 100, 1), row("b", 90, 2)]);
    expect(mergeThreadsListEntry(qc, "c1", entry("z", 999, 9))).toBe("off-page");
    // Page membership unchanged — z was NOT inserted.
    expect(listRoots(qc, "c1")).toEqual(["a", "b"]);
  });

  it("merges the absolute entry and repositions the row to the top by keyset", () => {
    const qc = new QueryClient();
    // b is bottom; a reply bumps b's last_reply_at above a → b must move to top.
    seedList(qc, "c1", [row("a", 200, 1), row("b", 100, 2)]);
    const out = mergeThreadsListEntry(
      qc,
      "c1",
      entry("b", 300, 2, { reply_count: 5, last_reply_message_id: "lr-b-new" }),
    );
    expect(out).toBe("merged");
    expect(listRoots(qc, "c1")).toEqual(["b", "a"]); // resorted
    const b = findRow(qc, "c1", "b");
    expect(b?.reply_count).toBe(5); // absolute overwrite
    expect(b?.last_reply_at).toBe(300);
  });

  it("KEEPS the local viewer_following (frame carries none — Cindy gate ③)", () => {
    const qc = new QueryClient();
    seedList(qc, "c1", [row("a", 100, 1, { viewer_following: true })]);
    mergeThreadsListEntry(
      qc,
      "c1",
      entry("a", 200, 1, { reply_count: 3, last_reply_message_id: "lr-a-new" }),
    );
    const a = findRow(qc, "c1", "a");
    expect(a?.viewer_following).toBe(true); // preserved, not defaulted to false
    expect(a?.reply_count).toBe(3);
  });

  it("is a no-op on exact replay (same last_reply_message_id + reply_count)", () => {
    const qc = new QueryClient();
    seedList(qc, "c1", [row("a", 100, 1), row("b", 90, 2)]);
    const before = qc.getQueryData(channelThreadsKey("c1"));
    // Entry equals the held row's reply state → merged but no write (same reference).
    const out = mergeThreadsListEntry(qc, "c1", entry("a", 100, 1));
    expect(out).toBe("merged");
    expect(qc.getQueryData(channelThreadsKey("c1"))).toBe(before); // identical ref → no re-render
  });

  // #task:1773 — the cache is now InfiniteData (keyset pages). A reply bumps a
  // row to the head of the WHOLE list = the head of page 0. Merging in place is
  // only safe when the row is already on page 0; a later-page hit would require a
  // cross-page move, which we refuse to guess — it falls back to refetch.
  it("merges only page 0 in place and does not disturb later pages", () => {
    const qc = new QueryClient();
    seedPages(qc, "c1", [
      [row("a", 200, 1), row("b", 150, 2)], // page 0
      [row("c", 100, 3), row("d", 90, 4)], // page 1
    ]);
    // b (page 0, bottom) gets a reply bumping it above a → resort WITHIN page 0.
    const out = mergeThreadsListEntry(
      qc,
      "c1",
      entry("b", 300, 2, { reply_count: 7, last_reply_message_id: "lr-b-new" }),
    );
    expect(out).toBe("merged");
    // Page 0 resorted (b→top); page 1 untouched; no cross-page move.
    expect(listRoots(qc, "c1")).toEqual(["b", "a", "c", "d"]);
    expect(findRow(qc, "c1", "b")?.reply_count).toBe(7);
  });

  it("off-page (refetch) when the root sits on a LATER page — no cross-page guess", () => {
    const qc = new QueryClient();
    seedPages(qc, "c1", [
      [row("a", 200, 1), row("b", 150, 2)], // page 0
      [row("c", 100, 3), row("d", 90, 4)], // page 1
    ]);
    const snapshot = qc.getQueryData(channelThreadsKey("c1"));
    // c is on page 1; a reply would move it to the head of page 0 (cross-page) →
    // refuse the guess, fall back to refetch. Cache left untouched for the refetch.
    const out = mergeThreadsListEntry(
      qc,
      "c1",
      entry("c", 999, 3, { reply_count: 9, last_reply_message_id: "lr-c-new" }),
    );
    expect(out).toBe("off-page");
    expect(qc.getQueryData(channelThreadsKey("c1"))).toBe(snapshot); // no in-place write
    expect(listRoots(qc, "c1")).toEqual(["a", "b", "c", "d"]);
  });

  it("is a no-op on exact replay even for a row on a later page (idempotent)", () => {
    const qc = new QueryClient();
    seedPages(qc, "c1", [
      [row("a", 200, 1)], // page 0
      [row("c", 100, 3)], // page 1
    ]);
    const before = qc.getQueryData(channelThreadsKey("c1"));
    // Replay of c's held reply state — idempotency short-circuits BEFORE the page
    // gate, so a deep-page replay stays a no-op (not a spurious refetch).
    const out = mergeThreadsListEntry(qc, "c1", entry("c", 100, 3));
    expect(out).toBe("merged");
    expect(qc.getQueryData(channelThreadsKey("c1"))).toBe(before);
  });

  // #task:1773 Cindy R2 — a keyset `next_cursor` is bound to the page's TAIL
  // TUPLE, not its membership SET. When ONLY page 0 is loaded and it still has a
  // next page, reordering it moves the bumped row off the tail while the opaque
  // cursor keeps pointing at the OLD tail → `fetchNextPage` would resume from the
  // wrong boundary (skip/duplicate). So a genuine change there must refuse the
  // local merge and defer to the authoritative refetch — cache + cursor untouched.
  it("off-page on a single NON-terminal page 0 (reorder would desync the tail cursor)", () => {
    const qc = new QueryClient();
    // Single loaded page [a, b] with a live next_cursor pointing at the tail (b).
    qc.setQueryData<InfiniteData<ListChannelThreadsResponse, string | null>>(
      channelThreadsKey("c1"),
      { pages: [page([row("a", 200, 1), row("b", 150, 2)], "cur-b")], pageParams: [null] },
    );
    const snapshot = qc.getQueryData(channelThreadsKey("c1"));
    // A reply bumps the tail row b above a — a genuine reorder of the only page.
    const out = mergeThreadsListEntry(
      qc,
      "c1",
      entry("b", 300, 2, { reply_count: 5, last_reply_message_id: "lr-b-new" }),
    );
    expect(out).toBe("off-page");
    // Cache + cursor left byte-for-byte (same reference) for the refetch to rebuild.
    expect(qc.getQueryData(channelThreadsKey("c1"))).toBe(snapshot);
    expect(listRoots(qc, "c1")).toEqual(["a", "b"]); // no local reorder
  });

  it("still merges a single page 0 in place once it is terminal (next_cursor === null)", () => {
    const qc = new QueryClient();
    // Same shape but terminal — there is no next boundary to desync, so the
    // in-place optimization stays valid.
    seedList(qc, "c1", [row("a", 200, 1), row("b", 150, 2)]);
    const out = mergeThreadsListEntry(
      qc,
      "c1",
      entry("b", 300, 2, { reply_count: 5, last_reply_message_id: "lr-b-new" }),
    );
    expect(out).toBe("merged");
    expect(listRoots(qc, "c1")).toEqual(["b", "a"]);
  });
});
