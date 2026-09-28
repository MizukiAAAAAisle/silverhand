import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ConversationActivityEvent } from "@silverhand/shared";
import {
  agentActivityKey,
  appendAgentActivityToCache,
  mergeActivityById,
  type AgentActivityFeed,
} from "../hooks/use-agent-activity-feed";

// #task:1255 Stage-2 P1c #2 — the agent activity feed moves to a React Query
// cache the ingestor writes. P1 = prep: merge/dedupe behavior preserved; the new
// surface is the cache helpers (no-bootstrap append + per-agent key). Cindy's
// review gates: agentId-scoped key, no bootstrap with no reader, pagination
// older pages not lost/reordered on live append, read-inert (content only).

function feed(qc: QueryClient, cid: string, aid: string): AgentActivityFeed | undefined {
  return qc.getQueryData<AgentActivityFeed>(agentActivityKey(cid, aid));
}

function ids(qc: QueryClient, cid: string, aid: string): number[] {
  return (feed(qc, cid, aid)?.events ?? []).map((e) => e.id);
}

describe("appendAgentActivityToCache", () => {
  it("does NOT bootstrap the feed when none is loaded (no reader)", () => {
    const qc = new QueryClient();
    appendAgentActivityToCache(qc, "c1", "a1", row(5));
    expect(feed(qc, "c1", "a1")).toBeUndefined();
  });

  it("appends a live row at the tail of a loaded feed", () => {
    const qc = new QueryClient();
    qc.setQueryData<AgentActivityFeed>(agentActivityKey("c1", "a1"), {
      events: [row(3), row(4)],
      nextBeforeId: 2,
    });

    appendAgentActivityToCache(qc, "c1", "a1", row(5));

    expect(ids(qc, "c1", "a1")).toEqual([3, 4, 5]);
    // nextBeforeId (pagination cursor) is untouched by a live append.
    expect(feed(qc, "c1", "a1")?.nextBeforeId).toBe(2);
  });

  it("de-dupes a live row already present from backfill", () => {
    const qc = new QueryClient();
    qc.setQueryData<AgentActivityFeed>(agentActivityKey("c1", "a1"), {
      events: [row(3), row(4)],
      nextBeforeId: null,
    });

    appendAgentActivityToCache(qc, "c1", "a1", row(4));

    expect(ids(qc, "c1", "a1")).toEqual([3, 4]);
  });

  it("writes only the targeted agent feed (per-agentId key)", () => {
    const qc = new QueryClient();
    qc.setQueryData<AgentActivityFeed>(agentActivityKey("c1", "a1"), {
      events: [row(3)],
      nextBeforeId: null,
    });
    // a2 has no loaded feed — must stay absent, not bootstrap.
    appendAgentActivityToCache(qc, "c1", "a2", row(9));

    expect(ids(qc, "c1", "a1")).toEqual([3]);
    expect(feed(qc, "c1", "a2")).toBeUndefined();
  });
});

describe("mergeActivityById — pagination ordering (older pages not lost)", () => {
  it("prepended older page + live tail append stay ordered & deduped", () => {
    // tail page first…
    let merged = mergeActivityById([], [row(3), row(4)]);
    // …a live row appends…
    merged = mergeActivityById(merged, [row(5)]);
    // …then "Load earlier" prepends an older page (older-first arg).
    merged = mergeActivityById([row(1), row(2)], merged);

    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

function row(id: number): ConversationActivityEvent {
  return {
    id,
    conversation_id: "c1",
    agent_id: "a1",
    kind: "text",
    payload: { text: `m${id}` },
    created_at: id,
  };
}
