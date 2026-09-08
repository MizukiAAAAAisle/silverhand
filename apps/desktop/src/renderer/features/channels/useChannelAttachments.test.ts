import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  ALL_ATTACHMENTS_FILTER,
  attachmentAnchorId,
  attachmentFilterKey,
  attachmentsListQueryKey,
  attachmentsListSearchParams,
  channelAttachmentsKey,
  hasActiveChannelAttachmentsReader,
  isAttachmentFilterActive,
  type AttachmentListFilter,
} from "./useChannelAttachments";

/** Mount a live observer on a query key (mirrors the ingestor test's helper)
 *  so the reader-gate sees a real subscriber. Returns an unsubscribe fn. */
function mountReader(qc: QueryClient, queryKey: readonly unknown[]): () => void {
  const observer = new QueryObserver(qc, {
    queryKey,
    queryFn: () => new Promise<never>(() => {}),
    enabled: false,
  });
  return observer.subscribe(() => {});
}

describe("attachmentsListSearchParams — filter → discriminated wire", () => {
  it("unfiltered: only limit, no sender/time params", () => {
    const p = attachmentsListSearchParams(ALL_ATTACHMENTS_FILTER, {
      limit: 40,
      since: null,
    });
    expect(p.get("limit")).toBe("40");
    expect(p.has("sender_kind")).toBe(false);
    expect(p.has("sender_id")).toBe(false);
    expect(p.has("since")).toBe(false);
    expect(p.has("cursor")).toBe(false);
  });

  it("user sender → sender_kind=user + sender_id", () => {
    const p = attachmentsListSearchParams(
      { sender: { kind: "user", userId: "u1" }, time: "all" },
      { limit: 40, since: null },
    );
    expect(p.get("sender_kind")).toBe("user");
    expect(p.get("sender_id")).toBe("u1");
  });

  it("agent sender → sender_kind=agent + sender_id", () => {
    const p = attachmentsListSearchParams(
      { sender: { kind: "agent", agentId: "a1" }, time: "all" },
      { limit: 40, since: null },
    );
    expect(p.get("sender_kind")).toBe("agent");
    expect(p.get("sender_id")).toBe("a1");
  });

  it("system sender → sender_kind=system, NO sender_id (wire rejects one)", () => {
    const p = attachmentsListSearchParams(
      { sender: { kind: "system" }, time: "all" },
      { limit: 40, since: null },
    );
    expect(p.get("sender_kind")).toBe("system");
    expect(p.has("sender_id")).toBe(false);
  });

  it("frozen since → since lower bound; no until (open-ended recency)", () => {
    const p = attachmentsListSearchParams(
      { sender: null, time: "7d" },
      { limit: 40, since: 12345 },
    );
    expect(p.get("since")).toBe("12345");
    expect(p.has("until")).toBe(false);
  });

  it("since=null → no since bound", () => {
    const p = attachmentsListSearchParams(
      { sender: null, time: "all" },
      { limit: 40, since: null },
    );
    expect(p.has("since")).toBe(false);
  });

  it("does NOT read the clock — same (filter, since) always emits the same since", () => {
    // The frozen cutoff is an INPUT; every page of a session passes the same
    // value, so page 1 and page 2 request an identical window.
    const filter: AttachmentListFilter = { sender: null, time: "7d" };
    const page1 = attachmentsListSearchParams(filter, {
      limit: 40,
      since: 999,
      cursor: null,
    });
    const page2 = attachmentsListSearchParams(filter, {
      limit: 40,
      since: 999,
      cursor: "c2",
    });
    expect(page1.get("since")).toBe("999");
    expect(page2.get("since")).toBe("999");
  });

  it("cursor is passed through when present", () => {
    const p = attachmentsListSearchParams(ALL_ATTACHMENTS_FILTER, {
      limit: 40,
      since: null,
      cursor: "opaque-cursor",
    });
    expect(p.get("cursor")).toBe("opaque-cursor");
  });

  it("combines sender + frozen since on one request", () => {
    const p = attachmentsListSearchParams(
      { sender: { kind: "agent", agentId: "a1" }, time: "30d" },
      { limit: 40, since: 555 },
    );
    expect(p.get("sender_kind")).toBe("agent");
    expect(p.get("sender_id")).toBe("a1");
    expect(p.get("since")).toBe("555");
  });
});

describe("attachmentAnchorId — distinct session per channel / sender / preset", () => {
  it("same filter + channel → same anchor", () => {
    const f: AttachmentListFilter = {
      sender: { kind: "user", userId: "u1" },
      time: "7d",
    };
    expect(attachmentAnchorId("c1", f)).toBe(attachmentAnchorId("c1", f));
  });

  it("differs by channel, sender, and preset", () => {
    const base: AttachmentListFilter = { sender: null, time: "7d" };
    const ids = new Set([
      attachmentAnchorId("c1", base),
      attachmentAnchorId("c2", base),
      attachmentAnchorId("c1", { sender: { kind: "user", userId: "u1" }, time: "7d" }),
      attachmentAnchorId("c1", { sender: null, time: "30d" }),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe("attachmentsListQueryKey — full key carries the frozen cutoff", () => {
  const filter: AttachmentListFilter = { sender: null, time: "7d" };

  it("different resolved cutoffs → different full keys (same preset)", () => {
    const today = attachmentsListQueryKey("c1", filter, 1000);
    const tomorrow = attachmentsListQueryKey("c1", filter, 2000);
    // Same preset '7d' but a different frozen cutoff must NOT collide — each
    // is a distinct HTTP input.
    expect(JSON.stringify(today)).not.toBe(JSON.stringify(tomorrow));
  });

  it("is prefixed by the filter-agnostic base key (reader gate / invalidation span)", () => {
    const key = attachmentsListQueryKey("c1", filter, 1000);
    const base = channelAttachmentsKey("c1");
    expect(key.slice(0, base.length)).toEqual([...base]);
  });

  it("a mounted reader on the full key is seen by the channel-scoped gate", () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, attachmentsListQueryKey("c1", filter, 1000));
    expect(hasActiveChannelAttachmentsReader(qc, "c1")).toBe(true);
    expect(hasActiveChannelAttachmentsReader(qc, "c2")).toBe(false);
    unsub();
  });
});

describe("attachmentFilterKey — stable, distinct cache keys", () => {
  it("default filter → { s: null, t: all }", () => {
    expect(attachmentFilterKey(ALL_ATTACHMENTS_FILTER)).toEqual({
      s: null,
      t: "all",
    });
  });

  it("each sender kind + time preset yields a distinct key part", () => {
    const cases: AttachmentListFilter[] = [
      { sender: null, time: "all" },
      { sender: null, time: "7d" },
      { sender: { kind: "user", userId: "u1" }, time: "all" },
      { sender: { kind: "user", userId: "u2" }, time: "all" },
      { sender: { kind: "agent", agentId: "a1" }, time: "all" },
      { sender: { kind: "system" }, time: "all" },
      { sender: { kind: "system" }, time: "30d" },
    ];
    const keys = cases.map((f) => JSON.stringify(attachmentFilterKey(f)));
    expect(new Set(keys).size).toBe(cases.length);
  });

  it("the partial key carries only the PRESET; the resolved cutoff lives in the full key", () => {
    // This partial projection is preset-only and stable; the session's frozen
    // `since` is added by `attachmentsListQueryKey`, tested separately below.
    expect(attachmentFilterKey({ sender: null, time: "7d" })).toEqual(
      attachmentFilterKey({ sender: null, time: "7d" }),
    );
  });
});

describe("isAttachmentFilterActive", () => {
  it("false only for the unfiltered default", () => {
    expect(isAttachmentFilterActive(ALL_ATTACHMENTS_FILTER)).toBe(false);
  });
  it("true when a sender is set", () => {
    expect(isAttachmentFilterActive({ sender: { kind: "system" }, time: "all" })).toBe(true);
  });
  it("true when a time bound is set", () => {
    expect(isAttachmentFilterActive({ sender: null, time: "7d" })).toBe(true);
  });
});

describe("hasActiveChannelAttachmentsReader — PREFIX match over the filter family", () => {
  it("detects a reader whose live key carries a filter segment", () => {
    const qc = new QueryClient();
    // Production mounts at base + filter segment, NOT the bare base key.
    const filteredKey = [
      ...channelAttachmentsKey("c1"),
      attachmentFilterKey({ sender: { kind: "user", userId: "u1" }, time: "7d" }),
    ];
    const unsub = mountReader(qc, filteredKey);
    // An `exact` lookup on the base key would MISS this — the gate must
    // prefix-match, else realtime invalidation silently stops for any
    // filtered view.
    expect(hasActiveChannelAttachmentsReader(qc, "c1")).toBe(true);
    unsub();
  });

  it("detects a reader on the default (no-filter-segment shape too)", () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, [
      ...channelAttachmentsKey("c1"),
      attachmentFilterKey(ALL_ATTACHMENTS_FILTER),
    ]);
    expect(hasActiveChannelAttachmentsReader(qc, "c1")).toBe(true);
    unsub();
  });

  it("false when no reader is mounted (falsifier)", () => {
    const qc = new QueryClient();
    expect(hasActiveChannelAttachmentsReader(qc, "c1")).toBe(false);
  });

  it("false for a different channel (prefix is channel-scoped)", () => {
    const qc = new QueryClient();
    const unsub = mountReader(qc, [
      ...channelAttachmentsKey("c1"),
      attachmentFilterKey(ALL_ATTACHMENTS_FILTER),
    ]);
    expect(hasActiveChannelAttachmentsReader(qc, "c2")).toBe(false);
    unsub();
  });
});
