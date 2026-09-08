import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamActivityEvent, AgentStreamActivityListResponse } from "@silverhand/shared";
import { EventWsClient } from "@/lib/ws-client";
import { createInterestRegistry } from "@/features/realtime/interest-registry";
import { createAgentStreamCache } from "./agent-stream-cache";
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  getBackendInfo: vi.fn(async () => ({ url: "http://127.0.0.1:1234" })),
}));
class Socket {
  static OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  live = false;
  epoch = "e";
  pendingSubscribe = false;
  listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor() {
    socket = this;
  }
  addEventListener(kind: string, fn: (event: unknown) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), fn]);
  }
  send(raw: string) {
    const request = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(request);
    if (request.type === "subscribe") this.pendingSubscribe = true;
    if (request.type === "unsubscribe") {
      this.live = false;
      this.pendingSubscribe = false;
    }
  }
  acknowledge(epoch: string, seq: number) {
    expect(this.pendingSubscribe).toBe(true);
    this.pendingSubscribe = false;
    this.live = true;
    this.epoch = epoch;
    this.frame({ type: "subscribed", scope: "agent:a", epoch, seq });
  }
  snapshot(reason: "epoch_mismatch" | "gap_too_large") {
    this.live = false;
    if (reason === "epoch_mismatch") this.epoch = "next";
    this.frame({
      type: "snapshot_required",
      scope: "agent:a",
      epoch: this.epoch,
      currentSeq: 30,
      reason,
    });
  }
  publish(seq: number, payload: AgentStreamActivityEvent) {
    if (this.live)
      this.frame({
        type: "event",
        scope: "agent:a",
        epoch: this.epoch,
        seq,
        kind: "agent_stream_activity",
        payload,
      });
  }
  close() {
    this.readyState = 3;
  }
  frame(frame: unknown) {
    for (const fn of this.listeners.get("message") ?? []) fn({ data: JSON.stringify(frame) });
  }
}
let socket: Socket;
afterEach(() => vi.unstubAllGlobals());
const row = (id: number, text: string): AgentStreamActivityEvent => ({
  id,
  kind: "thinking",
  payload: { text },
  created_at: 0,
  agent_id: "a",
});
const page = (events: AgentStreamActivityEvent[]): AgentStreamActivityListResponse => ({
  agent_id: "a",
  runtime_scope: "agent",
  events,
  next_before_id: null,
});

describe("agent stream through event transport", () => {
  it.each(["epoch_mismatch", "gap_too_large"] as const)(
    "resubscribes after %s removes the server relay",
    async (reason) => {
      vi.stubGlobal("WebSocket", Socket);
      const client = new EventWsClient();
      const registry = createInterestRegistry((scope) => client.subscribe(scope));
      const pending: ((p: AgentStreamActivityListResponse) => void)[] = [];
      const cache = createAgentStreamCache({
        retain: (scope, holder) => registry.retain(scope, holder),
        onFrame: (fn) => client.onFrame(fn),
        onStatus: (fn) => client.onStatus(fn),
        read: () => new Promise((resolve) => pending.push(resolve)),
      });
      const entry = cache.get("u", "a");
      entry.subscribe(vi.fn());
      entry.subscribe(vi.fn());
      client.connect();
      await vi.waitFor(() => expect(socket).toBeDefined());
      socket.frame({ type: "authenticated", user_id: "u" });
      expect(socket.sent).toContainEqual({ type: "subscribe", scope: "agent:a" });
      socket.acknowledge("e", 0);
      pending[0]!(page([row(1, "old")]));
      await Promise.resolve();
      const event = (seq: number, text: string) => ({
        type: "event",
        scope: "agent:a",
        epoch: "e",
        seq,
        kind: "agent_stream_activity",
        payload: row(1, text),
      });
      socket.frame(event(1, "new"));
      socket.frame(event(1, "duplicate stale"));
      expect(entry.getSnapshot().events[0]?.payload).toEqual({ text: "new" });
      socket.frame(event(3, "future"));
      expect(socket.sent).toContainEqual({
        type: "resume",
        scopes: { "agent:a": { epoch: "e", lastSeq: 1 } },
      });
      socket.frame(event(2, "second"));
      socket.frame(event(3, "future"));
      expect(entry.getSnapshot().events[0]?.payload).toEqual({ text: "future" });
      socket.snapshot(reason);
      expect(entry.getSnapshot().events).toEqual([]);
      expect(socket.sent.filter((frame) => frame.type === "subscribe")).toHaveLength(2);
      expect(socket.sent.filter((frame) => frame.type === "resume")).toHaveLength(1);
      expect(pending).toHaveLength(1);
      socket.publish(31, row(9, "no relay yet"));
      expect(entry.getSnapshot().events).toEqual([]);
      socket.acknowledge(socket.epoch, 30);
      expect(pending).toHaveLength(2);
      socket.publish(31, row(9, "during cold read"));
      socket.publish(32, row(8, "refined during read"));
      pending[1]!(page([row(8, "stale page")]));
      await Promise.resolve();
      expect(entry.getSnapshot().events).toEqual([
        row(8, "refined during read"),
        row(9, "during cold read"),
      ]);
      socket.publish(33, row(10, "after cold read"));
      socket.publish(34, row(8, "refined after read"));
      expect(entry.getSnapshot().events).toEqual([
        row(8, "refined after read"),
        row(9, "during cold read"),
        row(10, "after cold read"),
      ]);
      expect(socket.sent.filter((frame) => frame.type === "subscribe")).toHaveLength(2);
      expect(pending).toHaveLength(2);
      cache.clear();
      client.disconnect();
    },
  );
});
