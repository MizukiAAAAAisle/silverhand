import { decodeTransportEpoch, decodeTransportSeq } from "@silverhand/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentStreamActivityEvent,
  AgentStreamActivityListResponse,
  ServerFrame,
} from "@silverhand/shared";
import { ApiError } from "@/lib/api";
import type { WsClientStatus } from "@/lib/ws-client";
import { createAgentStreamCache, upsertAgentStream } from "./agent-stream-cache";

const row = (
  id: number,
  payload: AgentStreamActivityEvent["payload"] = { text: String(id) },
  agentId = "a",
): AgentStreamActivityEvent => ({
  id,
  agent_id: agentId,
  kind: "thinking",
  payload,
  created_at: 100,
});
const page = (
  events: AgentStreamActivityEvent[],
  cursor: number | null = null,
): AgentStreamActivityListResponse => ({
  agent_id: "a",
  runtime_scope: "agent",
  events,
  next_before_id: cursor,
});
function harness() {
  const listeners = new Set<(f: ServerFrame) => void>();
  const statuses = new Set<(s: WsClientStatus) => void>();
  const reads: {
    agentId: string;
    before: number | null;
    signal: AbortSignal;
    resolve(v: AgentStreamActivityListResponse): void;
    reject(e: unknown): void;
  }[] = [];
  const release = vi.fn();
  const retain = vi.fn(() => ({ release }));
  const cache = createAgentStreamCache({
    retain,
    read: (agentId, before, signal) =>
      new Promise((resolve, reject) => reads.push({ agentId, before, signal, resolve, reject })),
    onFrame: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onStatus: (fn) => {
      statuses.add(fn);
      return () => {
        statuses.delete(fn);
      };
    },
  });
  const frame = (f: ServerFrame) => {
    for (const listener of [...listeners]) listener(f);
  };
  const ack = (agentId = "a", epoch = "e") =>
    frame({
      type: "subscribed",
      scope: `agent:${agentId}`,
      epoch: decodeTransportEpoch(epoch),
      seq: decodeTransportSeq(0),
    });
  let seq = 0;
  const event = (r: AgentStreamActivityEvent, epoch = "e", kind = "agent_stream_activity") =>
    frame({
      type: "event",
      scope: `agent:${r.agent_id}`,
      epoch: decodeTransportEpoch(epoch),
      seq: decodeTransportSeq(++seq),
      kind,
      payload: r,
    });
  return {
    cache,
    reads,
    retain,
    release,
    frame,
    ack,
    event,
    listeners,
    status: (s: WsClientStatus) => {
      for (const fn of statuses) fn(s);
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("agent-scoped shared activity", () => {
  it("shares three readers by user/agent, subscribes once and waits for ack before reading", async () => {
    const h = harness();
    const a = h.cache.get("u", "a");
    expect(h.cache.get("u", "a")).toBe(a);
    const stops = [a.subscribe(vi.fn()), a.subscribe(vi.fn()), a.subscribe(vi.fn())];
    expect(h.retain).toHaveBeenCalledTimes(1);
    expect(h.reads).toHaveLength(0);
    h.ack();
    expect(h.reads).toHaveLength(1);
    h.event(row(3));
    h.event(row(2, { text: "refined" }));
    h.reads[0]!.resolve(page([row(2, { text: "old" })]));
    await settle();
    expect(a.getSnapshot().events).toEqual([row(2, { text: "refined" }), row(3)]);
    stops[0]!();
    stops[1]!();
    expect(h.release).not.toHaveBeenCalled();
    stops[2]!();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
    a.subscribe(vi.fn());
    expect(h.reads).toHaveLength(1);
    h.ack();
    expect(h.reads).toHaveLength(2);
    h.cache.clear();
  });
  it("keeps user and agent identities separate and ignores diagnostic projection", async () => {
    const h = harness();
    const a = h.cache.get("u", "a"),
      b = h.cache.get("u", "b");
    expect(h.cache.get("other-user", "a")).not.toBe(a);
    a.subscribe(vi.fn());
    b.subscribe(vi.fn());
    h.ack();
    h.ack("b");
    h.reads[0]!.resolve(page([row(1)]));
    h.reads[1]!.resolve({ ...page([row(2, null, "b")]), agent_id: "b" });
    await settle();
    h.event(row(3), "e", "agent_event");
    h.event(row(4));
    expect(a.getSnapshot().events.map((r) => r.id)).toEqual([1, 4]);
    expect(b.getSnapshot().events.map((r) => r.id)).toEqual([2]);
    h.cache.clear();
  });
  it("applies live refinements after older HTTP pages and upserts duplicate ids in numeric order", async () => {
    const h = harness(),
      a = h.cache.get("u", "a");
    a.subscribe(vi.fn());
    h.ack();
    h.reads[0]!.resolve(page([row(10)], 10));
    await settle();
    const loading = a.loadEarlier();
    void a.loadEarlier();
    expect(h.reads).toHaveLength(2);
    expect(h.reads[1]!.before).toBe(10);
    h.event(row(2, { text: "short" }));
    h.event(row(11));
    h.event(row(11));
    h.reads[1]!.resolve(page([row(2, { text: "long stale text" }), row(3)]));
    await loading;
    expect(a.getSnapshot().events).toEqual([row(2, { text: "short" }), row(3), row(10), row(11)]);
    expect(upsertAgentStream([row(10), row(2)], [row(2, null)])).toEqual([row(2, null), row(10)]);
    h.cache.clear();
  });
  it("reloads the whole cache on gap and discards an obsolete in-flight page", async () => {
    const h = harness(),
      a = h.cache.get("u", "a");
    a.subscribe(vi.fn());
    h.ack();
    h.reads[0]!.resolve(page([row(10)], 10));
    await settle();
    void a.loadEarlier();
    h.frame({
      type: "snapshot_required",
      scope: "agent:a",
      epoch: decodeTransportEpoch("e"),
      currentSeq: decodeTransportSeq(0),
      reason: "gap_too_large",
    });
    expect(h.reads[1]!.signal.aborted).toBe(true);
    expect(a.getSnapshot().events).toEqual([]);
    expect(h.reads).toHaveLength(2);
    expect(h.retain).toHaveBeenCalledTimes(2);
    h.ack();
    h.reads[1]!.resolve(page([row(1)]));
    h.event(row(12));
    h.reads[2]!.resolve(page([row(11)]));
    await settle();
    expect(a.getSnapshot().events.map((r) => r.id)).toEqual([11, 12]);
    h.cache.clear();
  });
  it("waits for reconnect ack and reloads on epoch change", async () => {
    const h = harness(),
      a = h.cache.get("u", "a");
    a.subscribe(vi.fn());
    h.ack();
    h.reads[0]!.resolve(page([row(1)]));
    await settle();
    h.status("disconnected");
    h.status("connected");
    expect(h.reads).toHaveLength(1);
    h.ack("a", "next");
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve(page([row(5)]));
    await settle();
    expect(a.getSnapshot().events.map((r) => r.id)).toEqual([5]);
    h.event(row(7), "third");
    h.reads[2]!.resolve(page([row(6)]));
    await settle();
    expect(a.getSnapshot().events.map((r) => r.id)).toEqual([6, 7]);
    h.cache.clear();
  });
  it("clears and unsubscribes on denied HTTP, with no late page resurrection after logout", async () => {
    const h = harness(),
      a = h.cache.get("u", "a");
    a.subscribe(vi.fn());
    h.ack();
    h.reads[0]!.reject(new ApiError(404, "Not Found", "{}"));
    await settle();
    expect(a.getSnapshot()).toMatchObject({ events: [], phase: "error" });
    expect(h.release).toHaveBeenCalledTimes(1);
    h.cache.clear();
    const next = h.cache.get("v", "a");
    next.subscribe(vi.fn());
    h.ack();
    h.cache.clear();
    expect(h.reads[1]!.signal.aborted).toBe(true);
    h.reads[1]!.resolve(page([row(99)]));
    await settle();
    expect(next.getSnapshot().events).toEqual([]);
  });
  it("clears only the forbidden scope and requires explicit close/reopen to resubscribe", async () => {
    const h = harness(),
      a = h.cache.get("u", "a"),
      b = h.cache.get("u", "b");
    const close = a.subscribe(vi.fn());
    b.subscribe(vi.fn());
    h.ack();
    h.ack("b");
    h.reads[0]!.resolve(page([row(1)]));
    h.reads[1]!.resolve({ ...page([row(2, null, "b")]), agent_id: "b" });
    await settle();
    h.frame({ type: "error", code: "forbidden", scope: "agent:a", message: "not parsed" });
    expect(a.getSnapshot()).toMatchObject({ events: [], phase: "error" });
    expect(b.getSnapshot().events).toEqual([row(2, null, "b")]);
    expect(h.release).toHaveBeenCalledTimes(1);
    h.event(row(3));
    expect(a.getSnapshot().events).toEqual([]);
    close();
    a.subscribe(vi.fn());
    expect(h.retain).toHaveBeenCalledTimes(3);
    h.ack();
    h.reads[2]!.resolve(page([row(4)]));
    await settle();
    expect(a.getSnapshot().events).toEqual([row(4)]);
    h.cache.clear();
  });
  it("keeps older-page failure retryable without losing received live rows", async () => {
    const h = harness(),
      a = h.cache.get("u", "a");
    a.subscribe(vi.fn());
    h.ack();
    h.reads[0]!.resolve(page([row(10)], 10));
    await settle();
    const loading = a.loadEarlier();
    h.event(row(11));
    h.reads[1]!.reject(new Error("offline"));
    await loading;
    expect(a.getSnapshot()).toMatchObject({
      phase: "ready",
      isLoadingMore: false,
      nextBeforeId: 10,
    });
    expect(a.getSnapshot().events.map((r) => r.id)).toEqual([10, 11]);
    h.cache.clear();
  });
});
