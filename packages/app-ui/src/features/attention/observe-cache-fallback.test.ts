import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObserveSource } from "@silverhand/shared";
import { favoritesKey } from "@/features/workspaces/favorites";
import { conversationUnreadKey, messageUnreadSummaryKey } from "@/features/channels/message-unread";
import {
  reconcileUnreadAfterObserveIfRealtimeUnavailable,
  settleStreamUnreadAfterObserve,
  shouldRefetchUnreadAfterObserve,
} from "./observe-cache-fallback";

const streamSource = (
  conversationId: string,
  threadRootId: string | null = null,
): ObserveSource => ({
  kind: "stream",
  conversation_id: conversationId,
  thread_root_id: threadRootId,
  position: { kind: "stream_head" },
});

const notificationSource = (notificationId: string): ObserveSource => ({
  kind: "notification",
  notification_id: notificationId,
});

describe("observe unread fallback while event WS is unavailable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("only refetches after a changed observe when event WS is not connected", () => {
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, "disconnected")).toBe(true);
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, "connecting")).toBe(true);
    expect(shouldRefetchUnreadAfterObserve({ changed: true }, "connected")).toBe(false);
    expect(shouldRefetchUnreadAfterObserve({ changed: false }, "disconnected")).toBe(false);
    expect(shouldRefetchUnreadAfterObserve(undefined, "disconnected")).toBe(false);
  });

  it("invalidates unread-bearing caches only on the fallback path", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    expect(
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, { changed: true }, "connected"),
    ).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    expect(
      reconcileUnreadAfterObserveIfRealtimeUnavailable(qc, { changed: true }, "disconnected"),
    ).toBe(true);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: favoritesKey });
    vi.runOnlyPendingTimers();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: messageUnreadSummaryKey });
    expect(
      invalidate.mock.calls.some(([arg]) => {
        return (
          typeof arg === "object" &&
          arg !== null &&
          typeof (arg as { predicate?: unknown }).predicate === "function"
        );
      }),
    ).toBe(true);
  });
});

// #task:1402 — the healthy-path seam that settles the per-stream conversationUnread
// read-model after a LOCAL observe(stream). This is the SINGLE chokepoint every
// observe(stream) caller funnels through (thread / mainline mark-read, Activity
// clear / mark-all-read), so its exact contract is unit-tested directly (the
// callers are source-fenced separately in realtime-ingestion-read-inert.test.ts).
describe("settleStreamUnreadAfterObserve (#task:1402)", () => {
  const keyOf = (arg: unknown): readonly unknown[] | undefined => {
    if (typeof arg === "object" && arg !== null && "queryKey" in arg) {
      return (arg as { queryKey?: readonly unknown[] }).queryKey;
    }
    return undefined;
  };

  it("does not invalidate when the observe changed nothing", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    settleStreamUnreadAfterObserve(qc, [streamSource("c1")], { changed: false });
    settleStreamUnreadAfterObserve(qc, [streamSource("c1")], undefined);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores notification sources (only stream sources settle conversationUnread)", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    settleStreamUnreadAfterObserve(qc, [notificationSource("n1")], { changed: true });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("de-dupes multiple stream sources for the same conversation to one invalidate", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    // mainline + a thread + a notification, all in c1 → exactly one settle for c1.
    settleStreamUnreadAfterObserve(
      qc,
      [streamSource("c1", null), streamSource("c1", "root-1"), notificationSource("n1")],
      { changed: true },
    );
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationUnreadKey("c1") });
  });

  it("settles each distinct conversation exactly once", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    settleStreamUnreadAfterObserve(
      qc,
      [streamSource("c1"), streamSource("c2", "root-2"), streamSource("c1", "root-9")],
      { changed: true },
    );
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationUnreadKey("c1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: conversationUnreadKey("c2") });
  });

  it("NEVER touches the global roll-up maps or favorites (#task:1284-safe)", () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    settleStreamUnreadAfterObserve(qc, [streamSource("c1"), streamSource("c2")], {
      changed: true,
    });
    for (const [arg] of invalidate.mock.calls) {
      const key = keyOf(arg);
      // Every settle is a per-stream conversationUnread key — three-segment
      // ['conversation', <id>, 'unread']. No global summary key, no favorites key,
      // and no predicate-based whole-list invalidate (the #1284 dogfood FAIL).
      expect(key?.[0]).toBe("conversation");
      expect(key?.[2]).toBe("unread");
      expect(key).not.toEqual(messageUnreadSummaryKey);
      expect(key).not.toEqual(favoritesKey);
      expect(typeof (arg as { predicate?: unknown }).predicate === "function").toBe(false);
    }
  });
});
