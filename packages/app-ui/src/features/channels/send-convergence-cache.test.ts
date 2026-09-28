import { describe, expect, it } from "vitest";
import type { MessageAuthorDto, MessageDto, UserDto } from "@silverhand/shared";
import { decodeMessageSeq } from "@silverhand/shared";
import type { PendingMessage } from "./pending-message";
import { optimisticSelfAuthor } from "./pending-message";
import {
  appendMessageToCache,
  appendPendingMessage,
  makeMessagesCache,
  replacePendingMessageInCache,
  rollbackOptimisticSend,
  type MessagesCache,
} from "./message-cache-core";

// Send-path convergence contract (#task:1749): both the ACK swap and the
// failure rollback must treat committed facts already in the cache as
// authoritative — never re-position or clobber them. The optimistic temp row
// is the ONLY fact this mutation owns.

/** An `active` user author (the only arm an optimistic self-send may wear, and
 *  what a committed self-send row carries back). */
function userAuthor(display_name: string, avatar_url: string | null = null): MessageAuthorDto {
  return {
    status: "active",
    kind: "user",
    id: "u1",
    name: "u1",
    display_name,
    avatar_url,
    runtime: null,
  };
}

function committed(
  id: string,
  seq: number,
  author: MessageAuthorDto = userAuthor("User One"),
): MessageDto {
  return {
    id,
    conversation_id: "c1",
    from_kind: "user",
    from_agent_id: null,
    from_user_id: "u1",
    author,
    content: id,
    metadata: null,
    attachments: null,
    seq: decodeMessageSeq(seq),
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
  };
}

function pending(
  tempId: string,
  author: MessageAuthorDto = userAuthor("User One"),
): PendingMessage {
  return {
    id: tempId,
    conversation_id: "c1",
    from_kind: "user",
    from_agent_id: null,
    from_user_id: "u1",
    author,
    content: "draft",
    metadata: null,
    attachments: null,
    created_at: 0,
    thread_root_id: null,
    linked_task: null,
    reactions: null,
    pending: true,
  };
}

function ids(cache: MessagesCache | undefined): string[] {
  return (cache?.pages ?? []).flatMap((p) => p.messages.map((m) => m.id));
}

describe("replacePendingMessageInCache — keep an already-committed row in place (#task:1749)", () => {
  it("WS→ACK: own echo landed in order, a later message followed, ACK must not reorder", () => {
    const tempId = "pending-1";
    // Real runtime order: optimistic temp row, then own WS echo (seq 10) lands
    // in order, then a concurrent later message (seq 11) lands.
    let cache = appendPendingMessage(undefined, pending(tempId));
    cache = appendMessageToCache(cache, committed("m10", 10));
    cache = appendMessageToCache(cache, committed("m11", 11));
    expect(ids(cache)).toEqual([tempId, "m10", "m11"]);

    // The ACK for own message (seq 10) arrives last. It must drop only the temp
    // row and leave the committed m10 in its seq position — NOT filter+re-append
    // it behind m11 (the 10,11 → 11,10 corruption the old code produced).
    const converged = replacePendingMessageInCache(cache, tempId, committed("m10", 10));

    expect(ids(converged)).toEqual(["m10", "m11"]);
  });

  it("ACK-first: the committed row is absent → append it (newest, tail is correct)", () => {
    const tempId = "pending-1";
    let cache = appendPendingMessage(undefined, pending(tempId));
    cache = appendMessageToCache(cache, committed("m9", 9));
    // ACK wins the race with its own WS echo: m10 not yet in cache.
    const converged = replacePendingMessageInCache(cache, tempId, committed("m10", 10));

    expect(ids(converged)).toEqual(["m9", "m10"]);
  });

  it("concurrent local sends, ACKs arrive newest-first → seq decides position, not arrival", () => {
    // Two optimistic sends queued: tempA (will be seq10), tempB (will be seq11).
    let cache = appendPendingMessage(undefined, pending("temp-a"));
    cache = appendPendingMessage(cache, pending("temp-b"));
    expect(ids(cache)).toEqual(["temp-a", "temp-b"]);

    // HTTP ACKs race and land newest-first: ACK for seq11 (tempB) before seq10
    // (tempA); neither WS echo has applied yet. The old arrival-order append
    // produced 11,10 — the immutable seq must decide instead.
    const afterAck11 = replacePendingMessageInCache(cache, "temp-b", committed("m11", 11));
    const afterAck10 = replacePendingMessageInCache(afterAck11, "temp-a", committed("m10", 10));

    expect(ids(afterAck10)).toEqual(["m10", "m11"]);
    expect(ids(afterAck10)).not.toContain("temp-a");
    expect(ids(afterAck10)).not.toContain("temp-b");
  });

  it("window replaced before ACK (temp gone, non-tail around-window) → swap does not splice", () => {
    // onMutate wrote a temp tail; then the user jumped/primed to an around-window
    // that authoritatively replaced this key — the temp row is gone and the page
    // is NOT the tail (has_more_after=true). The committed row is absent here.
    const aroundWindow: MessagesCache = makeMessagesCache({
      messages: [committed("h40", 40), committed("h41", 41)],
      reply_counts_by_root: {},
      has_more_before: true,
      has_more_after: true,
      stream_head_seq: committed("x", 99).seq,
    });

    const result = replacePendingMessageInCache(aroundWindow, "pending-1", committed("m50", 50));

    // The swap has no ownership here: it must NOT append m50 into the middle of
    // history. Returned untouched; the shared seam applies m50 under tail/gap.
    expect(result).toBe(aroundWindow);
    expect(ids(result)).toEqual(["h40", "h41"]);
  });

  it("no duplicate and no temp remain in either ordering", () => {
    const tempId = "pending-1";
    let cache = appendPendingMessage(undefined, pending(tempId));
    cache = appendMessageToCache(cache, committed("m10", 10));
    const converged = replacePendingMessageInCache(cache, tempId, committed("m10", 10));
    expect(ids(converged)).toEqual(["m10"]);
    expect(ids(converged).filter((id) => id === "m10")).toHaveLength(1);
    expect(ids(converged)).not.toContain(tempId);
  });
});

describe("rollbackOptimisticSend — undo only the temp fact, never clobber committed facts (#task:1749)", () => {
  it("untouched restore: no concurrent write → restore the exact prior snapshot (recovers a rebuilt non-tail window)", () => {
    const tempId = "pending-1";
    // The prior (pre-send) window the onMutate rebuild would restore.
    const prev = appendMessageToCache(undefined, committed("m1", 1));
    // onMutate wrote the optimistic temp row; nothing landed after.
    const optimistic = appendPendingMessage(prev, pending(tempId));

    const rolledBack = rollbackOptimisticSend(optimistic, prev, optimistic, tempId);

    // Reference-identical to prev: the exact window is recovered, temp gone.
    expect(rolledBack).toBe(prev);
    expect(ids(rolledBack)).toEqual(["m1"]);
  });

  it("WS/concurrent preserve: a committed row landed after onMutate → keep it, remove only temp", () => {
    const tempId = "pending-1";
    const prev = appendMessageToCache(undefined, committed("m1", 1));
    const optimistic = appendPendingMessage(prev, pending(tempId));
    // Between onMutate and onError, a WS committed frame applied — a NEW cache
    // reference now holds the committed row alongside the temp row.
    const current = appendMessageToCache(optimistic, committed("m10", 10));
    expect(current).not.toBe(optimistic);

    const rolledBack = rollbackOptimisticSend(current, prev, optimistic, tempId);

    // The committed row survives; only the temp row is removed. The prior
    // snapshot is NOT restored (that would drop the committed row).
    expect(ids(rolledBack)).toEqual(["m1", "m10"]);
    expect(rolledBack).not.toBe(prev);
    expect(ids(rolledBack)).not.toContain(tempId);
  });

  it("bootstrapped from empty (prev undefined) → surgical temp removal even with no concurrent write", () => {
    const tempId = "pending-1";
    const optimistic = appendPendingMessage(undefined, pending(tempId));

    const rolledBack = rollbackOptimisticSend(optimistic, undefined, optimistic, tempId);

    expect(ids(rolledBack)).toEqual([]);
  });
});

// The optimistic self-send author (#task:1792). The pending row's author is the
// current viewer, built as a `status:'active'` MessageAuthorDto straight from
// the hydrated viewer carrier — the two gates the reviewers locked (Alice/Cindy
// 2026-08-03): (1) fail closed when the carrier has not hydrated, never a
// raw-id + literal-fallback fake; (2) the ACK's authoritative author replaces
// it wholesale so a locally-stale name/avatar cannot linger past commit.

const VIEWER: UserDto = {
  id: "u1",
  name: "norman",
  display_name: "Norman",
  avatar_url: "/api/users/u1/avatar?v=7",
  created_at: 0,
  updated_at: 0,
};

describe("optimisticSelfAuthor — Gate 1: complete from the hydrated viewer, else fail closed", () => {
  it("builds the active-user arm from the viewer carrier (never a snapshot / other status)", () => {
    expect(optimisticSelfAuthor(VIEWER)).toEqual({
      status: "active",
      kind: "user",
      id: "u1",
      name: "norman",
      display_name: "Norman",
      avatar_url: "/api/users/u1/avatar?v=7",
      runtime: null,
    });
  });

  it("carries a null avatar through verbatim rather than inventing one", () => {
    expect(optimisticSelfAuthor({ ...VIEWER, avatar_url: null })?.avatar_url).toBe(null);
  });

  it("fails closed to null when the viewer has not hydrated (no id+fallback fake)", () => {
    expect(optimisticSelfAuthor(null)).toBe(null);
  });
});

describe("replacePendingMessageInCache — Gate 2: the committed author replaces the optimistic one wholesale", () => {
  it("a locally-stale display name / avatar does not survive the ACK swap", () => {
    const tempId = "pending-1";
    // Optimistic row stamped with the viewer's at-send display/avatar.
    const stale = pending(tempId, userAuthor("Old Name", "/api/users/u1/avatar?v=1"));
    const cache = appendPendingMessage(undefined, stale);
    // The authoritative committed row carries the server's fresh author.
    const fresh = committed("m10", 10, userAuthor("New Name", "/api/users/u1/avatar?v=2"));

    const converged = replacePendingMessageInCache(cache, tempId, fresh);
    const row = (converged?.pages ?? []).flatMap((p) => p.messages).find((m) => m.id === "m10");

    expect(row?.author).toEqual(fresh.author);
    // The stale fields are gone, not merged — the whole author is replaced.
    expect(row?.author).not.toMatchObject({ display_name: "Old Name" });
    expect(ids(converged)).toEqual(["m10"]);
  });
});
